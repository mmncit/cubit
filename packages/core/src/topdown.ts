import { AIR, type BlockRegistry } from "./blocks";
import { CHUNK_SIZE, voxelIndex } from "./chunk";
import type { ChunkStore } from "./world";

/** A rectangle of columns, in world block coordinates, inclusive. North is -z. */
export interface TopDownArea {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface TopDownImage {
  width: number;
  height: number;
  /** RGBA, row by row from the area's north edge (minZ) to its south edge. */
  pixels: Uint8ClampedArray;
  /** Height of the top block per column, or -Infinity where nothing is loaded. */
  heights: Float64Array;
}

/**
 * A map of an area seen from above: each pixel is one column, coloured by the
 * top face of its highest block and shaded so slopes read as relief. North is up
 * and east is right. Pure and DOM-free, so it can run in a worker or on a
 * server, and any renderer can draw the result.
 */
export function renderTopDown(store: ChunkStore, registry: BlockRegistry, area: TopDownArea): TopDownImage {
  const width = area.maxX - area.minX + 1;
  const height = area.maxZ - area.minZ + 1;
  const heights = new Float64Array(width * height).fill(-Infinity);
  const ids = new Uint16Array(width * height);

  // Highest chunks first, so the first block found in a column is its top.
  const chunks = [...store.chunks.values()]
    .filter(({ coords: [cx, , cz] }) => {
      const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
      return x0 + CHUNK_SIZE > area.minX && x0 <= area.maxX && z0 + CHUNK_SIZE > area.minZ && z0 <= area.maxZ;
    })
    .sort((a, b) => b.coords[1] - a.coords[1]);

  for (const chunk of chunks) {
    const [cx, cy, cz] = chunk.coords;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const z = cz * CHUNK_SIZE + lz;
      if (z < area.minZ || z > area.maxZ) continue;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        if (x < area.minX || x > area.maxX) continue;
        const i = (x - area.minX) + (z - area.minZ) * width;
        if (heights[i] !== -Infinity) continue;
        for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
          const id = chunk.blocks[voxelIndex(lx, ly, lz)]!;
          if (id === AIR) continue;
          heights[i] = cy * CHUNK_SIZE + ly;
          ids[i] = id;
          break;
        }
      }
    }
  }

  let low = Infinity, high = -Infinity;
  for (const h of heights) {
    if (h === -Infinity) continue;
    low = Math.min(low, h);
    high = Math.max(high, h);
  }
  const span = Math.max(1, high - low);

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = col + row * width;
      const h = heights[i]!;
      if (h === -Infinity) continue; // transparent where nothing is loaded
      const color = registry.get(ids[i]!).colors.top;
      // Higher ground is lighter, and ground rising towards the north-west is lit
      // while ground falling away is in shade, the usual hillshade convention.
      const upNorthWest = col > 0 && row > 0 ? heights[i - width - 1]! : h;
      const slope = upNorthWest === -Infinity ? 0 : Math.max(-2, Math.min(2, h - upNorthWest));
      const shade = 0.82 + 0.22 * ((h - low) / span) + 0.07 * slope;
      const o = i * 4;
      pixels[o] = ((color >> 16) & 0xff) * shade;
      pixels[o + 1] = ((color >> 8) & 0xff) * shade;
      pixels[o + 2] = (color & 0xff) * shade;
      pixels[o + 3] = 255;
    }
  }
  return { width, height, pixels, heights };
}
