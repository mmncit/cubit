import { AIR, type BlockRegistry } from "./blocks";
import { CHUNK_SIZE, chunkKey, toChunk, type ChunkKey } from "./chunk";
import type { Command, IssuedCommand } from "./commands";
import { createEntity, entityOverlapsBlock, eyePosition, type Entity, type EntityInit } from "./entity";
import type { WorldGenerator } from "./generator";
import { clamp, type Vec3 } from "./math";
import { DEFAULT_PHYSICS, stepEntity, type PhysicsConfig, type WorldBounds } from "./physics";
import { createSnapshot, restoreSnapshot, type GameState, type Snapshot, type SnapshotOptions } from "./snapshot";
import { getBlock, writeBlock } from "./world";

export interface SimulationOptions {
  registry: BlockRegistry;
  generator: WorldGenerator;
  seed: number;
  /** Simulation steps per second. */
  tickRate?: number;
  physics?: Partial<PhysicsConfig>;
  /** Chunks are kept loaded within this many chunks (horizontally) of every walker. */
  loadRadius?: number;
  /** Most chunks generated per tick, so streaming never stalls a frame. */
  loadBudget?: number;
  /** How far from their eyes an entity may place or remove a block. */
  reach?: number;
}

/** What happened during a tick. Ids are registry-local; the host turns them into names. */
export type SimEvent =
  | { type: "chunkLoaded"; key: ChunkKey }
  | { type: "blockChanged"; position: Vec3; from: number; to: number }
  | { type: "entityAdded"; id: string }
  | { type: "entityRemoved"; id: string }
  | { type: "rejected"; actor: string; command: Command["type"]; reason: string };

/**
 * The authoritative game. It owns the state, applies commands in order at a
 * fixed tick, and reports what changed. It has no idea whether its players are
 * in the same tab or on the other side of a network.
 */
export class Simulation {
  readonly registry: BlockRegistry;
  readonly generator: WorldGenerator;
  readonly tickRate: number;
  readonly physics: PhysicsConfig;
  readonly bounds: WorldBounds;
  readonly loadRadius: number;
  readonly loadBudget: number;
  readonly reach: number;
  private _state: GameState;
  private queue: IssuedCommand[] = [];
  private pending: SimEvent[] = [];

  constructor(options: SimulationOptions) {
    this.registry = options.registry;
    this.generator = options.generator;
    this.tickRate = options.tickRate ?? 60;
    this.physics = { ...DEFAULT_PHYSICS, ...options.physics };
    const [minChunkY, maxChunkY] = options.generator.verticalRange;
    this.bounds = { minChunkY, maxChunkY };
    this.loadRadius = options.loadRadius ?? 4;
    this.loadBudget = options.loadBudget ?? 8;
    this.reach = options.reach ?? 6;
    this._state = { tick: 0, seed: options.seed >>> 0, chunks: new Map(), entities: new Map() };
  }

  get state(): Readonly<GameState> {
    return this._state;
  }

  get dt(): number {
    return 1 / this.tickRate;
  }

  enqueue(actor: string, command: Command): void {
    this.queue.push({ actor, command });
  }

  addEntity(init: EntityInit): Entity {
    if (this._state.entities.has(init.id)) throw new Error(`Entity "${init.id}" already exists.`);
    const entity = createEntity(init);
    this._state.entities.set(entity.id, entity);
    this.pending.push({ type: "entityAdded", id: entity.id });
    return entity;
  }

  removeEntity(id: string): void {
    if (this._state.entities.delete(id)) this.pending.push({ type: "entityRemoved", id });
  }

  /** Runs one tick and returns everything that changed during it. */
  step(): SimEvent[] {
    const events = this.pending;
    this.pending = [];
    const queue = this.queue;
    this.queue = [];
    for (const issued of queue) {
      const reason = this.apply(issued, events);
      if (reason) events.push({ type: "rejected", actor: issued.actor, command: issued.command.type, reason });
    }
    for (const entity of this._state.entities.values()) {
      // Hold an entity still while the chunk it stands in streams in.
      // Unloaded chunks collide as solid, so moving it now would shove it out.
      const [x, y, z] = entity.position;
      const cy = toChunk(Math.floor(y));
      const inWorld = cy >= this.bounds.minChunkY && cy <= this.bounds.maxChunkY;
      if (inWorld && !this._state.chunks.has(chunkKey(toChunk(Math.floor(x)), cy, toChunk(Math.floor(z))))) continue;
      stepEntity(this._state, this.registry, this.bounds, entity, this.dt, this.physics);
    }
    this.streamChunks(events, this.loadBudget);
    this._state.tick++;
    return events;
  }

