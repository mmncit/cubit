import type { JsonValue } from "./json";
import type { Vec3 } from "./math";

export interface EntityInput {
  /** -1 to 1, positive is forward. */
  forward: number;
  /** -1 to 1, positive is right. */
  strafe: number;
  jump: boolean;
  /** Move at the run speed. Optional so snapshots from before it existed still load. */
  sprint?: boolean;
}

/**
 * Everything the engine knows about an entity. Plain data only: tuples, numbers,
 * strings and a JSON bag for game-specific fields, so an entity can be copied
 * into a snapshot or a network message as it is.
 */
export interface Entity {
  id: string;
  /** Game-defined type, for example "player". The engine does not interpret it. */
  kind: string;
  /** Centre of the feet. */
  position: Vec3;
  velocity: Vec3;
  /** Width, height and depth of the collision box. */
  size: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  /** "walker" moves under gravity from `input`; "none" is left alone. */
  controller: "walker" | "none";
  input: EntityInput;
  data: { [key: string]: JsonValue };
}

export type EntityInit = Partial<Omit<Entity, "id">> & { id: string };

export function createEntity(init: EntityInit): Entity {
  return {
    id: init.id,
    kind: init.kind ?? "entity",
    position: init.position ? [...init.position] : [0, 0, 0],
    velocity: init.velocity ? [...init.velocity] : [0, 0, 0],
    size: init.size ? [...init.size] : [0.6, 1.8, 0.6],
    yaw: init.yaw ?? 0,
    pitch: init.pitch ?? 0,
    onGround: init.onGround ?? false,
    controller: init.controller ?? "none",
    input: init.input ? { ...init.input } : { forward: 0, strafe: 0, jump: false, sprint: false },
    data: init.data ? { ...init.data } : {},
  };
}

/** Eye height as a fraction of the collision box height. */
export const EYE_HEIGHT_RATIO = 0.9;

export function eyePosition(entity: Entity): Vec3 {
  const [x, y, z] = entity.position;
  return [x, y + entity.size[1] * EYE_HEIGHT_RATIO, z];
}

/** Whether an entity's collision box overlaps the unit cube of a block. */
export function entityOverlapsBlock(entity: Entity, x: number, y: number, z: number): boolean {
  const [px, py, pz] = entity.position;
  const [w, h, d] = entity.size;
  return (
    px - w / 2 < x + 1 && px + w / 2 > x &&
    py < y + 1 && py + h > y &&
    pz - d / 2 < z + 1 && pz + d / 2 > z
  );
}
