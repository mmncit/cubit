import { describe, expect, it } from "vitest";
import { getBlock, Simulation, type Command } from "../src";
import { flatGenerator, flatSim, makeRegistry, terrain } from "./helpers";

function withPlayer(sim: Simulation, position: [number, number, number] = [0.5, 10, 0.5]) {
  sim.preload(position, 1);
  return sim.addEntity({ id: "p1", kind: "player", controller: "walker", position });
}

describe("determinism", () => {
  it("gives the same state for the same seed and the same commands", () => {
    const script: [number, Command][] = [
      [0, { type: "input", forward: 1, strafe: 0, jump: false, yaw: 0.3, pitch: 0 }],
      [20, { type: "input", forward: 1, strafe: 0.5, jump: true, yaw: 0.3, pitch: 0 }],
      [40, { type: "setBlock", position: [1, 20, -2], block: "stone" }],
      [60, { type: "input", forward: 0, strafe: 0, jump: false, yaw: 1, pitch: 0 }],
    ];
    const run = () => {
      const sim = new Simulation({ registry: makeRegistry(), generator: terrain(), seed: 7, loadRadius: 1 });
      sim.preload([0, 0, 0], 1);
      const y = sim.findSurfaceY(0.5, 0.5)!;
      sim.addEntity({ id: "p1", kind: "player", controller: "walker", position: [0.5, y, 0.5] });
      for (let tick = 0; tick < 120; tick++) {
        for (const [at, command] of script) if (at === tick) sim.enqueue("p1", command);
        sim.step();
      }
      return sim.snapshot({ include: "all" });
    };
    expect(run()).toEqual(run());
  });
});

