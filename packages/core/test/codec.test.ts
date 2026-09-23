import { describe, expect, it } from "vitest";
import {
  AIR,
  BlockRegistry,
  CHUNK_VOLUME,
  createChunk,
  decodeChunk,
  decodeChunkBase64,
  encodeChunk,
  encodeChunkBase64,
  fromBase64,
  toBase64,
  decodeUtf8,
  encodeUtf8,
  voxelIndex,
} from "../src";
import { makeRegistry } from "./helpers";

function sampleChunk() {
  const registry = makeRegistry();
  const chunk = createChunk(2, -1, 5);
  for (let i = 0; i < CHUNK_VOLUME; i++) chunk.blocks[i] = i % 7 === 0 ? registry.id("stone") : AIR;
  chunk.blocks[voxelIndex(3, 4, 5)] = registry.id("grass");
  return { registry, chunk };
}

describe("chunk codec", () => {
  it("round-trips through bytes", () => {
    const { registry, chunk } = sampleChunk();
    const decoded = decodeChunk(encodeChunk(chunk, registry), chunk.coords, registry);
    expect(Array.from(decoded.blocks)).toEqual(Array.from(chunk.blocks));
    expect(decoded.coords).toEqual([2, -1, 5]);
  });

  it("round-trips through base64", () => {
    const { registry, chunk } = sampleChunk();
    const text = encodeChunkBase64(chunk, registry);
    expect(typeof text).toBe("string");
    expect(Array.from(decodeChunkBase64(text, chunk.coords, registry).blocks)).toEqual(Array.from(chunk.blocks));
  });

  it("is the reason typed arrays never go through JSON directly", () => {
    // The trap this codec exists for: a Uint16Array stringifies to an object
    // keyed "0", "1", ... and comes back as a plain object, not an array.
    const parsed = JSON.parse(JSON.stringify({ blocks: new Uint16Array([1, 2, 3]) }));
    expect(parsed.blocks).toEqual({ 0: 1, 1: 2, 2: 3 });
    expect(parsed.blocks instanceof Uint16Array).toBe(false);
  });

  it("stores block names, so a registry defined in another order reads the same blocks", () => {
    const { registry, chunk } = sampleChunk();
    const reordered = makeRegistry("reversed");
    expect(reordered.id("stone")).not.toBe(registry.id("stone"));
    const decoded = decodeChunk(encodeChunk(chunk, registry), chunk.coords, reordered);
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      expect(reordered.name(decoded.blocks[i]!)).toBe(registry.name(chunk.blocks[i]!));
    }
  });

  it("refuses a block the game does not define, unless told to use air", () => {
    const { registry, chunk } = sampleChunk();
    const bytes = encodeChunk(chunk, registry);
    const withoutGrass = new BlockRegistry();
    withoutGrass.define({ name: "stone" });
    expect(() => decodeChunk(bytes, chunk.coords, withoutGrass)).toThrow(/grass/);
    const lenient = decodeChunk(bytes, chunk.coords, withoutGrass, { unknownBlocks: "air" });
    expect(lenient.blocks[voxelIndex(3, 4, 5)]).toBe(AIR);
  });

  it("rejects truncated data", () => {
    const { registry, chunk } = sampleChunk();
    const bytes = encodeChunk(chunk, registry);
    expect(() => decodeChunk(bytes.subarray(0, bytes.length - 2), chunk.coords, registry)).toThrow();
  });

  it("compresses a uniform chunk to a few bytes", () => {
    const registry = makeRegistry();
    const chunk = createChunk(0, 0, 0);
    chunk.blocks.fill(registry.id("stone"));
    expect(encodeChunk(chunk, registry).length).toBeLessThan(16);
  });
});

describe("byte helpers", () => {
  it("round-trips base64 for every length remainder", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 37) & 0xff);
      expect(Array.from(fromBase64(toBase64(data)))).toEqual(Array.from(data));
    }
  });

  it("matches the platform base64 encoder", () => {
    const data = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
    expect(toBase64(data)).toBe(Buffer.from(data).toString("base64"));
  });

  it("round-trips UTF-8 including non-Latin names", () => {
    for (const text of ["stone", "قرية", "blé", "🧱"]) {
      expect(decodeUtf8(encodeUtf8(text))).toBe(text);
      expect(Array.from(encodeUtf8(text))).toEqual(Array.from(Buffer.from(text, "utf8")));
    }
  });
});
