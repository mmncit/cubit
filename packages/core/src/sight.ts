import type { Vec3 } from "./math";
import { raycast } from "./raycast";
import type { ChunkStore } from "./world";

/**
 * Whether nothing but air lies between two points. Any block counts as cover,
 * including ones an entity can walk through, such as tall crops.
 */
export function lineOfSight(store: ChunkStore, from: Vec3, to: Vec3): boolean {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const distance = Math.hypot(d[0], d[1], d[2]);
  if (distance === 0) return true;
  const hit = raycast(store, from, d, distance);
  return !hit || hit.distance >= distance - 1e-6;
}

export interface SightOptions {
  /** How far the observer can see, in blocks. */
  range: number;
  /** Full horizontal field of view, in radians. */
  fov: number;
}

/**
 * Whether an observer at `eye`, facing `yaw` (core's convention: 0 is north,
 * -z), can see `target`: in range, inside the field of view horizontally, and
 * with a clear line of sight.
 */
export function canSee(store: ChunkStore, eye: Vec3, yaw: number, target: Vec3, options: SightOptions): boolean {
  const dx = target[0] - eye[0];
  const dz = target[2] - eye[2];
  const distance = Math.hypot(dx, target[1] - eye[1], dz);
  if (distance > options.range) return false;
  const flat = Math.hypot(dx, dz);
  if (flat > 1e-6) {
    const facingX = -Math.sin(yaw);
    const facingZ = -Math.cos(yaw);
    const cos = (dx * facingX + dz * facingZ) / flat;
    if (cos < Math.cos(options.fov / 2)) return false;
  }
  return lineOfSight(store, eye, target);
}
