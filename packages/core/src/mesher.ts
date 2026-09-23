import { AIR, type BlockRegistry } from "./blocks";
import { CHUNK_SIZE, voxelIndex } from "./chunk";
import type { Vec3 } from "./math";
import { getBlock, getChunk, type ChunkStore } from "./world";

/**
 * Geometry for one chunk, in chunk-local coordinates (0 to 16 on each axis).
 * Plain typed arrays, so it can be built in a worker and handed to any renderer.
 */
export interface ChunkMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
  faceCount: number;
}

export interface MeshOptions {
  /** Output colours in linear space instead of sRGB. Most renderers want linear. */
  linearColors?: boolean;
  /** Brightness per face direction, a cheap stand-in for lighting. */
  shade?: { top: number; bottom: number; x: number; z: number };
}

const DEFAULT_SHADE = { top: 1, bottom: 0.5, x: 0.8, z: 0.65 };

interface Face {
  normal: Vec3;
  corners: [Vec3, Vec3, Vec3, Vec3];
  color: "top" | "side" | "bottom";
  shade: "top" | "bottom" | "x" | "z";
}

// Corners wind counter-clockwise seen from outside the cube.
const FACES: Face[] = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], color: "side", shade: "x" },
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], color: "side", shade: "x" },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], color: "top", shade: "top" },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], color: "bottom", shade: "bottom" },
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], color: "side", shade: "z" },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], color: "side", shade: "z" },
];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

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

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  let faceCount = 0;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = blocks[voxelIndex(lx, ly, lz)]!;
        if (id === AIR) continue;
        const def = registry.get(id);
        for (const face of FACES) {
          const n = neighbour(lx + face.normal[0], ly + face.normal[1], lz + face.normal[2]);
          if (n === -1) continue;
          if (n !== AIR && (registry.isOpaque(n) || n === id)) continue;

          const hex = def.colors[face.color];
          const k = shade[face.shade];
          const r = toColor(((hex >> 16) & 0xff) / 255) * k;
          const g = toColor(((hex >> 8) & 0xff) / 255) * k;
          const b = toColor((hex & 0xff) / 255) * k;
          for (const corner of face.corners) {
            positions.push(lx + corner[0], ly + corner[1], lz + corner[2]);
            normals.push(face.normal[0], face.normal[1], face.normal[2]);
            colors.push(r, g, b);
          }
          faceCount++;
        }
      }
    }
  }

  // A 16^3 chunk emits at most 12288 faces (a checkerboard), which is 49152
  // vertices, so 16-bit indices are always enough.
  const indices = new Uint16Array(faceCount * 6);
  for (let f = 0; f < faceCount; f++) {
    const v = f * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], f * 6);
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    indices,
    faceCount,
  };
}
