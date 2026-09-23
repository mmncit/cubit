import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { AIR, type BlockRegistry } from "./blocks";
import { CHUNK_SIZE, createChunk, voxelIndex, type ChunkData } from "./chunk";
import type { Vec3 } from "./math";
import { hashFloat, mulberry32 } from "./rng";

/**
 * Produces the initial contents of a chunk. Must be a pure function of its
 * arguments: the same coordinates and seed always give the same chunk, which is
 * what lets saves store only the chunks a player changed.
 */
export interface WorldGenerator {
  /** Chunk y range the world occupies, inclusive. */
  readonly verticalRange: [minChunkY: number, maxChunkY: number];
  generate(coords: Vec3, registry: BlockRegistry, seed: number): ChunkData;
}

export interface TerrainOptions {
  /** Top block of each column. */
  surface: string;
  /** The few blocks under the surface. */
  subsurface: string;
  /** Everything deeper. */
  deep: string;
  /** Replaces the surface at or below `shoreHeight`. */
  shore?: string;
  shoreHeight?: number;
  trees?: { trunk: string; leaves: string; chance: number };
  baseHeight?: number;
  amplitude?: number;
  /** Horizontal size of hills, in blocks. */
  scale?: number;
  verticalChunks?: number;
}

/** A rolling heightmap terrain with optional trees. A starting point, not a requirement. */
export function createTerrainGenerator(options: TerrainOptions): WorldGenerator {
  const baseHeight = options.baseHeight ?? 20;
  const amplitude = options.amplitude ?? 10;
  const scale = options.scale ?? 48;
  const verticalChunks = options.verticalChunks ?? 4;
  const noiseBySeed = new Map<number, NoiseFunction2D>();

  const noiseFor = (seed: number): NoiseFunction2D => {
    let noise = noiseBySeed.get(seed);
    if (!noise) {
      noise = createNoise2D(mulberry32(seed));
      noiseBySeed.set(seed, noise);
    }
    return noise;
  };

  const heightAt = (noise: NoiseFunction2D, x: number, z: number): number => {
    const n =
      noise(x / scale, z / scale) +
      0.5 * noise((x / scale) * 2 + 31.7, (z / scale) * 2 - 11.3) +
      0.25 * noise((x / scale) * 4 - 7.1, (z / scale) * 4 + 19.9);
    return Math.floor(baseHeight + (n / 1.75) * amplitude);
  };

  return {
    verticalRange: [0, verticalChunks - 1],
    generate(coords, registry, seed) {
      const [cx, cy, cz] = coords;
      const chunk = createChunk(cx, cy, cz);
      const noise = noiseFor(seed);
      const surface = registry.id(options.surface);
      const subsurface = registry.id(options.subsurface);
      const deep = registry.id(options.deep);
      const shore = options.shore ? registry.id(options.shore) : surface;
      const shoreHeight = options.shoreHeight ?? -Infinity;
      const x0 = cx * CHUNK_SIZE;
      const y0 = cy * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;

      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const height = heightAt(noise, x0 + lx, z0 + lz);
          const top = height <= shoreHeight ? shore : surface;
          for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            const y = y0 + ly;
            if (y > height) break;
            const id = y === height ? top : y > height - 4 ? (top === shore ? shore : subsurface) : deep;
            chunk.blocks[voxelIndex(lx, ly, lz)] = id;
          }
        }
      }

      if (options.trees) {
        const trunk = registry.id(options.trees.trunk);
        const leaves = registry.id(options.trees.leaves);
        const put = (x: number, y: number, z: number, id: number, overwrite: boolean) => {
          const lx = x - x0, ly = y - y0, lz = z - z0;
          if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
          const i = voxelIndex(lx, ly, lz);
          if (overwrite || chunk.blocks[i] === AIR) chunk.blocks[i] = id;
        };
        // Visit columns a little beyond the chunk, because a tree rooted next
        // door can reach into this chunk with its leaves.
        const reach = 2;
        for (let z = z0 - reach; z < z0 + CHUNK_SIZE + reach; z++) {
          for (let x = x0 - reach; x < x0 + CHUNK_SIZE + reach; x++) {
            if (hashFloat(seed, x, 7, z) >= options.trees.chance) continue;
            const ground = heightAt(noise, x, z);
            if (ground <= shoreHeight) continue;
            const trunkHeight = 4 + Math.floor(hashFloat(seed, x, 11, z) * 2);
            const crown = ground + trunkHeight;
            for (let dy = -2; dy <= 1; dy++) {
              const radius = dy >= 0 ? 1 : 2;
              for (let dz = -radius; dz <= radius; dz++) {
                for (let dx = -radius; dx <= radius; dx++) {
                  if (Math.abs(dx) === radius && Math.abs(dz) === radius && hashFloat(seed, x + dx, crown + dy, z + dz) < 0.5) continue;
                  put(x + dx, crown + dy, z + dz, leaves, false);
                }
              }
            }
            for (let y = ground + 1; y < crown; y++) put(x, y, z, trunk, true);
          }
        }
      }

      return chunk;
    },
  };
}
