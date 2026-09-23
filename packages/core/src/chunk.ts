import type { Vec3 } from "./math";

export const CHUNK_SIZE = 16;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

export type ChunkKey = string;

/**
 * A cubic 16x16x16 region of blocks. `blocks` holds registry ids, which are
 * process-local: use the codec to serialize a chunk, never JSON.stringify.
 */
export interface ChunkData {
  coords: Vec3;
  blocks: Uint16Array;
  /** Changed since generation. Only modified chunks need saving. */
  modified: boolean;
}

export function chunkKey(cx: number, cy: number, cz: number): ChunkKey {
  return `${cx},${cy},${cz}`;
}

export function parseChunkKey(key: ChunkKey): Vec3 {
  const parts = key.split(",").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`"${key}" is not a chunk key.`);
  }
  return parts as Vec3;
}

export function createChunk(cx: number, cy: number, cz: number): ChunkData {
  return { coords: [cx, cy, cz], blocks: new Uint16Array(CHUNK_VOLUME), modified: false };
}

/** Index of a local coordinate (0..15 on each axis) inside `blocks`. */
export function voxelIndex(lx: number, ly: number, lz: number): number {
  return lx + lz * CHUNK_SIZE + ly * CHUNK_SIZE * CHUNK_SIZE;
}

/** The chunk coordinate containing a world block coordinate. */
export function toChunk(n: number): number {
  return Math.floor(n / CHUNK_SIZE);
}

/** The local coordinate (0..15) of a world block coordinate within its chunk. */
export function toLocal(n: number): number {
  const m = n % CHUNK_SIZE;
  return m < 0 ? m + CHUNK_SIZE : m;
}
