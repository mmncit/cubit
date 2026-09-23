import { chunkKey, toChunk, toLocal, voxelIndex, type ChunkData, type ChunkKey } from "./chunk";

/** Anything that holds chunks: the authoritative simulation or a client replica. */
export interface ChunkStore {
  readonly chunks: Map<ChunkKey, ChunkData>;
}

export function getChunk(store: ChunkStore, cx: number, cy: number, cz: number): ChunkData | undefined {
  return store.chunks.get(chunkKey(cx, cy, cz));
}

/** The block id at a world block coordinate, or undefined if its chunk is not loaded. */
export function getBlock(store: ChunkStore, x: number, y: number, z: number): number | undefined {
  const chunk = store.chunks.get(chunkKey(toChunk(x), toChunk(y), toChunk(z)));
  if (!chunk) return undefined;
  return chunk.blocks[voxelIndex(toLocal(x), toLocal(y), toLocal(z))];
}

/**
 * Writes a block without validation or events. Returns false if the chunk is
 * not loaded. Game code should go through a command instead.
 */
export function writeBlock(store: ChunkStore, x: number, y: number, z: number, id: number): boolean {
  const chunk = store.chunks.get(chunkKey(toChunk(x), toChunk(y), toChunk(z)));
  if (!chunk) return false;
  chunk.blocks[voxelIndex(toLocal(x), toLocal(y), toLocal(z))] = id;
  chunk.modified = true;
  return true;
}
