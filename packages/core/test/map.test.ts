import { describe, expect, it } from "vitest";
import {
  BlockRegistry,
  createFlatGenerator,
  createMapGenerator,
  decodeVoxelMap,
  defineMapBlocks,
  encodeVoxelMap,
  getBlock,
  Simulation,
  type Vec3,
} from "../src";

// An asymmetric fixture: the block name encodes its own coordinates' parity,
// so any mix-up of axis order or sign shows up as a wrong name.
const origin: Vec3 = [-5, 2, -20];
const size: Vec3 = [7, 3, 11];
const nameAt = (x: number, y: number, z: number) =>
  y === 2 ? "stone" : x === -3 && z === -12 ? "marker" : y === 3 && (x + z) % 3 === 0 ? "dirt" : "air";

function registry() {
  const r = new BlockRegistry();
  for (const name of ["stone", "dirt", "marker", "grass"]) r.define({ name });
  return r;
}

describe("voxel maps", () => {
  it("round-trip through JSON and decode to the same cells", () => {
    const map = encodeVoxelMap(origin, size, nameAt);
    const again = JSON.parse(JSON.stringify(map));
    const decoded = decodeVoxelMap(again);
    expect(decoded.cells.length).toBe(7 * 3 * 11);
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 11; z++)
        for (let x = 0; x < 7; x++) {
          const cell = decoded.cells[x + z * 7 + y * 7 * 11]!;
          expect(decoded.palette[cell]).toBe(nameAt(origin[0] + x, origin[1] + y, origin[2] + z));
        }
  });

  it("put each block at its own world coordinate through the generator", () => {
    const reg = registry();
    const generator = createMapGenerator(encodeVoxelMap(origin, size, nameAt));
    const sim = new Simulation({ registry: reg, generator, seed: 0, loadRadius: 2 });
    sim.preload([-3, 3, -12], 2);
    expect(reg.name(getBlock(sim.state, -3, 3, -12)!)).toBe("marker");
    expect(reg.name(getBlock(sim.state, -5, 2, -20)!)).toBe("stone");
    expect(reg.name(getBlock(sim.state, 1, 2, -10)!)).toBe("stone");
    expect(reg.name(getBlock(sim.state, -3, 4, -12)!)).toBe("marker");
    expect(getBlock(sim.state, -3, 5, -12)).toBe(0);
    for (let z = origin[2]; z < origin[2] + size[2]; z++)
      for (let x = origin[0]; x < origin[0] + size[0]; x++)
        expect(reg.name(getBlock(sim.state, x, 3, z)!)).toBe(nameAt(x, 3, z));
  });

  it("fill outside the box from another generator", () => {
    const reg = registry();
    const generator = createMapGenerator(encodeVoxelMap(origin, size, nameAt), {
      outside: createFlatGenerator({ surface: "grass", height: 1 }),
    });
    const sim = new Simulation({ registry: reg, generator, seed: 0, loadRadius: 2 });
    sim.preload([-3, 3, -12], 2);
    expect(reg.name(getBlock(sim.state, 20, 1, 20)!)).toBe("grass");
    expect(getBlock(sim.state, 20, 2, 20)).toBe(0);
    // Inside the box the map wins, air included.
    expect(getBlock(sim.state, -3, 1, -12)).toBe(reg.id("grass"));
    expect(reg.name(getBlock(sim.state, -3, 2, -12)!)).toBe("stone");
  });

  it("can bring its own block definitions", () => {
    const map = encodeVoxelMap(origin, size, nameAt, [{ name: "marker", color: 0xff0000, solid: false }]);
    const reg = new BlockRegistry();
    defineMapBlocks(reg, JSON.parse(JSON.stringify(map)));
    expect(reg.isSolid(reg.id("marker"))).toBe(false);
  });

  it("refuses a map that uses a block the game does not define", () => {
    const reg = new BlockRegistry();
    reg.define({ name: "stone" });
    const generator = createMapGenerator(encodeVoxelMap(origin, size, nameAt));
    expect(() => generator.generate([-1, 0, -2], reg, 0)).toThrow(/marker|dirt/);
  });

  it("rejects truncated data and unknown versions", () => {
    const map = encodeVoxelMap(origin, size, nameAt);
    expect(() => decodeVoxelMap({ ...map, version: 2 })).toThrow(/version 2/);
    expect(() => decodeVoxelMap({ ...map, size: [7, 3, 12] })).toThrow(/expected/);
  });
});
