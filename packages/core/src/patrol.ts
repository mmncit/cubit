import type { GameSystem } from "./simulation";

/**
 * A walking route for a non-player entity, kept in `entity.data.patrol` so it is
 * saved and sent like any other state.
 */
export interface Patrol {
  /** Points to walk between, as [x, z], in order, looping. */
  route: [number, number][];
  /** The point being walked to. */
  index: number;
  /** Ticks to stand at each point. */
  pause?: number;
  /** Ticks stood so far at the current point. */
  waited?: number;
  /** 0 to 1, how fast to walk. Defaults to 0.6. */
  pace?: number;
  /** Stand still, for example while talking to someone. */
  halted?: boolean;
}

/** Steers every walker that has `data.patrol` along its route. */
export const patrolSystem: GameSystem = ({ sim }) => {
  for (const entity of sim.state.entities.values()) {
    const patrol = entity.data.patrol as unknown as Patrol | undefined;
    if (!patrol || entity.controller !== "walker" || patrol.route.length === 0) continue;
    const stop = () => (entity.input = { forward: 0, strafe: 0, jump: false, sprint: false });
    if (patrol.halted) {
      stop();
      continue;
    }
    const [tx, tz] = patrol.route[patrol.index % patrol.route.length]!;
    const dx = tx - entity.position[0];
    const dz = tz - entity.position[2];
    if (Math.hypot(dx, dz) < 0.6) {
      stop();
      patrol.waited = (patrol.waited ?? 0) + 1;
      if (patrol.waited >= (patrol.pause ?? 0)) {
        patrol.waited = 0;
        patrol.index = (patrol.index + 1) % patrol.route.length;
      }
      continue;
    }
    entity.yaw = Math.atan2(-dx, -dz);
    entity.input = { forward: patrol.pace ?? 0.6, strafe: 0, jump: false, sprint: false };
  }
};
