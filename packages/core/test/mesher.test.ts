import { describe, expect, it } from "vitest";
import { chunkKey, createChunk, meshChunk, voxelIndex, type ChunkData, type ChunkStore } from "../src";
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
