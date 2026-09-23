import { describe, expect, it } from "vitest";
import {
  canSee,
  ClientWorld,
  encodeChunk,
  getBlock,
  LocalHost,
  patrolSystem,
  Simulation,
  writeBlock,
  type GameAction,
  type GameSystem,
  type Patrol,
} from "../src";
import { flatGenerator, makeRegistry } from "./helpers";

function sim(systems: GameSystem[] = [], actions: Record<string, GameAction> = {}) {
  const s = new Simulation({ registry: makeRegistry(), generator: flatGenerator(9), seed: 1, loadRadius: 1, systems, actions });
  s.preload([0.5, 10, 0.5], 1);
  return s;
}

describe("game systems", () => {
  it("run after the tick's commands, so a system can hold a player still", () => {
    const hold: GameSystem = ({ sim }) => {
      const p = sim.state.entities.get("p1");
      if (p?.data.frozen) p.input = { forward: 0, strafe: 0, jump: false };
    };
    const s = sim([hold]);
    const player = s.addEntity({ id: "p1", controller: "walker", position: [0.5, 10, 0.5], data: { frozen: true } });
    for (let i = 0; i < 60; i++) {
      s.enqueue("p1", { type: "input", forward: 1, strafe: 0, jump: false, yaw: 0, pitch: 0 });
      s.step();
    }
    expect(player.position[2]).toBeCloseTo(0.5, 3);
  });

  it("place blocks that clients see, and refuse a cell someone stands in", () => {
    let wall = false;
    const closeGate: GameSystem = ({ setBlock }) => {
      if (!wall) return;
      setBlock([3, 10, 0], "stone");
      setBlock([0, 10, 0], "stone"); // the player is here
    };
    const s = sim([closeGate]);
    const host = new LocalHost(s);
    const client = new ClientWorld(makeRegistry("reversed"));
    const connection = host.connect({ onMessage: (m) => client.apply(m), spawn: { position: [0.5, 10, 0.5] } });
    host.tick();
    wall = true;
    host.tick();
    expect(getBlock(s.state, 3, 10, 0)).toBe(s.registry.id("stone"));
    expect(getBlock(s.state, 0, 10, 0)).toBe(0);
    const clientRegistry = makeRegistry("reversed");
    for (const [key, chunk] of s.state.chunks) {
      expect(encodeChunk(client.chunks.get(key)!, clientRegistry)).toEqual(encodeChunk(chunk, s.registry));
    }
    expect(connection.playerId).toBeTruthy();
  });
});

describe("act commands", () => {
  const greet: GameAction = ({ actor, payload }) => {
    if (payload !== "hello") return "Say hello.";
    actor.data.greeted = true;
    return null;
  };

  it("reach the handler registered for the action, with the actor", () => {
    const s = sim([], { greet });
    const p = s.addEntity({ id: "p1", controller: "walker", position: [0.5, 10, 0.5] });
    s.enqueue("p1", { type: "act", action: "greet", payload: "hello" });
    expect(s.step().filter((e) => e.type === "rejected")).toEqual([]);
    expect(p.data.greeted).toBe(true);
  });

  it("are rejected when the handler says no, or when no handler exists", () => {
    const s = sim([], { greet });
    s.addEntity({ id: "p1", controller: "walker", position: [0.5, 10, 0.5] });
    s.enqueue("p1", { type: "act", action: "greet", payload: "bye" });
    s.enqueue("p1", { type: "act", action: "toString" });
    const reasons = s.step().flatMap((e) => (e.type === "rejected" ? [e.reason] : []));
    expect(reasons).toEqual(["Say hello.", 'Unknown action "toString".']);
  });
});

describe("sight", () => {
  it("sees a target in the open and not one behind cover, even cover you can walk through", () => {
    const s = sim();
    const eye: [number, number, number] = [0.5, 11.6, 0.5];
    const target: [number, number, number] = [0.5, 11, -8.5];
    expect(canSee(s.state, eye, 0, target, { range: 20, fov: Math.PI / 2 })).toBe(true);
    const crop = s.registry.id("leaves"); // not solid for this purpose, still blocks the view
    writeBlock(s.state, 0, 11, -5, crop);
    expect(canSee(s.state, eye, 0, target, { range: 20, fov: Math.PI / 2 })).toBe(false);
  });

  it("does not see what is behind it or out of range", () => {
    const s = sim();
    const eye: [number, number, number] = [0.5, 11.6, 0.5];
    expect(canSee(s.state, eye, 0, [0.5, 11, 8.5], { range: 20, fov: Math.PI / 2 })).toBe(false);
    expect(canSee(s.state, eye, 0, [0.5, 11, -30], { range: 20, fov: Math.PI / 2 })).toBe(false);
  });
});

describe("patrols", () => {
  it("walk the route in order, pause at each point, and stop when halted", () => {
    const s = sim([patrolSystem]);
    const patrol: Patrol = { route: [[0.5, -4.5], [4.5, -4.5]], index: 0, pause: 10 };
    const guard = s.addEntity({ id: "g", controller: "walker", position: [0.5, 10, 0.5], data: { patrol: patrol as never } });
    for (let i = 0; i < 180; i++) s.step();
    const p = guard.data.patrol as unknown as Patrol;
    expect(p.index).toBe(1);
    // Walk on until it has paused at the second point and turned back towards the first.
    let ticks = 0;
    while ((guard.data.patrol as unknown as Patrol).index === 1 && ticks++ < 600) s.step();
    expect(ticks).toBeLessThan(600);
    expect(Math.hypot(guard.position[0] - 4.5, guard.position[2] + 4.5)).toBeLessThan(1);
    (guard.data.patrol as unknown as Patrol).halted = true;
    s.step();
    const at = [...guard.position];
    for (let i = 0; i < 60; i++) s.step();
    expect(Math.hypot(guard.position[0] - at[0]!, guard.position[2] - at[2]!)).toBeLessThan(0.3);
  });

  it("keep their state in plain data that survives a snapshot", () => {
    const s = sim([patrolSystem]);
    s.addEntity({ id: "g", controller: "walker", position: [0.5, 10, 0.5], data: { patrol: { route: [[0.5, -4.5]], index: 0 } } });
    for (let i = 0; i < 30; i++) s.step();
    const snap = s.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});
