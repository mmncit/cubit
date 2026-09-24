import { DEFAULT_SHADE, FACES, faceColor, meshArrays } from "./faces";
import type { ChunkMesh, MeshOptions } from "./mesher";

/**
 * A small coloured voxel model, such as an item or a prop. It is plain data, so a
 * tool can author it and a game can ship it as JSON. Only its name should travel
 * in entity data; renderers are given the model itself once.
 */
export interface VoxelModel {
  /** Voxels along x, y and z. y is up. */
  size: [number, number, number];
  /** Edge of one voxel, in blocks. */
  scale: number;
  /** 0xRRGGBB colours. */
  palette: number[];
  /** One entry per voxel, x fastest, then z, then y. 0 is empty, n is palette[n - 1]. */
  voxels: number[];
}

/** Throws unless `model` is well formed. Call it on models loaded from JSON. */
export function validateModel(model: VoxelModel): void {
  const [sx, sy, sz] = model.size;
  for (const n of model.size) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`Model size must be positive whole numbers, got ${model.size.join("x")}.`);
  }
  if (!(model.scale > 0)) throw new Error(`Model scale must be positive, got ${model.scale}.`);
  if (model.voxels.length !== sx * sy * sz) {
    throw new Error(`Model has ${model.voxels.length} voxels, but its size ${sx}x${sy}x${sz} needs ${sx * sy * sz}.`);
  }
  for (const v of model.voxels) {
    if (!Number.isInteger(v) || v < 0 || v > model.palette.length) {
      throw new Error(`Model voxel ${v} is not 0 or a palette entry (1 to ${model.palette.length}).`);
    }
  }
}

/**
 * Builds a face-culled mesh of a model, in blocks, with the origin at the centre
 * of its base, the way figures stand. Faces are shaded as chunk faces are, so a
 * model sits in the world's look.
 */
export function meshModel(model: VoxelModel, options: MeshOptions = {}): ChunkMesh {
  validateModel(model);
  const [sx, sy, sz] = model.size;
  const { scale, palette, voxels } = model;
  const shade = options.shade ?? DEFAULT_SHADE;
  const at = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : voxels[x + z * sx + y * sx * sz]!;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  let faceCount = 0;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const v = at(x, y, z);
        if (v === 0) continue;
        for (const face of FACES) {
          if (at(x + face.normal[0], y + face.normal[1], z + face.normal[2]) !== 0) continue;
          const [r, g, b] = faceColor(palette[v - 1]!, shade[face.shade], options.linearColors ?? false);
          for (const c of face.corners) {
            positions.push((x + c[0] - sx / 2) * scale, (y + c[1]) * scale, (z + c[2] - sz / 2) * scale);
            normals.push(face.normal[0], face.normal[1], face.normal[2]);
            colors.push(r, g, b);
          }
          faceCount++;
        }
      }
    }
  }
  // Four vertices a face, and 16-bit indices reach 65535.
  if (faceCount * 4 > 65536) throw new Error(`Model has ${faceCount} visible faces; the most is 16384.`);
  return meshArrays(positions, normals, colors, faceCount);
}
