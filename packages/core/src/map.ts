import { AIR, type BlockInput, type BlockRegistry } from "./blocks";
import { ByteReader, ByteWriter, fromBase64, toBase64 } from "./bytes";
import { CHUNK_SIZE, createChunk, toChunk, voxelIndex } from "./chunk";
import type { WorldGenerator } from "./generator";
import type { Vec3 } from "./math";

export const MAP_FORMAT = "cubit/map";
export const MAP_VERSION = 1;

/**
 * A hand-built region of the world, for games whose levels are authored rather
 * than generated. JSON-safe, so a level can come from any tool that writes it.
 *
 * `data` is base64 of varint run-length pairs (run length, palette index) over
 * the box, with x varying fastest, then z, then y.
 */
export interface VoxelMap {
  format: typeof MAP_FORMAT;
  version: number;
  /** World block coordinate of the box's lowest corner. */
  origin: Vec3;
  /** Extent of the box in blocks along x, y and z. */
  size: Vec3;
  /** Block names used in the box. */
  palette: string[];
  data: string;
  /** Optional block definitions for the palette, so the map can bring its own look. */
  blocks?: BlockInput[];
}

/** Builds a map from a function that names the block at each position inside the box. */
export function encodeVoxelMap(
  origin: Vec3,
  size: Vec3,
  blockAt: (x: number, y: number, z: number) => string,
  blocks?: BlockInput[],
): VoxelMap {
  const palette: string[] = [];
  const index = new Map<string, number>();
  const writer = new ByteWriter();
  let runName: string | null = null;
  let runLength = 0;
  const flush = () => {
    if (runName === null) return;
    let i = index.get(runName);
    if (i === undefined) {
      i = palette.length;
      index.set(runName, i);
      palette.push(runName);
    }
    writer.varint(runLength);
    writer.varint(i);
  };
  for (let y = 0; y < size[1]; y++) {
    for (let z = 0; z < size[2]; z++) {
      for (let x = 0; x < size[0]; x++) {
        const name = blockAt(origin[0] + x, origin[1] + y, origin[2] + z);
        if (name === runName) {
          runLength++;
        } else {
          flush();
          runName = name;
          runLength = 1;
        }
      }
    }
  }
  flush();
  const map: VoxelMap = { format: MAP_FORMAT, version: MAP_VERSION, origin: [...origin], size: [...size], palette, data: toBase64(writer.finish()) };
  if (blocks) map.blocks = blocks;
  return map;
}

export interface DecodedMap {
  origin: Vec3;
  size: Vec3;
  palette: string[];
  /** Palette index per cell, in the map's x, then z, then y order. */
  cells: Uint16Array;
}

export function assertVoxelMap(value: unknown): asserts value is VoxelMap {
  const m = value as Partial<VoxelMap> | null;
  if (!m || typeof m !== "object" || m.format !== MAP_FORMAT) throw new Error("This is not a cubit map.");
  if (m.version !== MAP_VERSION) {
    throw new Error(`Map version ${String(m.version)} is not supported. This build reads version ${MAP_VERSION}.`);
  }
  const ok3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(Number.isInteger);
  if (!ok3(m.origin) || !ok3(m.size) || !Array.isArray(m.palette) || typeof m.data !== "string") {
    throw new Error("Map is missing required fields.");
  }
  if (m.size!.some((n) => n <= 0)) throw new Error("Map size must be positive on every axis.");
}

export function decodeVoxelMap(map: VoxelMap): DecodedMap {
  assertVoxelMap(map);
  const [sx, sy, sz] = map.size;
  const cells = new Uint16Array(sx * sy * sz);
  const reader = new ByteReader(fromBase64(map.data));
  let offset = 0;
  while (!reader.done) {
    const length = reader.varint();
    const index = reader.varint();
    if (index >= map.palette.length) throw new Error("Map data refers to a palette entry that does not exist.");
    if (offset + length > cells.length) throw new Error("Map data holds more cells than its size allows.");
    cells.fill(index, offset, offset + length);
    offset += length;
  }
  if (offset !== cells.length) throw new Error(`Map data holds ${offset} cells, expected ${cells.length}.`);
  return { origin: [...map.origin], size: [...map.size], palette: [...map.palette], cells };
}

