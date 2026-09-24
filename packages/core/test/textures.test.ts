import { describe, expect, it } from "vitest";
import {
  atlasLayout,
  BlockRegistry,
  chunkKey,
  createChunk,
  defineMapBlocks,
  meshChunk,
  paintAtlas,
  paintTexture,
  TEXTURE_STYLES,
  TILE_SIZE,
  voxelIndex,
  type ChunkStore,
  type VoxelMap,
} from "../src";

describe("paintTexture", () => {
  it("paints every style the same way every time, as a tile of grey levels", () => {
    for (const style of TEXTURE_STYLES) {
      const a = paintTexture(style);
      expect(a.length).toBe(TILE_SIZE * TILE_SIZE);
      expect([...a]).toEqual([...paintTexture(style)]);
    }
  });

  it("only darkens a little, so the block's own colour still reads", () => {
    for (const style of TEXTURE_STYLES) {
      const min = Math.min(...paintTexture(style));
      expect(min, style).toBeGreaterThanOrEqual(Math.round(0.65 * 255));
    }
    expect(new Set(paintTexture("flat"))).toEqual(new Set([255]));
  });

  it("gives each style its own pattern", () => {
    const seen = new Set(TEXTURE_STYLES.map((s) => paintTexture(s).join(",")));
    expect(seen.size).toBe(TEXTURE_STYLES.length);
  });
});

describe("the atlas", () => {
  it("puts flat first, keeps every rectangle inside and apart, and is a power of two", () => {
    const layout = atlasLayout(["sand", "planks", "sand", "bark"]);
    expect([...layout.rects.keys()]).toEqual(["flat", "sand", "planks", "bark"]);
    for (const n of [layout.width, layout.height]) expect(Math.log2(n) % 1).toBe(0);
    const rects = [...layout.rects.values()];
    for (const [u0, v0, u1, v1] of rects) {
      expect(u0).toBeGreaterThan(0);
      expect(v0).toBeGreaterThan(0);
      expect(u1).toBeLessThan(1);
      expect(v1).toBeLessThanOrEqual(1);
      expect((u1 - u0) * layout.width).toBe(TILE_SIZE);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i]!, rects[j]!];
        const apart = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
        expect(apart).toBe(true);
      }
    }
  });

  it("surrounds each tile with its own pattern wrapped round, so filtering never blends in a neighbour", () => {
    const layout = atlasLayout(["planks"]);
    const pixels = paintAtlas(layout);
    const tile = paintTexture("planks");
    const [u0, v0] = layout.rects.get("planks")!;
    const x0 = Math.round(u0 * layout.width);
    const y0 = Math.round(v0 * layout.height);
    const at = (x: number, y: number) => pixels[(y * layout.width + x) * 4]!;
    // One pixel left of the tile is the tile's last column; one above is its last row.
    for (let i = 0; i < TILE_SIZE; i++) {
      expect(at(x0 - 1, y0 + i)).toBe(tile[i * TILE_SIZE + TILE_SIZE - 1]);
      expect(at(x0 + i, y0 - 1)).toBe(tile[(TILE_SIZE - 1) * TILE_SIZE + i]);
    }
  });
});

describe("block textures", () => {
  it("uses one style for every face, or per face with side as the fallback", () => {
    const registry = new BlockRegistry();
    const all = registry.get(registry.define({ name: "sandstone", color: 0xd8c08a, texture: "ashlar" }));
    expect(all.textures).toEqual({ top: "ashlar", side: "ashlar", bottom: "ashlar" });
    const log = registry.get(registry.define({ name: "log", color: 0x7a5230, texture: { side: "bark", top: "rings" } }));
    expect(log.textures).toEqual({ top: "rings", side: "bark", bottom: "bark" });
    const plain = registry.get(registry.define({ name: "plain", color: 0xffffff }));
    expect(plain.textures).toEqual({ top: "flat", side: "flat", bottom: "flat" });
  });

  it("rejects a style that does not exist", () => {
    expect(() => new BlockRegistry().define({ name: "x", texture: "marble" })).toThrow(/unknown texture "marble"/);
  });

  it("travels with a map's blocks through JSON", () => {
    const map = { origin: [0, 0, 0], size: [1, 1, 1], palette: ["air"], data: [], blocks: [{ name: "log", color: 1, texture: { side: "bark", top: "rings" } }] };
    const back = JSON.parse(JSON.stringify(map)) as VoxelMap;
    const registry = new BlockRegistry();
    defineMapBlocks(registry, back);
    expect(registry.get(registry.id("log")).textures.top).toBe("rings");
  });
});

describe("meshChunk with an atlas", () => {
  const registry = new BlockRegistry();
  const log = registry.define({ name: "log", color: 0x7a5230, texture: { side: "bark", top: "rings" } });
  const chunk = createChunk(0, 0, 0);
  chunk.blocks[voxelIndex(3, 3, 3)] = log;
  const store: ChunkStore = { chunks: new Map([[chunkKey(0, 0, 0), chunk]]) };
  const layout = atlasLayout(["bark", "rings"]);

  it("gives every vertex a texture coordinate inside its face's tile", () => {
    const mesh = meshChunk(store, registry, [0, 0, 0], { atlas: layout });
    expect(mesh.uvs.length).toBe((mesh.positions.length / 3) * 2);
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const up = mesh.normals[v * 3 + 1] === 1;
      const [u0, v0, u1, v1] = layout.rects.get(up ? "rings" : "bark")!;
      const [u, w] = [mesh.uvs[v * 2]!, mesh.uvs[v * 2 + 1]!];
      expect(u >= u0 - 1e-9 && u <= u1 + 1e-9 && w >= v0 - 1e-9 && w <= v1 + 1e-9).toBe(true);
    }
  });

  it("uses the whole tile on each face", () => {
    const mesh = meshChunk(store, registry, [0, 0, 0], { atlas: layout });
    const [u0, , u1] = layout.rects.get("bark")!;
    const us = new Set<number>();
    for (let v = 0; v < mesh.positions.length / 3; v++) if (mesh.normals[v * 3] === 1) us.add(mesh.uvs[v * 2]!);
    expect([...us].sort()).toEqual([u0, u1].sort());
  });

  it("leaves the coordinates at zero without an atlas", () => {
    const mesh = meshChunk(store, registry, [0, 0, 0]);
    expect(mesh.uvs.every((n) => n === 0)).toBe(true);
    expect(mesh.faceCount).toBe(6);
  });
});
