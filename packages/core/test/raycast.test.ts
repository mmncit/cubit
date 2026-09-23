import { describe, expect, it } from "vitest";
import { raycast, viewDirection } from "../src";
import { flatSim } from "./helpers";

describe("raycast", () => {
  it("finds the block below and the face it hit", () => {
    const sim = flatSim(9);
    sim.preload([0, 0, 0], 1);
    const hit = raycast(sim.state, [0.5, 12, 0.5], [0, -1, 0], 10);
    expect(hit?.position).toEqual([0, 9, 0]);
    expect(hit?.normal).toEqual([0, 1, 0]);
    expect(hit?.distance).toBeCloseTo(2, 5);
  });

  it("returns null when nothing is in range", () => {
    const sim = flatSim(9);
    sim.preload([0, 0, 0], 1);
    expect(raycast(sim.state, [0.5, 12, 0.5], [0, 1, 0], 3)).toBeNull();
  });

  it("agrees with viewDirection about which way is forward", () => {
    expect(viewDirection(0, 0)[2]).toBeCloseTo(-1);
    expect(viewDirection(-Math.PI / 2, 0)[0]).toBeCloseTo(1);
    expect(viewDirection(0, Math.PI / 2)[1]).toBeCloseTo(1);
  });
});
