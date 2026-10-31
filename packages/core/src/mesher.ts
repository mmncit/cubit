import { AIR, type BlockRegistry } from "./blocks";
import { CHUNK_SIZE, voxelIndex } from "./chunk";
import type { Vec3 } from "./math";
import { getBlock, getChunk, type ChunkStore } from "./world";
import { DEFAULT_SHADE, FACES, faceUv, meshArrays, srgbToLinear } from "./faces";
import type { AtlasLayout } from "./textures";

/**
 * Geometry for one chunk, in chunk-local coordinates (0 to 16 on each axis).
 * Plain typed arrays, so it can be built in a worker and handed to any renderer.
 */
export interface ChunkMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Texture coordinates into the atlas, two per vertex. Zeros without an atlas. */
  uvs: Float32Array;
  indices: Uint16Array;
  faceCount: number;
}

export interface MeshOptions {
  /** Output colours in linear space instead of sRGB. Most renderers want linear. */
  linearColors?: boolean;
  /** Brightness per face direction, a cheap stand-in for lighting. */
  shade?: { top: number; bottom: number; x: number; z: number };
  /** Where each texture style sits in the renderer's atlas. Without it, no texture coordinates. */
  atlas?: AtlasLayout;
  /**
   * Which blocks to mesh: everything (the default), everything but liquids, or
   * liquids alone, so a renderer can draw liquids in a see-through pass of their own.
   */
  liquids?: "include" | "skip" | "only";
  /**
   * Ambient occlusion: darkens each corner of a face by how many solid blocks
   * crowd it, so creases, the foot of a wall and the inside of a hole read as
   * shaded. Off by default, which keeps colours exactly as the registry gives them.
   */
  ao?: boolean;
}

/** Brightness at a corner with 0, 1, 2 or 3 solid blocks round it. */
export const AO_LEVELS = [1, 0.76, 0.6, 0.45] as const;

const FULL_LIGHT = [1, 1, 1, 1];

/** How far a liquid's open surface sits below the top of its block. */
export const LIQUID_SURFACE_DROP = 1 / 8;

/**
 * Builds a face-culled mesh for the chunk at `coords`. A face is emitted only
 * where the neighbouring block does not hide it. Neighbours in chunks that are
 * not loaded count as hidden, so remesh a chunk when its neighbours arrive.
 */
export function meshChunk(
  store: ChunkStore,
  registry: BlockRegistry,
  coords: Vec3,
  options: MeshOptions = {},
): ChunkMesh {
  const chunk = getChunk(store, coords[0], coords[1], coords[2]);
  const empty: ChunkMesh = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    colors: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint16Array(0),
    faceCount: 0,
  };
  if (!chunk) return empty;

  const shade = options.shade ?? DEFAULT_SHADE;
  const toColor = options.linearColors ? srgbToLinear : (c: number) => c;
  const originX = coords[0] * CHUNK_SIZE;
  const originY = coords[1] * CHUNK_SIZE;
  const originZ = coords[2] * CHUNK_SIZE;
  const blocks = chunk.blocks;

  const neighbour = (lx: number, ly: number, lz: number): number => {
    if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      return blocks[voxelIndex(lx, ly, lz)]!;
    }
    // -1 marks an unloaded neighbour, which hides the face.
    return getBlock(store, originX + lx, originY + ly, originZ + lz) ?? -1;
  };

  const solid = (x: number, y: number, z: number) => {
    const n = neighbour(x, y, z);
    return n !== -1 && n !== AIR && registry.isOpaque(n);
  };
  /** Each corner's brightness: the blocks beside it and diagonally across it in the layer the face looks into. */
  const cornerLight = (normal: Vec3, corners: readonly Vec3[], lx: number, ly: number, lz: number): number[] => {
    const axis = normal[0] !== 0 ? 0 : normal[1] !== 0 ? 1 : 2;
    const [a, b] = ([0, 1, 2] as const).filter((i) => i !== axis) as [0 | 1 | 2, 0 | 1 | 2];
    const base: Vec3 = [lx + normal[0], ly + normal[1], lz + normal[2]];
    return corners.map((corner) => {
      const at = (da: number, db: number) => {
        const p: Vec3 = [...base];
        p[a] += da;
        p[b] += db;
        return solid(p[0], p[1], p[2]);
      };
      const da = corner[a] === 1 ? 1 : -1;
      const db = corner[b] === 1 ? 1 : -1;
      const side1 = at(da, 0);
      const side2 = at(0, db);
      const occluded = side1 && side2 ? 3 : Number(side1) + Number(side2) + Number(at(da, db));
      return AO_LEVELS[occluded]!;
    });
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const atlas = options.atlas;
  const liquids = options.liquids ?? "include";
  let faceCount = 0;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = blocks[voxelIndex(lx, ly, lz)]!;
        if (id === AIR) continue;
        const liquid = registry.isLiquid(id);
        if ((liquids === "skip" && liquid) || (liquids === "only" && !liquid)) continue;
        const def = registry.get(id);
        // A liquid with open air or anything but itself above: its surface sits a little low.
        const lowered = liquid && neighbour(lx, ly + 1, lz) !== id;
        for (const face of FACES) {
          const n = neighbour(lx + face.normal[0], ly + face.normal[1], lz + face.normal[2]);
          if (n === -1) continue;
          if (n !== AIR && (registry.isOpaque(n) || n === id)) continue;

          const hex = def.colors[face.color];
          const k = shade[face.shade];
          const r = toColor(((hex >> 16) & 0xff) / 255) * k;
          const g = toColor(((hex >> 8) & 0xff) / 255) * k;
          const b = toColor((hex & 0xff) / 255) * k;
          const rect = atlas?.rects.get(def.textures[face.color]) ?? atlas?.rects.get("flat");
          const light = options.ao && !liquid ? cornerLight(face.normal, face.corners, lx, ly, lz) : FULL_LIGHT;
          // Split the quad along the diagonal whose ends are more alike, or the shading shows a crease.
          const turn = light[0]! + light[2]! < light[1]! + light[3]! ? 1 : 0;
          for (let c = 0; c < 4; c++) {
            const corner = face.corners[(c + turn) % 4]!;
            const l = light[(c + turn) % 4]!;
            positions.push(lx + corner[0], ly + corner[1] - (lowered && corner[1] === 1 ? LIQUID_SURFACE_DROP : 0), lz + corner[2]);
            normals.push(face.normal[0], face.normal[1], face.normal[2]);
            colors.push(r * l, g * l, b * l);
            if (rect) {
              const [u, v] = faceUv(face.normal, corner);
              uvs.push(rect[0] + (rect[2] - rect[0]) * u, rect[1] + (rect[3] - rect[1]) * v);
            } else uvs.push(0, 0);
          }
          faceCount++;
        }
      }
    }
  }

  // A 16^3 chunk emits at most 12288 faces (a checkerboard), which is 49152
  // vertices, so 16-bit indices are always enough.
  return meshArrays(positions, normals, colors, faceCount, uvs);
}
