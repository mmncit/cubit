import { describe, expect, it } from "vitest";
import { BlockRegistry, chunkKey, createChunk, renderTopDown, voxelIndex, type ChunkData } from "../src";

function setup() {
  const registry = new BlockRegistry();
  const stone = registry.define({ name: "stone", color: 0x808080 });
  const red = registry.define({ name: "red", colors: { top: 0xff0000, side: 0x000000 } });
  const blue = registry.define({ name: "blue", color: 0x0000ff });
  const ground = createChunk(0, 0, -1);
  const upper = createChunk(0, 1, -1);
  // Flat stone at y = 2 across the chunk.
  for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) ground.blocks[voxelIndex(lx, 2, lz)] = stone;
  // A red column top at world (3, 20, -14), in the chunk above: the north-west corner area.
  upper.blocks[voxelIndex(3, 4, 2)] = red;
  // A blue block at world (12, 5, -2): east and south.
  ground.blocks[voxelIndex(12, 5, 14)] = blue;
  const store = { chunks: new Map<string, ChunkData>([ground, upper].map((c) => [chunkKey(...c.coords), c])) };
  return { registry, store };
}

const pixel = (img: ReturnType<typeof renderTopDown>, x: number, z: number, minX: number, minZ: number) => {
  const o = ((x - minX) + (z - minZ) * img.width) * 4;
  return [img.pixels[o]!, img.pixels[o + 1]!, img.pixels[o + 2]!, img.pixels[o + 3]!];
};

describe("renderTopDown", () => {
  const area = { minX: 0, minZ: -16, maxX: 15, maxZ: -1 };

  it("records the height of each column's highest block, even in a higher chunk", () => {
    const { registry, store } = setup();
    const img = renderTopDown(store, registry, area);
    expect(img.width).toBe(16);
    expect(img.height).toBe(16);
    expect(img.heights[(3 - 0) + (-14 + 16) * 16]).toBe(20);
    expect(img.heights[(12 - 0) + (-2 + 16) * 16]).toBe(5);
    expect(img.heights[0]).toBe(2);
  });

  it("puts north (-z) at the top row and east (+x) to the right", () => {
    const { registry, store } = setup();
    const img = renderTopDown(store, registry, area);
    const red = pixel(img, 3, -14, 0, -16);
    const blue = pixel(img, 12, -2, 0, -16);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[2]).toBe(0);
    expect(blue[2]).toBeGreaterThan(150);
    expect(blue[0]).toBe(0);
  });

  it("uses the top face colour, not the sides", () => {
    const { registry, store } = setup();
    expect(pixel(renderTopDown(store, registry, area), 3, -14, 0, -16)[0]).toBeGreaterThan(200);
  });

  it("leaves columns with nothing loaded transparent", () => {
    const { registry, store } = setup();
    const img = renderTopDown(store, registry, { minX: 0, minZ: -16, maxX: 31, maxZ: -1 });
    expect(pixel(img, 20, -5, 0, -16)[3]).toBe(0);
    expect(img.heights[20 + 11 * 32]).toBe(-Infinity);
  });
});
