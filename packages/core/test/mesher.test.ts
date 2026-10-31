import { describe, expect, it } from "vitest";
import { AO_LEVELS, chunkKey, createChunk, meshChunk, voxelIndex, type ChunkData, type ChunkStore } from "../src";
import { makeRegistry } from "./helpers";

function storeWith(...chunks: ChunkData[]): ChunkStore {
  return { chunks: new Map(chunks.map((c) => [chunkKey(...c.coords), c])) };
}

describe("meshChunk", () => {
  const registry = makeRegistry();
  const stone = registry.id("stone");

  it("gives a lone block six faces", () => {
    const chunk = createChunk(0, 0, 0);
    chunk.blocks[voxelIndex(5, 5, 5)] = stone;
    const mesh = meshChunk(storeWith(chunk), registry, [0, 0, 0]);
    expect(mesh.faceCount).toBe(6);
    expect(mesh.positions.length).toBe(6 * 4 * 3);
    expect(mesh.indices.length).toBe(6 * 6);
  });

  it("hides the two touching faces of adjacent blocks", () => {
    const chunk = createChunk(0, 0, 0);
    chunk.blocks[voxelIndex(5, 5, 5)] = stone;
    chunk.blocks[voxelIndex(6, 5, 5)] = stone;
    expect(meshChunk(storeWith(chunk), registry, [0, 0, 0]).faceCount).toBe(10);
  });

  it("keeps faces next to a see-through block", () => {
    const chunk = createChunk(0, 0, 0);
    chunk.blocks[voxelIndex(5, 5, 5)] = stone;
    chunk.blocks[voxelIndex(6, 5, 5)] = registry.id("glass");
    // Stone shows its face towards the glass, so it keeps all 6. The glass
    // face towards the stone is hidden, so glass has 5.
    expect(meshChunk(storeWith(chunk), registry, [0, 0, 0]).faceCount).toBe(11);
  });

  it("treats an unloaded neighbour as hiding the face, and a loaded empty one as open", () => {
    const chunk = createChunk(0, 0, 0);
    chunk.blocks[voxelIndex(15, 5, 5)] = stone;
    expect(meshChunk(storeWith(chunk), registry, [0, 0, 0]).faceCount).toBe(5);
    expect(meshChunk(storeWith(chunk, createChunk(1, 0, 0)), registry, [0, 0, 0]).faceCount).toBe(6);
  });

  it("winds every face outward", () => {
    const chunk = createChunk(0, 0, 0);
    chunk.blocks[voxelIndex(5, 5, 5)] = stone;
    const mesh = meshChunk(storeWith(chunk), registry, [0, 0, 0]);
    for (let f = 0; f < mesh.faceCount; f++) {
      const [a, b, c] = [mesh.indices[f * 6]!, mesh.indices[f * 6 + 1]!, mesh.indices[f * 6 + 2]!];
      const p = (i: number) => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!];
      const v = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!];
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const n = [mesh.normals[a * 3]!, mesh.normals[a * 3 + 1]!, mesh.normals[a * 3 + 2]!];
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
    }
  });
});

describe("ambient occlusion", () => {
  const registry = makeRegistry();
  const stone = registry.id("stone");
  /** The colours of the top face of the block at (x, 5, z), one per corner, by its red channel. */
  const topLight = (chunk: ChunkData, x: number, z: number, ao: boolean) => {
    const mesh = meshChunk(storeWith(chunk), registry, [0, 0, 0], { ao });
    // Each face is four vertices in a row; find the one whose middle is the top of this block.
    for (let f = 0; f < mesh.faceCount; f++) {
      const v = [0, 1, 2, 3].map((c) => f * 4 + c);
      const mid = [0, 1, 2].map((k) => v.reduce((sum, i) => sum + mesh.positions[i * 3 + k]!, 0) / 4);
      if (mesh.normals[v[0]! * 3 + 1] === 1 && mid[0] === x + 0.5 && mid[1] === 6 && mid[2] === z + 0.5) return v.map((i) => mesh.colors[i * 3]!);
    }
    return [];
  };
  const floor = () => {
    const chunk = createChunk(0, 0, 0);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.blocks[voxelIndex(x, 5, z)] = stone;
    return chunk;
  };

  it("leaves open ground evenly lit, and colours as they were without it", () => {
    const open = topLight(floor(), 5, 5, true);
    expect(open).toHaveLength(4);
    expect(new Set(open).size).toBe(1);
    expect(open).toEqual(topLight(floor(), 5, 5, false));
  });

  it("darkens the corners of the ground at the foot of a wall, and more where two walls meet", () => {
    const chunk = floor();
    // A wall along x = 6, and another along z = 6, meeting at the corner (6, 6).
    for (let i = 0; i < 16; i++) {
      chunk.blocks[voxelIndex(6, 6, i)] = stone;
      chunk.blocks[voxelIndex(i, 6, 6)] = stone;
    }
    const open = topLight(floor(), 5, 5, true)[0]!;
    const beside = topLight(chunk, 5, 2, true);
    // Two corners against the wall darker, the two away from it as open ground.
    expect(beside.filter((c) => c < open)).toHaveLength(2);
    expect(beside.filter((c) => c === open)).toHaveLength(2);
    // In the corner where the walls meet, one corner is as dark as it gets.
    const corner = topLight(chunk, 5, 5, true);
    expect(Math.min(...corner)).toBeCloseTo(open * AO_LEVELS[3], 5);
  });

  it("keeps the face count and every face's four corners", () => {
    const chunk = floor();
    chunk.blocks[voxelIndex(6, 6, 6)] = stone;
    const plain = meshChunk(storeWith(chunk), registry, [0, 0, 0]);
    const shaded = meshChunk(storeWith(chunk), registry, [0, 0, 0], { ao: true });
    expect(shaded.faceCount).toBe(plain.faceCount);
    expect(shaded.positions.length).toBe(plain.positions.length);
  });
});
