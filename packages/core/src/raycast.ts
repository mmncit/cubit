import { AIR } from "./blocks";
import type { Vec3 } from "./math";
import { getBlock, type ChunkStore } from "./world";

export interface RayHit {
  /** The block that was hit. */
  position: Vec3;
  /** Outward normal of the face that was hit. The block in front of it is position + normal. */
  normal: Vec3;
  block: number;
  distance: number;
}

/**
 * Walks the voxel grid along a ray and returns the first non-air block within
 * `maxDistance`. Stops at unloaded chunks. Pure, so a server can use it to
 * check what a player could actually reach.
 */
export function raycast(store: ChunkStore, origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length === 0) return null;
  const dir: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];

  const cell: Vec3 = [Math.floor(origin[0]), Math.floor(origin[1]), Math.floor(origin[2])];
  const step: Vec3 = [0, 0, 0];
  const tMax: Vec3 = [Infinity, Infinity, Infinity];
  const tDelta: Vec3 = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    const d = dir[a]!;
    if (d > 0) {
      step[a] = 1;
      tDelta[a] = 1 / d;
      tMax[a] = (cell[a]! + 1 - origin[a]!) / d;
    } else if (d < 0) {
      step[a] = -1;
      tDelta[a] = -1 / d;
      tMax[a] = (origin[a]! - cell[a]!) / -d;
    }
  }

  const normal: Vec3 = [0, 0, 0];
  let t = 0;
  while (t <= maxDistance) {
    const id = getBlock(store, cell[0], cell[1], cell[2]);
    if (id === undefined) return null;
    if (id !== AIR) {
      return { position: [cell[0], cell[1], cell[2]], normal: [normal[0], normal[1], normal[2]], block: id, distance: t };
    }
    const axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    t = tMax[axis];
    tMax[axis] += tDelta[axis];
    cell[axis] += step[axis];
    normal[0] = normal[1] = normal[2] = 0;
    normal[axis] = -step[axis];
  }
  return null;
}
