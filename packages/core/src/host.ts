import { encodeChunkBase64 } from "./codec";
import { parseChunkKey } from "./chunk";
import type { EntityInit } from "./entity";
import { cloneJson } from "./json";
import type { ClientMessage, Connection, ServerMessage } from "./protocol";
import type { Simulation, SimEvent } from "./simulation";
import type { Snapshot } from "./snapshot";

export interface LocalHostOptions {
  /**
   * Pass every message through JSON.stringify and JSON.parse in both
   * directions, exactly as a network would. On by default, so anything that
   * is not serializable fails in single player long before multiplayer.
   */
  strict?: boolean;
  /** Most simulation steps per advance() call, so a stalled tab does not spiral. */
  maxStepsPerAdvance?: number;
}

export interface ConnectOptions {
  onMessage(message: ServerMessage): void;
  /** Initial fields for this client's player entity. The id is assigned by the host. */
  spawn?: Omit<EntityInit, "id">;
}

interface Client {
  playerId: string;
  /** False until the client has been sent the full state. */
  synced: boolean;
  deliver(message: ServerMessage): void;
}

/**
 * Runs a simulation in-process and talks to clients through the same messages
 * a network server would send. Single player is this host with one client.
 */
export class LocalHost {
  readonly sim: Simulation;
  private readonly strict: boolean;
  private readonly maxSteps: number;
  private readonly clients = new Map<string, Client>();
  private accumulator = 0;
  private nextId = 1;

  constructor(sim: Simulation, options: LocalHostOptions = {}) {
    this.sim = sim;
    this.strict = options.strict ?? true;
    this.maxSteps = options.maxStepsPerAdvance ?? 5;
  }

  connect(options: ConnectOptions): Connection {
    const playerId = `player-${this.nextId++}`;
    const strict = this.strict;
    const client: Client = {
      playerId,
      synced: false,
      deliver: (message) => options.onMessage(strict ? (JSON.parse(JSON.stringify(message)) as ServerMessage) : message),
    };
    this.clients.set(playerId, client);

    const spawn = options.spawn ?? {};
    const position = spawn.position ?? [0.5, 0, 0.5];
    this.sim.preload(position);
    const entity = this.sim.addEntity({ kind: "player", controller: "walker", ...spawn, id: playerId });
    if (!spawn.position) {
      const y = this.sim.findSurfaceY(position[0], position[2]);
      entity.position = [position[0], y ?? 0, position[2]];
    }
    // The full state goes out on the next tick, so the chunks preloaded above
    // are not also sent a second time as individual chunk messages.

    return {
      playerId,
      send: (message: ClientMessage) => {
        const received = strict ? (JSON.parse(JSON.stringify(message)) as ClientMessage) : message;
        if (received.type === "command") this.sim.enqueue(playerId, received.command);
      },
      close: () => {
        this.clients.delete(playerId);
        this.sim.removeEntity(playerId);
      },
    };
  }

  /**
   * Advances real time by `dtSeconds`, running as many fixed ticks as fit.
   * Returns how far into the next tick we are, from 0 to 1, for interpolation.
   */
  advance(dtSeconds: number): number {
    const dt = this.sim.dt;
    this.accumulator += Math.max(0, dtSeconds);
    let steps = 0;
    while (this.accumulator >= dt && steps < this.maxSteps) {
      this.tick();
      this.accumulator -= dt;
      steps++;
    }
    if (steps === this.maxSteps) this.accumulator = Math.min(this.accumulator, dt);
    return this.accumulator / dt;
  }

  /** Runs exactly one tick and delivers its messages. */
  tick(): void {
    const events = this.sim.step();
    const messages = this.translate(events);
    messages.push({ type: "entities", tick: this.sim.state.tick, entities: cloneJson([...this.sim.state.entities.values()]) });
    for (const client of this.clients.values()) {
      if (!client.synced) {
        this.welcome(client);
        client.synced = true;
        continue;
      }
      for (const message of messages) client.deliver(message);
    }
    for (const event of events) {
      if (event.type !== "rejected") continue;
      this.clients.get(event.actor)?.deliver({ type: "rejected", command: event.command, reason: event.reason });
    }
  }

  /** Replaces the game with a saved one. Every client is sent the new state on the next tick. */
  load(snapshot: Snapshot): void {
    this.sim.load(snapshot);
    for (const client of this.clients.values()) {
      if (!this.sim.state.entities.has(client.playerId)) {
        this.sim.addEntity({ kind: "player", controller: "walker", id: client.playerId });
      }
      client.synced = false;
    }
  }

  private welcome(client: Client): void {
    const { sim } = this;
    client.deliver({ type: "reset" });
    client.deliver({ type: "welcome", playerId: client.playerId, tick: sim.state.tick, tickRate: sim.tickRate });
    for (const chunk of sim.state.chunks.values()) {
      client.deliver({ type: "chunk", coords: [...chunk.coords], data: encodeChunkBase64(chunk, sim.registry) });
    }
    client.deliver({ type: "entities", tick: sim.state.tick, entities: cloneJson([...sim.state.entities.values()]) });
  }

  private translate(events: SimEvent[]): ServerMessage[] {
    const { sim } = this;
    const messages: ServerMessage[] = [];
    for (const event of events) {
      switch (event.type) {
        case "chunkLoaded": {
          const chunk = sim.state.chunks.get(event.key);
          if (chunk) {
            messages.push({ type: "chunk", coords: parseChunkKey(event.key), data: encodeChunkBase64(chunk, sim.registry) });
          }
          break;
        }
        case "blockChanged":
          messages.push({ type: "blockChanged", position: event.position, block: sim.registry.name(event.to) });
          break;
        case "entityRemoved":
          messages.push({ type: "entityRemoved", id: event.id });
          break;
        case "entityAdded":
        case "rejected":
          break;
      }
    }
    return messages;
  }
}
