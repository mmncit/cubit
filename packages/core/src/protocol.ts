import type { Command } from "./commands";
import type { Entity } from "./entity";
import type { Vec3 } from "./math";

/**
 * Messages from the host to a client. Every field is JSON-safe: blocks travel
 * by name and chunk contents as base64 codec bytes, so the same messages work
 * in a tab, over a WebSocket, or from a file.
 */
export type ServerMessage =
  | { type: "welcome"; playerId: string; tick: number; tickRate: number }
  | { type: "reset" }
  | { type: "chunk"; coords: Vec3; data: string }
  | { type: "blockChanged"; position: Vec3; block: string }
  | { type: "entities"; tick: number; entities: Entity[] }
  | { type: "entityRemoved"; id: string }
  | { type: "rejected"; command: string; reason: string };

export type ClientMessage = { type: "command"; command: Command };

/** One client's end of a connection to a host. */
export interface Connection {
  readonly playerId: string;
  send(message: ClientMessage): void;
  close(): void;
}
