import type { BlockRegistry } from "./blocks";
import { chunkKey, toChunk, toLocal, voxelIndex, type ChunkData, type ChunkKey } from "./chunk";
import { decodeChunkBase64 } from "./codec";
import type { Entity } from "./entity";
import type { Vec3 } from "./math";
import type { ServerMessage } from "./protocol";
import type { ChunkStore } from "./world";

/** What a message changed on the client, for the renderer to act on. */
export type ClientChange =
  | { type: "reset" }
  | { type: "chunk"; key: ChunkKey }
  | { type: "block"; position: Vec3 }
  | { type: "entities" }
  | { type: "rejected"; command: string; reason: string };

/**
 * A client's copy of the world, built only from server messages. The renderer
 * and raycasts read this, never the simulation, so the client already works the
 * way it will once the simulation is on another machine.
 */
export class ClientWorld implements ChunkStore {
  readonly chunks = new Map<ChunkKey, ChunkData>();
  readonly entities = new Map<string, Entity>();
  playerId: string | null = null;
  tick = 0;
  tickRate = 60;
  private readonly previous = new Map<string, Vec3>();

  constructor(private readonly registry: BlockRegistry) {}

  apply(message: ServerMessage): ClientChange[] {
    switch (message.type) {
      case "welcome":
        this.playerId = message.playerId;
        this.tick = message.tick;
        this.tickRate = message.tickRate;
        return [];
      case "reset":
        this.chunks.clear();
        this.entities.clear();
        this.previous.clear();
        return [{ type: "reset" }];
      case "chunk": {
        const [cx, cy, cz] = message.coords;
        const key = chunkKey(cx, cy, cz);
        this.chunks.set(key, decodeChunkBase64(message.data, message.coords, this.registry));
        return [{ type: "chunk", key }];
      }
      case "blockChanged": {
        const [x, y, z] = message.position;
        const chunk = this.chunks.get(chunkKey(toChunk(x), toChunk(y), toChunk(z)));
        if (!chunk) return [];
        const id = this.registry.tryId(message.block);
        if (id === undefined) return [];
        const lx = toLocal(x), ly = toLocal(y), lz = toLocal(z);
        chunk.blocks[voxelIndex(lx, ly, lz)] = id;
        return [{ type: "block", position: message.position }];
      }
      case "entities": {
        this.tick = message.tick;
        for (const entity of message.entities) {
          const known = this.entities.get(entity.id);
          this.previous.set(entity.id, known ? [...known.position] : [...entity.position]);
          this.entities.set(entity.id, entity);
        }
        return [{ type: "entities" }];
      }
      case "entityRemoved":
        this.entities.delete(message.id);
        this.previous.delete(message.id);
        return [{ type: "entities" }];
      case "rejected":
        return [{ type: "rejected", command: message.command, reason: message.reason }];
    }
  }

  player(): Entity | undefined {
    return this.playerId ? this.entities.get(this.playerId) : undefined;
  }

  /** Position between the last two ticks, for smooth rendering. `alpha` is 0 to 1. */
  interpolatedPosition(id: string, alpha: number): Vec3 | undefined {
    const entity = this.entities.get(id);
    if (!entity) return undefined;
    const from = this.previous.get(id) ?? entity.position;
    const to = entity.position;
    return [
      from[0] + (to[0] - from[0]) * alpha,
      from[1] + (to[1] - from[1]) * alpha,
      from[2] + (to[2] - from[2]) * alpha,
    ];
  }
}
