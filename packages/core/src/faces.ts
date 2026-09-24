/**
 * Cube faces and colour helpers shared by the chunk and model meshers. Internal:
 * not exported from the package.
 */
import type { Vec3 } from "./math";
import type { ChunkMesh } from "./mesher";

export const DEFAULT_SHADE = { top: 1, bottom: 0.5, x: 0.8, z: 0.65 };

export interface Face {
  normal: Vec3;
  corners: [Vec3, Vec3, Vec3, Vec3];
  color: "top" | "side" | "bottom";
  shade: "top" | "bottom" | "x" | "z";
}

// Corners wind counter-clockwise seen from outside the cube.
export const FACES: Face[] = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], color: "side", shade: "x" },
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], color: "side", shade: "x" },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], color: "top", shade: "top" },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], color: "bottom", shade: "bottom" },
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], color: "side", shade: "z" },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], color: "side", shade: "z" },
];

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** A face's colour: `hex` shaded by `k`, in sRGB or linear space. */
export function faceColor(hex: number, k: number, linear: boolean): [number, number, number] {
  const to = linear ? srgbToLinear : (c: number) => c;
  return [to(((hex >> 16) & 0xff) / 255) * k, to(((hex >> 8) & 0xff) / 255) * k, to((hex & 0xff) / 255) * k];
}

/** Packs quads, four vertices each, into a mesh with two triangles a face. */
/**
 * Where a face corner falls in its texture, 0 to 1 on each axis. Side faces run
 * the texture upright; top and bottom faces lay it along x and z.
 */
export function faceUv(normal: Vec3, corner: Vec3): [number, number] {
  if (normal[1] !== 0) return [corner[0], corner[2]];
  const u = normal[0] !== 0 ? corner[2] : corner[0];
  return [u, 1 - corner[1]];
}

export function meshArrays(positions: number[], normals: number[], colors: number[], faceCount: number, uvs: number[] = []): ChunkMesh {
  const indices = new Uint16Array(faceCount * 6);
  for (let f = 0; f < faceCount; f++) {
    const v = f * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], f * 6);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    uvs: uvs.length ? Float32Array.from(uvs) : new Float32Array(faceCount * 8),
    indices,
    faceCount,
  };
}
