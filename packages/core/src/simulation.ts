import { AIR, type BlockRegistry } from "./blocks";
import { CHUNK_SIZE, chunkKey, toChunk, type ChunkKey } from "./chunk";
import type { Command, IssuedCommand } from "./commands";
import { createEntity, entityOverlapsBlock, eyePosition, type Entity, type EntityInit, type EntityInput } from "./entity";
import type { WorldGenerator } from "./generator";
import { clamp, type Vec3 } from "./math";
import { DEFAULT_PHYSICS, stepEntity, type PhysicsConfig, type WorldBounds } from "./physics";
import { err, flatMap, ok, type Result } from "./result";
import { pipe } from "./function";
import { createSnapshot, restoreSnapshot, type GameState, type Snapshot, type SnapshotOptions } from "./snapshot";
import type { JsonValue } from "./json";
import { getBlock, writeBlock } from "./world";

/** What a game system or action can do to the world during a tick. */
export interface SystemContext {
  sim: Simulation;
  dt: number;
  tick: number;
  /**
   * Places a block and reports it to clients, which writing to a chunk directly
   * would not. Refuses, returning false, if the chunk is not loaded, the block is
   * unknown, or a solid block would land inside an entity; try again next tick.
   */
  setBlock(position: Vec3, block: string): boolean;
  /**
   * The walkers that landed in the last tick's physics, by entity id, with how
   * fast they were falling in blocks per second. Not part of the state: a game
   * reads it to judge a hard landing, the tick after it happens.
   */
  landings: ReadonlyMap<string, number>;
}

/**
 * Game logic that runs every tick, after that tick's commands and before
 * physics, so what it decides (stopping a player, steering a patrol) is what
 * physics acts on. Must only touch simulation state, which is plain data.
 */
export type GameSystem = (ctx: SystemContext) => void;

export interface ActionContext extends SystemContext {
  actor: Entity;
  payload: JsonValue | undefined;
}

/** Handles an "act" command. Returns null to accept it, or a reason to reject it. */
export type GameAction = (ctx: ActionContext) => string | null;

/** A block a player's own `setBlock` command would change, after the simulation's own checks pass. */
export interface BlockEdit {
  actor: Entity;
  position: Vec3;
  /** Block names, before and after. */
  from: string;
  to: string;
}

/** A game's say over players' `setBlock` commands. Returns null to allow the edit, or a reason to refuse it. */
export type EditCheck = (edit: BlockEdit, sim: Simulation) => string | null;

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
  /** Game logic run every tick, in order. */
  systems?: GameSystem[];
  /** Handlers for "act" commands, by action name. */
  actions?: Record<string, GameAction>;
  /**
   * Checks every block a player asks to change with a `setBlock` command, after
   * the simulation's own checks. Without it every edit within reach is allowed.
   * A game whose world changes only through its own actions can refuse them all.
   * Systems and actions placing blocks through their context are not checked.
   */
  canEdit?: EditCheck;
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
  private landings: ReadonlyMap<string, number> = new Map();
  private readonly systems: GameSystem[];
  private readonly actions: Record<string, GameAction>;
  private readonly canEdit: EditCheck | undefined;
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
    this.systems = options.systems ?? [];
    this.actions = options.actions ?? {};
    this.canEdit = options.canEdit;
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
    const context = this.context(events);
    for (const system of this.systems) system(context);
    const landings = new Map<string, number>();
    for (const entity of this._state.entities.values()) {
      // Hold an entity still while the chunk it stands in streams in.
      // Unloaded chunks collide as solid, so moving it now would shove it out.
      const [x, y, z] = entity.position;
      const cy = toChunk(Math.floor(y));
      const inWorld = cy >= this.bounds.minChunkY && cy <= this.bounds.maxChunkY;
      if (inWorld && !this._state.chunks.has(chunkKey(toChunk(Math.floor(x)), cy, toChunk(Math.floor(z))))) continue;
      const landing = stepEntity(this._state, this.registry, this.bounds, entity, this.dt, this.physics);
      if (landing > 0) landings.set(entity.id, landing);
    }
    this.landings = landings;
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
        const parsed = parseInput(command);
        if (!parsed.ok) return parsed.error;
        entity.input = parsed.value.input;
        entity.yaw = parsed.value.yaw;
        entity.pitch = parsed.value.pitch;
        return null;
      }
      case "setBlock": {
        // A player's edit: the world's checks, then reach and the game's say, then room for the block.
        const planned = pipe(
          planEdit(this._state, this.registry, command.position, command.block),
          flatMap((edit): Result<Said, Edit> => {
            if (edit.unchanged) return ok(edit);
            if (outOfReach(entity, edit.at, this.reach)) return err({ said: "Too far away." });
            const refused = this.canEdit?.({ actor: entity, position: [...edit.at], from: this.registry.name(edit.from), to: command.block }, this);
            return refused ? err({ said: refused }) : ok(edit);
          }),
          flatMap((edit) => clearOf(this._state, this.registry, edit)),
        );
        if (!planned.ok) return refusalText(planned.error, command.block);
        commit(this._state, planned.value, events);
        return null;
      }
      case "act": {
        if (typeof command.action !== "string") return "An action needs a name.";
        const handler = Object.hasOwn(this.actions, command.action) ? this.actions[command.action] : undefined;
        if (!handler) return `Unknown action "${command.action}".`;
        return handler({ ...this.context(events), actor: entity, payload: command.payload });
      }
      default: {
        const unknown: never = command;
        return `Unknown command "${(unknown as { type: string }).type}".`;
      }
    }
  }

  private context(events: SimEvent[]): SystemContext {
    return {
      sim: this,
      dt: this.dt,
      tick: this._state.tick,
      landings: this.landings,
      // A system's edit: the world's checks and room for the block, but no reach and no game to ask.
      setBlock: (position, block) => {
        const planned = pipe(planEdit(this._state, this.registry, position, block), flatMap((edit) => clearOf(this._state, this.registry, edit)));
        if (!planned.ok) return false;
        commit(this._state, planned.value, events);
        return true;
      },
    };
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

// ---- block edits, as pure checks and one place that writes ------------------------------

/** Why an edit was refused by the world's own checks. */
type EditRefusal = "position" | "block" | "unloaded" | "occupied";
/** A refusal already in words: out of reach, or a game's own reason, passed on as it is. */
interface Said {
  readonly said: string;
}

/** An edit that passed the checks so far: the cell, and the block ids before and after. */
interface Edit {
  readonly at: Vec3;
  readonly from: number;
  readonly to: number;
  /** The block is already there: nothing to write and nothing to report. */
  readonly unchanged: boolean;
}

/** The world's own checks on any edit: a whole-numbered cell, a known block, loaded ground. */
function planEdit(state: GameState, registry: BlockRegistry, position: unknown, block: string): Result<EditRefusal, Edit> {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isInteger)) return err("position");
  const at: Vec3 = [position[0], position[1], position[2]];
  const to = registry.tryId(block);
  if (to === undefined) return err("block");
  const from = getBlock(state, at[0], at[1], at[2]);
  if (from === undefined) return err("unloaded");
  return ok({ at, from, to, unchanged: from === to });
}

