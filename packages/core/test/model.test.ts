import { describe, expect, it } from "vitest";
import { glowCentre, meshModel, validateModel, type VoxelModel } from "../src";

const model = (size: [number, number, number], voxels: number[], palette = [0xff0000, 0x00ff00]): VoxelModel => ({
  size, scale: 1 / 16, palette, voxels,
});

describe("meshModel", () => {
  it("gives a lone voxel six faces", () => {
    expect(meshModel(model([1, 1, 1], [1])).faceCount).toBe(6);
  });

  it("hides the faces between touching voxels, whatever their colours", () => {
    expect(meshModel(model([2, 1, 1], [1, 2])).faceCount).toBe(10);
    // Along z and y too, which is where a wrong index order shows.
    expect(meshModel(model([1, 1, 2], [1, 2])).faceCount).toBe(10);
    expect(meshModel(model([1, 2, 1], [1, 1])).faceCount).toBe(10);
  });

  it("leaves empty voxels out", () => {
    expect(meshModel(model([3, 1, 1], [1, 0, 1])).faceCount).toBe(12);
  });

  it("stands on the centre of its base, in blocks", () => {
    const mesh = meshModel(model([4, 2, 6], new Array(48).fill(1)));
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      xs.push(mesh.positions[i]!); ys.push(mesh.positions[i + 1]!); zs.push(mesh.positions[i + 2]!);
    }
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-2 / 16, 2 / 16]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([0, 2 / 16]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([-3 / 16, 3 / 16]);
  });

  it("reads voxels x first, then z, then y", () => {
    // Size 1 x 2 x 2: index 1 is (0, 0, 1), index 2 is (0, 1, 0).
    const mesh = meshModel({ size: [1, 2, 2], scale: 1, palette: [0xff0000, 0x0000ff], voxels: [0, 0, 2, 0] });
    const ys = new Set<number>(), zs = new Set<number>();
    for (let i = 0; i < mesh.positions.length; i += 3) { ys.add(mesh.positions[i + 1]!); zs.add(mesh.positions[i + 2]!); }
    expect([...ys].sort()).toEqual([1, 2]);
    expect([...zs].sort()).toEqual([-1, 0]);
    // Blue, shaded.
    expect(mesh.colors[0]).toBe(0);
    expect(mesh.colors[2]).toBeGreaterThan(0);
  });
});

describe("validateModel", () => {
  it("rejects a voxel count that does not match the size", () => {
    expect(() => validateModel(model([2, 2, 2], [1, 1]))).toThrow(/needs 8/);
  });
  it("rejects a colour that is not in the palette", () => {
    expect(() => validateModel(model([1, 1, 1], [3]))).toThrow(/palette/);
  });
  it("round-trips through JSON", () => {
    const m = model([2, 1, 1], [1, 2]);
    const back = JSON.parse(JSON.stringify(m)) as VoxelModel;
    expect(meshModel(back).faceCount).toBe(meshModel(m).faceCount);
  });
});

describe("glowing models", () => {
  // Two voxels side by side: iron (1) on the left, lit glass (2) on the right.
  const lamp: VoxelModel = { size: [2, 1, 1], scale: 1, palette: [0x333333, 0xffcc44], voxels: [1, 2], glow: [2] };

  it("splits a model into the part that glows and the rest, culled against each other", () => {
    expect(meshModel(lamp).faceCount).toBe(10);
    expect(meshModel(lamp, { part: "glow" }).faceCount).toBe(5);
    expect(meshModel(lamp, { part: "rest" }).faceCount).toBe(5);
  });

  it("does not shade glowing faces, so the light is even on every side", () => {
    const mesh = meshModel(lamp, { part: "glow" });
    const reds = new Set<number>();
    for (let i = 0; i < mesh.colors.length; i += 3) reds.add(mesh.colors[i]!);
    expect(reds.size).toBe(1);
    const rest = meshModel(lamp, { part: "rest" });
    const shades = new Set<number>();
    for (let i = 0; i < rest.colors.length; i += 3) shades.add(rest.colors[i]!);
    expect(shades.size).toBeGreaterThan(1);
  });

  it("finds where the light is", () => {
    expect(glowCentre(lamp)).toEqual({ centre: [0.5, 0.5, 0], radius: 0.5 });
    expect(glowCentre({ ...lamp, glow: undefined })).toBeNull();
  });

  it("rejects a glow entry that is not in the palette", () => {
    expect(() => validateModel({ ...lamp, glow: [3] })).toThrow(/glow entry 3/);
  });
});
