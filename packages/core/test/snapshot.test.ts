import { describe, expect, it } from "vitest";
import { decodeSnapshotBinary, encodeSnapshotBinary, restoreSnapshot, Simulation } from "../src";
import { makeRegistry, terrain } from "./helpers";

function playedSim() {
  const registry = makeRegistry();
  const sim = new Simulation({ registry, generator: terrain(), seed: 42, loadRadius: 1 });
  sim.preload([0, 0, 0], 1);
  const y = sim.findSurfaceY(0.5, 0.5)!;
  sim.addEntity({ id: "p1", kind: "player", controller: "walker", position: [0.5, y, 0.5], data: { name: "Hanan" } });
  sim.step();
  sim.enqueue("p1", { type: "setBlock", position: [2, y, 0], block: "stone" });
  sim.enqueue("p1", { type: "setBlock", position: [0, y - 1, 2], block: "air" });
  for (let i = 0; i < 10; i++) sim.step();
  return { sim, registry };
}

describe("snapshots", () => {
  it("survive JSON.stringify and JSON.parse unchanged", () => {
    const { sim } = playedSim();
    const snapshot = sim.snapshot({ include: "all" });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("survive the binary encoding unchanged", () => {
    const { sim, registry } = playedSim();
    const snapshot = sim.snapshot({ include: "all" });
    const bytes = encodeSnapshotBinary(snapshot);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decodeSnapshotBinary(bytes, registry)).toEqual(snapshot);
  });

  it("store only changed chunks by default", () => {
    const { sim } = playedSim();
    const all = sim.snapshot({ include: "all" });
    const modified = sim.snapshot();
    expect(modified.chunks.length).toBeGreaterThan(0);
    expect(modified.chunks.length).toBeLessThan(all.chunks.length);
  });

  it("restore a game that regenerates everything it did not store", () => {
    const { sim, registry } = playedSim();
    const saved = JSON.parse(JSON.stringify(sim.snapshot()));

    const fresh = new Simulation({ registry, generator: terrain(), seed: 999, loadRadius: 1 });
    fresh.load(saved);
    for (let i = 0; i < 20; i++) fresh.step();
    for (let i = 0; i < 20; i++) sim.step();

    // Same chunks, same blocks, whether they came from the save or from the seed.
    const a = sim.snapshot({ include: "all" });
    const b = fresh.snapshot({ include: "all" });
    expect(b.seed).toBe(42);
    expect(b.chunks).toEqual(a.chunks);
    expect(b.entities.find((e) => e.id === "p1")?.data).toEqual({ name: "Hanan" });
  });

  it("reject snapshots from another format or version", () => {
    const { sim, registry } = playedSim();
    const snapshot = sim.snapshot();
    expect(() => restoreSnapshot({ ...snapshot, version: 99 }, registry)).toThrow(/version 99/);
    expect(() => restoreSnapshot({ ...snapshot, format: "other" } as never, registry)).toThrow(/not a cubit snapshot/);
  });
});