/** Refuses a solid block where any entity stands. Leaving a block as it is never needs room. */
function clearOf(state: GameState, registry: BlockRegistry, edit: Edit): Result<EditRefusal, Edit> {
  if (edit.unchanged || edit.to === AIR || !registry.isSolid(edit.to)) return ok(edit);
  for (const other of state.entities.values()) if (entityOverlapsBlock(other, edit.at[0], edit.at[1], edit.at[2])) return err("occupied");
  return ok(edit);
}

/** Whether a cell lies beyond an entity's reach, measured from its eyes to the cell's middle. */
function outOfReach(entity: Entity, at: Vec3, reach: number): boolean {
  const eye = eyePosition(entity);
  return Math.hypot(at[0] + 0.5 - eye[0], at[1] + 0.5 - eye[1], at[2] + 0.5 - eye[2]) > reach + 1;
}

/** A refusal in the words a player is shown. */
function refusalText(reason: EditRefusal | Said, block: string): string {
  if (typeof reason !== "string") return reason.said;
  switch (reason) {
    case "position":
      return "Block position must be three integers.";
    case "block":
      return `Unknown block "${block}".`;
    case "unloaded":
      return "That part of the world is not loaded.";
    case "occupied":
      return "Something is in the way.";
  }
}

/** Writes an edit and reports it: the one place a block change happens. */
function commit(state: GameState, edit: Edit, events: SimEvent[]): void {
  if (edit.unchanged) return;
  writeBlock(state, edit.at[0], edit.at[1], edit.at[2], edit.to);
  events.push({ type: "blockChanged", position: [...edit.at], from: edit.from, to: edit.to });
}

/** An input command as the entity's new input and view, or why it cannot be. */
function parseInput(command: Extract<Command, { type: "input" }>): Result<string, { input: EntityInput; yaw: number; pitch: number }> {
  const { forward, strafe, yaw, pitch } = command;
  if (![forward, strafe, yaw, pitch].every(Number.isFinite)) return err("Input values must be finite numbers.");
  return ok({
    input: { forward: clamp(forward, -1, 1), strafe: clamp(strafe, -1, 1), jump: command.jump === true, sprint: command.sprint === true },
    yaw,
    pitch: clamp(pitch, -Math.PI / 2, Math.PI / 2),
  });
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
