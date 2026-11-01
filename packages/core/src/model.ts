import { DEFAULT_SHADE, FACES, faceColor, meshArrays } from "./faces";
import type { Vec3 } from "./math";
import { box3, cellBox, concatAll, isEmptyBox, type Box3 } from "./monoid";
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
  /**
   * Palette entries, numbered as in `voxels`, that give off light, such as a
   * lantern's glass. Renderers draw them at full brightness however dark the
   * scene is.
   */
  glow?: number[];
}

export interface ModelMeshOptions extends MeshOptions {
  /** Build only the glowing voxels, only the rest, or all of them (the default). */
  part?: "all" | "glow" | "rest";
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
  for (const g of model.glow ?? []) {
    if (!Number.isInteger(g) || g < 1 || g > model.palette.length) {
      throw new Error(`Model glow entry ${g} is not a palette entry (1 to ${model.palette.length}).`);
    }
  }
}

/**
 * Where a model's light is: the centre of its glowing voxels, in blocks from the
 * centre of its base, and half their largest extent. Null if nothing glows.
 */
export function glowCentre(model: VoxelModel): { centre: Vec3; radius: number } | null {
  const glow = new Set(model.glow ?? []);
  if (glow.size === 0) return null;
  const [sx, , sz] = model.size;
  const bounds = concatAll(box3)(voxelsWhere(model, (v) => glow.has(v)));
  if (isEmptyBox(bounds)) return null;
  const { min: lo, max: hi } = bounds;
  const s = model.scale;
  const centre: Vec3 = [((lo[0] + hi[0]) / 2 - sx / 2) * s, ((lo[1] + hi[1]) / 2) * s, ((lo[2] + hi[2]) / 2 - sz / 2) * s];
  const radius = (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) * s;
  return { centre, radius };
}

/** The box of every voxel whose palette entry passes `keep`, in the model's own voxel units. */
function* voxelsWhere(model: VoxelModel, keep: (entry: number) => boolean): Generator<Box3> {
  const [sx, sy, sz] = model.size;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) if (keep(model.voxels[x + z * sx + y * sx * sz]!)) yield cellBox(x, y, z);
    }
  }
}

/**
 * Builds a face-culled mesh of a model, in blocks, with the origin at the centre
 * of its base, the way figures stand. Faces are shaded as chunk faces are, so a
 * model sits in the world's look.
 */
export function meshModel(model: VoxelModel, options: ModelMeshOptions = {}): ChunkMesh {
  validateModel(model);
  const part = options.part ?? "all";
  const glow = new Set(model.glow ?? []);
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
        const lit = glow.has(v);
        if ((part === "glow" && !lit) || (part === "rest" && lit)) continue;
        for (const face of FACES) {
          // Culled against every voxel, so the two parts fit together without gaps or hidden faces.
          if (at(x + face.normal[0], y + face.normal[1], z + face.normal[2]) !== 0) continue;
          // Light is even on every side, so glowing faces are not shaded.
          const k = lit ? 1 : shade[face.shade];
          const [r, g, b] = faceColor(palette[v - 1]!, k, options.linearColors ?? false);
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
