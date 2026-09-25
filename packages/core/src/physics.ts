import type { BlockRegistry } from "./blocks";
import { toChunk } from "./chunk";
import type { Entity } from "./entity";
import { getBlock, type ChunkStore } from "./world";

export interface PhysicsConfig {
  /** Downward acceleration in blocks per second squared. */
  gravity: number;
  jumpSpeed: number;
  walkSpeed: number;
  /** Speed multiplier while `input.sprint` is held. */
  sprintMultiplier: number;
  /** How quickly horizontal velocity reaches the target, per second, on the ground. */
  acceleration: number;
  /** The same, in the air. */
  airAcceleration: number;
  terminalVelocity: number;
  /**
   * How high a walker climbs without jumping when it walks into a ledge, in
   * blocks. 0 means every step needs a jump; 1 walks up one-block stairs.
   */
  stepHeight: number;
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravity: 28,
  jumpSpeed: 8.5,
  walkSpeed: 4.8,
  sprintMultiplier: 1.6,
  acceleration: 14,
  airAcceleration: 3,
  terminalVelocity: 50,
  stepHeight: 0,
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

/**
 * Advances one entity by `dt` seconds: controller, gravity, then collision.
 * Returns how fast it was falling if it landed this step, in blocks per second,
 * and 0 otherwise, so a game can judge a hard landing.
 */
export function stepEntity(
  store: ChunkStore,
  registry: BlockRegistry,
  bounds: WorldBounds,
  entity: Entity,
  dt: number,
  config: PhysicsConfig = DEFAULT_PHYSICS,
): number {
  if (entity.controller !== "walker") return 0;
  const v = entity.velocity;

  const { forward, strafe, jump, sprint } = entity.input;
  const speed = config.walkSpeed * (sprint ? config.sprintMultiplier : 1);
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
  v[0] += (wishX * speed - v[0]) * blend;
  v[2] += (wishZ * speed - v[2]) * blend;

  if (jump && entity.onGround) {
    v[1] = config.jumpSpeed;
    entity.onGround = false;
  }
  v[1] = Math.max(v[1] - config.gravity * dt, -config.terminalVelocity);

  // Resolve y first so a player standing on the ground does not snag on the
  // edges of the blocks under them while walking.
  const hitY = moveAxis(store, registry, bounds, entity, 1, v[1] * dt);
  let landing = 0;
  if (hitY) {
    if (v[1] < 0 && !entity.onGround) landing = -v[1];
    entity.onGround = v[1] < 0;
    v[1] = 0;
  } else {
    entity.onGround = false;
  }
  if (moveHorizontal(store, registry, bounds, entity, 0, v[0] * dt, config.stepHeight)) v[0] = 0;
  if (moveHorizontal(store, registry, bounds, entity, 2, v[2] * dt, config.stepHeight)) v[2] = 0;
  return landing;
}

/**
 * Moves along x or z. If a walker on the ground is blocked, tries again lifted
 * by up to `stepHeight`, and settles onto the step if that works. Returns true
 * if the entity was blocked.
 */
function moveHorizontal(
  store: ChunkStore,
  registry: BlockRegistry,
  bounds: WorldBounds,
  entity: Entity,
  axis: 0 | 2,
  amount: number,
  stepHeight: number,
): boolean {
  const p = entity.position;
  const before: [number, number, number] = [p[0], p[1], p[2]];
  if (!moveAxis(store, registry, bounds, entity, axis, amount)) return false;
  if (stepHeight <= 0 || !entity.onGround) return true;

  const blocked: [number, number, number] = [p[0], p[1], p[2]];
  const restore = (to: [number, number, number]) => {
    p[0] = to[0];
    p[1] = to[1];
    p[2] = to[2];
  };
  restore(before);
  if (moveAxis(store, registry, bounds, entity, 1, stepHeight) || moveAxis(store, registry, bounds, entity, axis, amount)) {
    restore(blocked);
    return true;
  }
  // Drop back down onto the top of the step.
  moveAxis(store, registry, bounds, entity, 1, -stepHeight - 2 * SKIN);
  return false;
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
