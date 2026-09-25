import { describe, expect, it } from "vitest";
import { BlockRegistry, LIQUID_SURFACE_DROP, meshChunk, Simulation, writeBlock, type GameSystem } from "../src";
import { flatGenerator, makeRegistry } from "./helpers";

function withWater(): BlockRegistry {
  const registry = makeRegistry();
  registry.define({ name: "water", color: 0x2c5f8f, liquid: true });
  return registry;
}

describe("liquids", () => {
  it("are neither solid nor opaque unless they say so", () => {
    const registry = withWater();
    const water = registry.id("water");
    expect(registry.isLiquid(water)).toBe(true);
    expect(registry.isSolid(water)).toBe(false);
    expect(registry.isOpaque(water)).toBe(false);
    expect(registry.isLiquid(registry.id("glass"))).toBe(false);
  });

  it("mesh apart from the solid world, their open surface a little low, with no faces between water and water", () => {
    const registry = withWater();
    const sim = new Simulation({ registry, generator: flatGenerator(9), seed: 1, loadRadius: 1 });
    sim.preload([0, 10, 0], 1);
    // A pool two deep and two wide, cut into the stone.
    for (const [x, y, z] of [[1, 8, 1], [2, 8, 1], [1, 9, 1], [2, 9, 1]] as const) writeBlock(sim.state, x, y, z, registry.id("water"));
    const all = meshChunk(sim.state, registry, [0, 0, 0]);
    const solid = meshChunk(sim.state, registry, [0, 0, 0], { liquids: "skip" });
    const liquid = meshChunk(sim.state, registry, [0, 0, 0], { liquids: "only" });
    expect(solid.faceCount + liquid.faceCount).toBe(all.faceCount);
    // Only the two open top faces show: the pool's sides and floor meet stone, and water meets water inside.
    expect(liquid.faceCount).toBe(2);
    const ys = new Set<number>();
    for (let i = 1; i < liquid.positions.length; i += 3) ys.add(Math.round(liquid.positions[i]! * 1000) / 1000);
    expect([...ys]).toEqual([10 - LIQUID_SURFACE_DROP]);
  });

  it("leave a world with no liquid meshed exactly as before", () => {
    const registry = makeRegistry();
    const sim = new Simulation({ registry, generator: flatGenerator(9), seed: 1, loadRadius: 1 });
    sim.preload([0, 10, 0], 1);
    const all = meshChunk(sim.state, registry, [0, 0, 0]);
    const skip = meshChunk(sim.state, registry, [0, 0, 0], { liquids: "skip" });
    expect(skip.faceCount).toBe(all.faceCount);
    expect([...skip.positions]).toEqual([...all.positions]);
    expect(meshChunk(sim.state, registry, [0, 0, 0], { liquids: "only" }).faceCount).toBe(0);
  });
});

describe("landings", () => {
  it("tell the game systems how fast a walker was falling, the tick after it lands, and only then", () => {
    const seen: [number, number][] = [];
    const watch: GameSystem = ({ landings, tick }) => {
      const speed = landings.get("p1");
      if (speed !== undefined) seen.push([tick, speed]);
    };
    const drop = (height: number) => {
      seen.length = 0;
      const sim = new Simulation({ registry: makeRegistry(), generator: flatGenerator(9), seed: 1, loadRadius: 1, systems: [watch] });
      sim.addEntity({ id: "p1", kind: "player", controller: "walker", position: [0.5, 10 + height, 0.5] });
      for (let i = 0; i < 80; i++) sim.step();
      return [...seen];
    };
    const low = drop(1);
    const high = drop(8);
    expect(low).toHaveLength(1);
    expect(high).toHaveLength(1);
    // Falling from rest, speed is about the root of 2 g h.
    expect(high[0]![1]).toBeGreaterThan(18);
    expect(high[0]![1]).toBeLessThan(23);
    expect(low[0]![1]).toBeLessThan(9);
    // Standing still reports nothing more.
    expect(drop(0).length).toBeLessThanOrEqual(1);
  });
});
