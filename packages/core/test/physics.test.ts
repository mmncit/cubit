import { describe, expect, it } from "vitest";
import {
  approach, BlockRegistry, CHUNK_SIZE, createChunk, createEntity, DEFAULT_PHYSICS, fall, immersion, Simulation, voxelIndex,
  type GameSystem, type WorldGenerator,
} from "../src";

/** Stone up to y = 5, then a pool of water up to y = 12 for x below 8, and air; a stone bank of the same height beyond. */
function poolWorld(): { registry: BlockRegistry; generator: WorldGenerator } {
  const registry = new BlockRegistry();
  registry.define({ name: "stone", color: 0x808080 });
  registry.define({ name: "water", color: 0x3366aa, liquid: true });
  const generator: WorldGenerator = {
    verticalRange: [0, 1],
    generate([cx, cy, cz], reg) {
      const chunk = createChunk(cx, cy, cz);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const y = cy * CHUNK_SIZE + ly;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const x = cx * CHUNK_SIZE + lx;
            const block = y <= 5 ? "stone" : y <= 12 ? (x < 8 ? "water" : "stone") : null;
            if (block) chunk.blocks[voxelIndex(lx, ly, lz)] = reg.id(block);
          }
        }
      }
      return chunk;
    },
  };
  return { registry, generator };
}

function pool(systems: GameSystem[] = []) {
  const { registry, generator } = poolWorld();
  const sim = new Simulation({ registry, generator, seed: 1, loadRadius: 1, systems });
  sim.preload([0, 8, 0], 1);
  return sim;
}

describe("water", () => {
  it("breaks a fall: a walker dropped into deep water slows to a sink and reports no landing", () => {
    const landings: number[] = [];
    const sim = pool([({ landings: l }) => void (l.has("p") && landings.push(l.get("p")!))]);
    const p = sim.addEntity({ id: "p", kind: "player", controller: "walker", position: [3.5, 22, 3.5] });
    let fastest = 0;
    for (let i = 0; i < 60 * 12; i++) {
      sim.step();
      if (p.position[1] < 11) fastest = Math.max(fastest, -p.velocity[1]);
    }
    // Deep in the pool, the fall has become a slow sink, and it settled on the floor without a landing.
    expect(-p.velocity[1]).toBeLessThan(1);
    expect(p.position[1]).toBeCloseTo(6, 1);
    expect(landings).toEqual([]);
    expect(fastest).toBeLessThan(14);
  });

  it("lets a walker swim: slower across than on land, and up when jump is held", () => {
    const sim = pool();
    const p = sim.addEntity({ id: "p", kind: "player", controller: "walker", position: [3.5, 7, 3.5] });
    sim.enqueue("p", { type: "input", forward: 0, strafe: 0, jump: true, yaw: 0, pitch: 0 });
    for (let i = 0; i < 60; i++) sim.step();
    expect(p.velocity[1]).toBeGreaterThan(1);
    expect(p.velocity[1]).toBeLessThanOrEqual(DEFAULT_PHYSICS.swimUpSpeed + 1e-9);
    // Across the pool at a swim.
    p.position = [3.5, 8, 6.5];
    p.velocity = [0, 0, 0];
    sim.enqueue("p", { type: "input", forward: 1, strafe: 0, jump: false, yaw: 0, pitch: 0 });
    for (let i = 0; i < 60; i++) sim.step();
    expect(Math.hypot(p.velocity[0], p.velocity[2])).toBeLessThanOrEqual(DEFAULT_PHYSICS.swimSpeed + 1e-6);
    expect(Math.hypot(p.velocity[0], p.velocity[2])).toBeGreaterThan(DEFAULT_PHYSICS.swimSpeed * 0.8);
  });

  it("lets a swimmer at the surface climb out onto a bank by swimming at it with jump held", () => {
    const sim = pool();
    // Treading water just under the surface, beside the bank at x = 8.
    const p = sim.addEntity({ id: "p", kind: "player", controller: "walker", position: [6.5, 11.6, 3.5] });
    const east = -Math.PI / 2;
    sim.enqueue("p", { type: "input", forward: 1, strafe: 0, jump: true, yaw: east, pitch: 0 });
    for (let i = 0; i < 60 * 3 && !(p.onGround && p.position[0] > 8); i++) sim.step();
    expect(p.position[0]).toBeGreaterThan(8);
    expect(p.position[1]).toBeCloseTo(13, 1);
    expect(immersion(sim.state, sim.registry, p)).toBe(0);
  });

  it("measures how deep a body is, by thirds", () => {
    const sim = pool();
    const p = createEntity({ id: "q", controller: "walker", position: [3.5, 6, 3.5] });
    expect(immersion(sim.state, sim.registry, p)).toBe(1);
    p.position = [3.5, 12.2, 3.5];
    expect(immersion(sim.state, sim.registry, p)).toBeCloseTo(1 / 3, 5);
    p.position = [3.5, 14, 3.5];
    expect(immersion(sim.state, sim.registry, p)).toBe(0);
  });
});

describe("falling through air", () => {
  it("builds towards terminal velocity smoothly and never passes it", () => {
    let v = 0;
    const speeds: number[] = [];
    for (let i = 0; i < 60 * 6; i++) {
      v = fall(v, 1 / 60, 0, DEFAULT_PHYSICS);
      speeds.push(-v);
    }
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]!).toBeGreaterThanOrEqual(speeds[i - 1]!);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(DEFAULT_PHYSICS.terminalVelocity);
    // Close to the limit after a few seconds, as drag that grows with the square of the speed gives.
    expect(speeds.at(-1)!).toBeGreaterThan(DEFAULT_PHYSICS.terminalVelocity * 0.95);
    // Nearly a free fall at first, but drag already tells by a second and a half; a hard clamp would not slow it yet.
    expect(speeds[59]!).toBeGreaterThan(DEFAULT_PHYSICS.gravity * 0.85);
    expect(speeds[89]!).toBeLessThan(DEFAULT_PHYSICS.gravity * 1.5 * 0.9);
  });
});

describe("moving at any tick rate", () => {
  it("reaches the same speed whatever the tick rate, since the approach is exact", () => {
    const after = (dt: number, seconds: number) => {
      let v = 0;
      for (let t = 0; t < seconds - 1e-9; t += dt) v += (4.8 - v) * approach(DEFAULT_PHYSICS.acceleration, dt);
      return v;
    };
    expect(after(1 / 30, 0.2)).toBeCloseTo(after(1 / 120, 0.2), 6);
    expect(after(1 / 60, 0.2)).toBeCloseTo(after(1 / 240, 0.2), 6);
  });

  it("walks on dry land as before: a walker reaches its walking speed", () => {
    const { registry, generator } = poolWorld();
    const sim = new Simulation({ registry, generator, seed: 1, loadRadius: 1 });
    sim.preload([12, 14, 3], 1);
    const p = sim.addEntity({ id: "p", kind: "player", controller: "walker", position: [12.5, 13, 3.5] });
    sim.step();
    sim.enqueue("p", { type: "input", forward: 0, strafe: 1, jump: false, yaw: 0, pitch: 0 });
    for (let i = 0; i < 40; i++) sim.step();
    expect(Math.hypot(p.velocity[0], p.velocity[2])).toBeCloseTo(DEFAULT_PHYSICS.walkSpeed, 1);
  });
});