/** Defines every block the map brings its own definition for. Existing names are left alone. */
export function defineMapBlocks(registry: BlockRegistry, map: VoxelMap): void {
  for (const block of map.blocks ?? []) {
    if (registry.tryId(block.name) === undefined) registry.define(block);
  }
}

export interface MapGeneratorOptions {
  /** Fills everything outside the map box, for example flat ground so the edge does not show. */
  outside?: WorldGenerator;
}

/**
 * A generator that serves an authored map. Decodes the map once, up front, so
 * generating a chunk is a pure lookup.
 */
export function createMapGenerator(map: VoxelMap, options: MapGeneratorOptions = {}): WorldGenerator {
  const decoded = decodeVoxelMap(map);
  const [ox, oy, oz] = decoded.origin;
  const [sx, sy, sz] = decoded.size;
  const outside = options.outside;
  const idsByRegistry = new WeakMap<BlockRegistry, number[]>();

  const mapMin = toChunk(oy);
  const mapMax = toChunk(oy + sy - 1);
  const verticalRange: [number, number] = outside
    ? [Math.min(mapMin, outside.verticalRange[0]), Math.max(mapMax, outside.verticalRange[1])]
    : [mapMin, mapMax];

  const idsFor = (registry: BlockRegistry): number[] => {
    let ids = idsByRegistry.get(registry);
    if (!ids) {
      ids = decoded.palette.map((name) => {
        const id = registry.tryId(name);
        if (id === undefined) throw new Error(`Map uses block "${name}", which this game does not define.`);
        return id;
      });
      idsByRegistry.set(registry, ids);
    }
    return ids;
  };

  return {
    verticalRange,
    generate(coords, registry, seed) {
      const [cx, cy, cz] = coords;
      const chunk = outside ? outside.generate(coords, registry, seed) : createChunk(cx, cy, cz);
      chunk.coords = [cx, cy, cz];
      const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
      const xa = Math.max(x0, ox), xb = Math.min(x0 + CHUNK_SIZE, ox + sx);
      const ya = Math.max(y0, oy), yb = Math.min(y0 + CHUNK_SIZE, oy + sy);
      const za = Math.max(z0, oz), zb = Math.min(z0 + CHUNK_SIZE, oz + sz);
      if (xa >= xb || ya >= yb || za >= zb) return chunk;
      const ids = idsFor(registry);
      for (let y = ya; y < yb; y++) {
        for (let z = za; z < zb; z++) {
          for (let x = xa; x < xb; x++) {
            const cell = decoded.cells[(x - ox) + (z - oz) * sx + (y - oy) * sx * sz]!;
            chunk.blocks[voxelIndex(x - x0, y - y0, z - z0)] = ids[cell] ?? AIR;
          }
        }
      }
      return chunk;
    },
  };
}

/** Solid ground up to and including `height`, air above. Handy outside a map box. */
export function createFlatGenerator(options: { surface: string; below?: string; height: number; verticalChunks?: number }): WorldGenerator {
  const verticalChunks = options.verticalChunks ?? 1;
  return {
    verticalRange: [0, verticalChunks - 1],
    generate([cx, cy, cz], registry) {
      const chunk = createChunk(cx, cy, cz);
      const surface = registry.id(options.surface);
      const below = registry.id(options.below ?? options.surface);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const y = cy * CHUNK_SIZE + ly;
        if (y > options.height) break;
        const id = y === options.height ? surface : below;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) chunk.blocks[voxelIndex(lx, ly, lz)] = id;
        }
      }
      return chunk;
    },
  };
}
