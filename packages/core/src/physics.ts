import type { BlockRegistry } from "./blocks";
import { toChunk } from "./chunk";
import type { Entity } from "./entity";
import { getBlock, type ChunkStore } from "./world";

export interface PhysicsConfig {
  /** Downward acceleration in blocks per second squared. */
  gravity: number;
  jumpSpeed: number;
  walkSpeed: number;
  /** How quickly horizontal velocity reaches the target, per second, on the ground. */
  acceleration: number;
  /** The same, in the air. */
  airAcceleration: number;
  terminalVelocity: number;
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravity: 28,
  jumpSpeed: 8.5,
  walkSpeed: 4.8,
  acceleration: 14,
  airAcceleration: 3,
  terminalVelocity: 50,
};

/** The vertical extent of the world, in chunk coordinates, inclusive. */
export interface WorldBounds {
  minChunkY: number;
  maxChunkY: number;
}

/**
 * Whether a block counts as solid for collision. A chunk inside the world's
 * bounds that has not loaded yet is solid, so nothing falls through it while it
 * streams in. Below the world is solid and above it is open air.
 */
export function isSolidAt(
  store: ChunkStore,
  registry: BlockRegistry,
  bounds: WorldBounds,
  x: number,
  y: number,
  z: number,
): boolean {
  const cy = toChunk(y);
  if (cy < bounds.minChunkY) return true;
  if (cy > bounds.maxChunkY) return false;
  const id = getBlock(store, x, y, z);
  if (id === undefined) return true;
  return registry.isSolid(id);
}

const SKIN = 1e-4;
const MAX_SUBSTEP = 0.45;

/** Advances one entity by `dt` seconds: controller, gravity, then collision. */
export function stepEntity(
  store: ChunkStore,
  registry: BlockRegistry,
  bounds: WorldBounds,
  entity: Entity,
  dt: number,
  config: PhysicsConfig = DEFAULT_PHYSICS,
): void {
  if (entity.controller !== "walker") return;
  const v = entity.velocity;

  const { forward, strafe, jump } = entity.input;
  const sin = Math.sin(entity.yaw);
  const cos = Math.cos(entity.yaw);
  let wishX = -sin * forward + cos * strafe;
  let wishZ = -cos * forward - sin * strafe;
  const length = Math.hypot(wishX, wishZ);
  if (length > 1) {
    wishX /= length;
    wishZ /= length;
  }
  const rate = entity.onGround ? config.acceleration : config.airAcceleration;
  const blend = Math.min(1, rate * dt);
  v[0] += (wishX * config.walkSpeed - v[0]) * blend;
  v[2] += (wishZ * config.walkSpeed - v[2]) * blend;

  if (jump && entity.onGround) {
    v[1] = config.jumpSpeed;
    entity.onGround = false;
  }
  v[1] = Math.max(v[1] - config.gravity * dt, -config.terminalVelocity);

  // Resolve y first so a player standing on the ground does not snag on the
  // edges of the blocks under them while walking.
  const hitY = moveAxis(store, registry, bounds, entity, 1, v[1] * dt);
  if (hitY) {
    entity.onGround = v[1] < 0;
    v[1] = 0;
  } else {
    entity.onGround = false;
  }
  if (moveAxis(store, registry, bounds, entity, 0, v[0] * dt)) v[0] = 0;
  if (moveAxis(store, registry, bounds, entity, 2, v[2] * dt)) v[2] = 0;
}

function moveAxis(
  store: ChunkStore,
  registry: BlockRegistry,
  bounds: WorldBounds,
  entity: Entity,
  axis: 0 | 1 | 2,
  amount: number,
): boolean {
  if (amount === 0) return false;
  const steps = Math.ceil(Math.abs(amount) / MAX_SUBSTEP);
  const step = amount / steps;
  for (let i = 0; i < steps; i++) {
    if (moveAxisOnce(store, registry, bounds, entity, axis, step)) return true;
  }
  return false;
}

function moveAxisOnce(
  store: ChunkStore,
  registry: BlockRegistry,
  bounds: WorldBounds,
  entity: Entity,
  axis: 0 | 1 | 2,
  amount: number,
): boolean {
  const p = entity.position;
  p[axis] += amount;

  const [w, h, d] = entity.size;
  const min = [p[0] - w / 2, p[1], p[2] - d / 2];
  const max = [p[0] + w / 2, p[1] + h, p[2] + d / 2];
  const x0 = Math.floor(min[0]!), x1 = Math.floor(max[0]! - 1e-9);
  const y0 = Math.floor(min[1]!), y1 = Math.floor(max[1]! - 1e-9);
  const z0 = Math.floor(min[2]!), z1 = Math.floor(max[2]! - 1e-9);

  let hit = false;
  let nearest = amount > 0 ? Infinity : -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (!isSolidAt(store, registry, bounds, x, y, z)) continue;
        hit = true;
        const c = axis === 0 ? x : axis === 1 ? y : z;
        nearest = amount > 0 ? Math.min(nearest, c) : Math.max(nearest, c);
      }
    }
  }
  if (!hit) return false;

  // Push back out to the face of the nearest blocking voxel on this axis.
  const lowExtent = axis === 1 ? 0 : axis === 0 ? w / 2 : d / 2;
  const highExtent = axis === 1 ? h : axis === 0 ? w / 2 : d / 2;
  p[axis] = amount > 0 ? nearest - highExtent - SKIN : nearest + 1 + lowExtent + SKIN;
  return true;
}
