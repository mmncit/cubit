import type { Vec3 } from "./math";

/**
 * Every change a player can ask for. Commands are plain data so they can be
 * logged, replayed and sent over a network, and every mutation of game state
 * goes through one: nothing else writes to the world.
 */
export type Command =
  | {
      type: "input";
      forward: number;
      strafe: number;
      jump: boolean;
      sprint?: boolean;
      yaw: number;
      pitch: number;
    }
  | {
      type: "setBlock";
      position: Vec3;
      /** Block name. "air" removes the block. */
      block: string;
    };

/** A command stamped with the entity that issued it. The host sets `actor`, never the client. */
export interface IssuedCommand {
  actor: string;
  command: Command;
}
