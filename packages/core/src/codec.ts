import { AIR, type BlockRegistry } from "./blocks";
import { ByteReader, ByteWriter, fromBase64, toBase64 } from "./bytes";
import { CHUNK_VOLUME, createChunk, type ChunkData } from "./chunk";
import type { Vec3 } from "./math";

const CHUNK_FORMAT = 1;

export interface DecodeOptions {
  /**
   * What to do with a block name the registry does not define, for example
   * after a block type was removed from a game. Defaults to "error".
   */
  unknownBlocks?: "error" | "air";
}

/**
 * Encodes a chunk's blocks as bytes: a palette of block names followed by
 * run-length encoded palette indices. Names rather than ids, so a save stays
 * valid when the game defines its blocks in a different order.
 *
 * Coordinates are not included; they travel alongside the bytes.
 */
export function encodeChunk(chunk: ChunkData, registry: BlockRegistry): Uint8Array {
  const paletteIndex = new Map<number, number>();
  const palette: string[] = [];
  const runs: number[] = [];

  let runId = -1;
  let runLength = 0;
  const flush = () => {
    if (runLength === 0) return;
    let index = paletteIndex.get(runId);
    if (index === undefined) {
      index = palette.length;
      paletteIndex.set(runId, index);
      palette.push(registry.name(runId));
    }
    runs.push(runLength, index);
  };

  for (let i = 0; i < CHUNK_VOLUME; i++) {
    const id = chunk.blocks[i]!;
    if (id === runId) {
      runLength++;
    } else {
      flush();
      runId = id;
      runLength = 1;
    }
  }
  flush();

  const writer = new ByteWriter();
  writer.u8(CHUNK_FORMAT);
  writer.varint(palette.length);
  for (const name of palette) writer.string(name);
  writer.varint(runs.length / 2);
  for (const n of runs) writer.varint(n);
  return writer.finish();
}

export function decodeChunk(
  data: Uint8Array,
  coords: Vec3,
  registry: BlockRegistry,
  options: DecodeOptions = {},
): ChunkData {
  const reader = new ByteReader(data);
  const format = reader.u8();
  if (format !== CHUNK_FORMAT) {
    throw new Error(`Unsupported chunk format ${format}. This build reads format ${CHUNK_FORMAT}.`);
  }

  const paletteLength = reader.varint();
  const palette: number[] = [];
  for (let i = 0; i < paletteLength; i++) {
    const name = reader.string();
    const id = registry.tryId(name);
    if (id === undefined) {
      if (options.unknownBlocks === "air") {
        palette.push(AIR);
      } else {
        throw new Error(`Chunk uses block "${name}", which this game does not define.`);
      }
    } else {
      palette.push(id);
    }
  }

  const chunk = createChunk(coords[0], coords[1], coords[2]);
  const runCount = reader.varint();
  let offset = 0;
  for (let r = 0; r < runCount; r++) {
    const length = reader.varint();
    const index = reader.varint();
    const id = palette[index];
    if (id === undefined) throw new Error("Chunk data refers to a palette entry that does not exist.");
    if (offset + length > CHUNK_VOLUME) throw new Error("Chunk data holds more blocks than a chunk.");
    chunk.blocks.fill(id, offset, offset + length);
    offset += length;
  }
  if (offset !== CHUNK_VOLUME) throw new Error(`Chunk data holds ${offset} blocks, expected ${CHUNK_VOLUME}.`);
  if (!reader.done) throw new Error("Chunk data has trailing bytes.");
  return chunk;
}

export function encodeChunkBase64(chunk: ChunkData, registry: BlockRegistry): string {
  return toBase64(encodeChunk(chunk, registry));
}

export function decodeChunkBase64(
  text: string,
  coords: Vec3,
  registry: BlockRegistry,
  options?: DecodeOptions,
): ChunkData {
  return decodeChunk(fromBase64(text), coords, registry, options);
}