describe("physics", () => {
  it("keeps a player standing on the ground", () => {
    const sim = flatSim(9);
    const player = withPlayer(sim, [0.5, 10, 0.5]);
    for (let i = 0; i < 300; i++) sim.step();
    expect(player.onGround).toBe(true);
    expect(player.position[1]).toBeCloseTo(10, 3);
  });

  it("lands a falling player on the ground", () => {
    const sim = flatSim(9);
    const player = withPlayer(sim, [0.5, 25, 0.5]);
    for (let i = 0; i < 240; i++) sim.step();
    expect(player.onGround).toBe(true);
    expect(player.position[1]).toBeCloseTo(10, 3);
  });

  it("stops a walking player at a wall", () => {
    const sim = flatSim(9);
    const player = withPlayer(sim, [0.5, 10, 0.5]);
    sim.step();
    // Wall two blocks tall at x = 3.
    for (const y of [10, 11]) {
      for (let z = -2; z <= 2; z++) sim.enqueue("p1", { type: "setBlock", position: [3, y, z], block: "stone" });
    }
    // yaw -PI/2 faces +x.
    sim.enqueue("p1", { type: "input", forward: 1, strafe: 0, jump: false, yaw: -Math.PI / 2, pitch: 0 });
    for (let i = 0; i < 180; i++) sim.step();
    expect(player.position[0]).toBeLessThan(3 - 0.3 + 1e-3);
    expect(player.position[0]).toBeGreaterThan(2.5);
  });

  it("runs faster than it walks while sprint is held", () => {
    const distance = (sprint: boolean) => {
      const sim = flatSim(9);
      const player = withPlayer(sim, [0.5, 10, 0.5]);
      sim.step();
      sim.enqueue("p1", { type: "input", forward: 1, strafe: 0, jump: false, sprint, yaw: 0, pitch: 0 });
      for (let i = 0; i < 60; i++) sim.step();
      return 0.5 - player.position[2];
    };
    const walk = distance(false);
    const run = distance(true);
    expect(walk).toBeGreaterThan(3);
    expect(run / walk).toBeGreaterThan(1.4);
  });

  it("loads an entity saved before sprint existed and treats it as walking", () => {
    const sim = flatSim(9);
    const player = withPlayer(sim, [0.5, 10, 0.5]);
    delete (player.input as { sprint?: boolean }).sprint;
    player.input.forward = 1;
    for (let i = 0; i < 60; i++) sim.step();
    expect(0.5 - player.position[2]).toBeLessThan(5);
  });

  it("walks up a one-block step when stepHeight allows it, and not a two-block wall", () => {
    const climb = (stepHeight: number, wallHeight: number) => {
      const sim = new Simulation({ registry: makeRegistry(), generator: flatGenerator(9), seed: 1, loadRadius: 1, physics: { stepHeight } });
      const player = withPlayer(sim, [0.5, 10, 0.5]);
      sim.step();
      // A platform from z = -3 to -6, so a player who climbs it stays on top.
      for (let y = 10; y < 10 + wallHeight; y++) {
        for (let z = -3; z >= -6; z--) {
          for (let x = -1; x <= 1; x++) sim.enqueue("p1", { type: "setBlock", position: [x, y, z], block: "stone" });
        }
      }
      sim.enqueue("p1", { type: "input", forward: 1, strafe: 0, jump: false, yaw: 0, pitch: 0 });
      for (let i = 0; i < 50; i++) sim.step();
      return player.position;
    };
    const stepped = climb(1, 1);
    expect(stepped[1]).toBeCloseTo(11, 2);
    expect(stepped[2]).toBeLessThan(-3);
    expect(climb(0, 1)[1]).toBeCloseTo(10, 2);
    const wall = climb(1, 2);
    expect(wall[1]).toBeCloseTo(10, 2);
    expect(wall[2]).toBeGreaterThan(-2.4);
  });

  it("jumps only from the ground", () => {
    const sim = flatSim(9);
    const player = withPlayer(sim, [0.5, 10, 0.5]);
    sim.step();
    sim.enqueue("p1", { type: "input", forward: 0, strafe: 0, jump: true, yaw: 0, pitch: 0 });
    let highest = 0;
    for (let i = 0; i < 60; i++) {
      sim.step();
      highest = Math.max(highest, player.position[1]);
    }
    expect(highest).toBeGreaterThan(11);
    expect(highest).toBeLessThan(12);
  });

  it("holds a player still while their chunk is not loaded", () => {
    const sim = flatSim(9);
    const player = sim.addEntity({ id: "p1", controller: "walker", position: [0.5, 10, 0.5] });
    sim.step();
    expect(player.position).toEqual([0.5, 10, 0.5]);
  });
});

describe("setBlock", () => {
  const setup = () => {
    const sim = flatSim(9);
    withPlayer(sim);
    sim.step();
    return sim;
  };
  const place = (sim: Simulation, position: [number, number, number], block = "stone") => {
    sim.enqueue("p1", { type: "setBlock", position, block });
    return sim.step();
  };

  it("places and removes blocks and reports the change", () => {
    const sim = setup();
    const events = place(sim, [2, 10, 0]);
    expect(events).toContainEqual({ type: "blockChanged", position: [2, 10, 0], from: 0, to: sim.registry.id("stone") });
    place(sim, [2, 10, 0], "air");
    expect(getBlock(sim.state, 2, 10, 0)).toBe(0);
  });

  it("rejects a block inside a player", () => {
    const events = place(setup(), [0, 10, 0]);
    expect(events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "Something is in the way." }));
  });

  it("rejects an unknown block, a fractional position, and anything out of reach", () => {
    const sim = setup();
    expect(place(sim, [2, 10, 0], "lava")).toContainEqual(expect.objectContaining({ type: "rejected" }));
    expect(place(sim, [2.5, 10, 0])).toContainEqual(expect.objectContaining({ type: "rejected" }));
    expect(place(sim, [12, 10, 0])).toContainEqual(expect.objectContaining({ reason: "Too far away." }));
  });

  it("rejects commands from an entity that does not exist", () => {
    const sim = setup();
    sim.enqueue("ghost", { type: "setBlock", position: [2, 10, 0], block: "stone" });
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: "rejected", actor: "ghost" }));
  });
});
