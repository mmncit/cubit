/** A 3D vector as a plain tuple, so it survives JSON unchanged. */
export type Vec3 = [number, number, number];

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * The unit vector a viewer is looking along. Yaw 0 and pitch 0 look down -Z,
 * yaw turns left (counter-clockwise seen from above), pitch looks up.
 */
export function viewDirection(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return [-Math.sin(yaw) * cosPitch, Math.sin(pitch), -Math.cos(yaw) * cosPitch];
}