  /** Generates every chunk within `radius` chunks of a world position, ignoring the budget. */
  preload(position: Vec3, radius = this.loadRadius): SimEvent[] {
    const events: SimEvent[] = [];
    const cx = toChunk(Math.floor(position[0]));
    const cz = toChunk(Math.floor(position[2]));
    for (const [x, z] of ringOrder(radius)) {
      for (let cy = this.bounds.minChunkY; cy <= this.bounds.maxChunkY; cy++) {
        this.loadChunk(cx + x, cy, cz + z, events);
      }
    }
    this.pending.push(...events);
    return events;
  }

  /** The y coordinate just above the highest solid block in a loaded column, or null. */
  findSurfaceY(x: number, z: number): number | null {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const top = (this.bounds.maxChunkY + 1) * CHUNK_SIZE - 1;
    const bottom = this.bounds.minChunkY * CHUNK_SIZE;
    for (let y = top; y >= bottom; y--) {
      const id = getBlock(this._state, bx, y, bz);
      if (id !== undefined && this.registry.isSolid(id)) return y + 1;
    }
    return null;
  }

  snapshot(options?: SnapshotOptions): Snapshot {
    return createSnapshot(this._state, this.registry, options);
  }

  /** Replaces the whole state. Chunks the snapshot did not store regenerate from its seed. */
  load(snapshot: Snapshot): void {
    this._state = restoreSnapshot(snapshot, this.registry);
    this.queue = [];
    this.pending = [];
    for (const entity of this._state.entities.values()) {
      if (entity.controller === "walker") this.preload(entity.position, 1);
    }
  }

  private apply({ actor, command }: IssuedCommand, events: SimEvent[]): string | null {
    const entity = this._state.entities.get(actor);
    if (!entity) return "No such entity.";

    switch (command.type) {
      case "input": {
        const { forward, strafe, yaw, pitch } = command;
        if (![forward, strafe, yaw, pitch].every(Number.isFinite)) return "Input values must be finite numbers.";
        entity.input = { forward: clamp(forward, -1, 1), strafe: clamp(strafe, -1, 1), jump: command.jump === true };
        entity.yaw = yaw;
        entity.pitch = clamp(pitch, -Math.PI / 2, Math.PI / 2);
        return null;
      }
      case "setBlock": {
        const p = command.position;
        if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isInteger)) return "Block position must be three integers.";
        const to = this.registry.tryId(command.block);
        if (to === undefined) return `Unknown block "${command.block}".`;
        const from = getBlock(this._state, p[0], p[1], p[2]);
        if (from === undefined) return "That part of the world is not loaded.";
        if (from === to) return null;
        const eye = eyePosition(entity);
        const distance = Math.hypot(p[0] + 0.5 - eye[0], p[1] + 0.5 - eye[1], p[2] + 0.5 - eye[2]);
        if (distance > this.reach + 1) return "Too far away.";
        if (to !== AIR && this.registry.isSolid(to)) {
          for (const other of this._state.entities.values()) {
            if (entityOverlapsBlock(other, p[0], p[1], p[2])) return "Something is in the way.";
          }
        }
        writeBlock(this._state, p[0], p[1], p[2], to);
        events.push({ type: "blockChanged", position: [p[0], p[1], p[2]], from, to });
        return null;
      }
      default: {
        const unknown: never = command;
        return `Unknown command "${(unknown as { type: string }).type}".`;
      }
    }
  }

  private streamChunks(events: SimEvent[], budget: number): void {
    let remaining = budget;
    for (const entity of this._state.entities.values()) {
      if (entity.controller !== "walker") continue;
      const cx = toChunk(Math.floor(entity.position[0]));
      const cz = toChunk(Math.floor(entity.position[2]));
      for (const [x, z] of ringOrder(this.loadRadius)) {
        for (let cy = this.bounds.minChunkY; cy <= this.bounds.maxChunkY; cy++) {
          if (remaining <= 0) return;
          if (this.loadChunk(cx + x, cy, cz + z, events)) remaining--;
        }
      }
    }
  }

  private loadChunk(cx: number, cy: number, cz: number, events: SimEvent[]): boolean {
    const key = chunkKey(cx, cy, cz);
    if (this._state.chunks.has(key)) return false;
    const chunk = this.generator.generate([cx, cy, cz], this.registry, this._state.seed);
    chunk.modified = false;
    this._state.chunks.set(key, chunk);
    events.push({ type: "chunkLoaded", key });
    return true;
  }
}

const ringCache = new Map<number, [number, number][]>();

/** Chunk offsets within a square radius, nearest first, in a stable order. */
function ringOrder(radius: number): [number, number][] {
  let ring = ringCache.get(radius);
  if (!ring) {
    ring = [];
    for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++) ring.push([x, z]);
    ring.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
    ringCache.set(radius, ring);
  }
  return ring;
}
