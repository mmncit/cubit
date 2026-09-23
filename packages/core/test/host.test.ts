import { describe, expect, it } from "vitest";
import { ClientWorld, encodeChunk, getBlock, LocalHost, Simulation, type ServerMessage } from "../src";
import { makeRegistry, terrain } from "./helpers";

function setup() {
  const registry = makeRegistry();
  const sim = new Simulation({ registry, generator: terrain(), seed: 3, loadRadius: 1 });
  const host = new LocalHost(sim);
  const client = new ClientWorld(makeRegistry("reversed"));
  const received: ServerMessage[] = [];
  const connection = host.connect({
    onMessage: (message) => {
      received.push(message);
      client.apply(message);
    },
  });
  host.tick();
  return { registry, sim, host, client, connection, received };
}

describe("LocalHost and ClientWorld", () => {
  it("builds the client's world from messages alone", () => {
    const { sim, client, connection } = setup();
    expect(client.playerId).toBe(connection.playerId);
    expect(client.chunks.size).toBe(sim.state.chunks.size);
    expect(client.player()?.position).toEqual(sim.state.entities.get(connection.playerId)?.position);
  });

  it("keeps the replica block-for-block equal to the simulation after changes", () => {
    const { sim, host, client, connection, registry } = setup();
    const p = sim.state.entities.get(connection.playerId)!.position;
    const x = Math.floor(p[0]) + 2, y = Math.floor(p[1]), z = Math.floor(p[2]);
    connection.send({ type: "command", command: { type: "setBlock", position: [x, y, z], block: "glass" } });
    connection.send({ type: "command", command: { type: "setBlock", position: [x, y - 1, z], block: "air" } });
    host.tick();

    expect(client.chunks.size).toBe(sim.state.chunks.size);
    // The client registry defines blocks in a different order, so compare names.
    const clientRegistry = makeRegistry("reversed");
    expect(clientRegistry.name(getBlock(client, x, y, z)!)).toBe("glass");
    for (const [key, chunk] of sim.state.chunks) {
      const mine = client.chunks.get(key)!;
      expect(encodeChunk(mine, clientRegistry)).toEqual(encodeChunk(chunk, registry));
    }
  });

  it("sends every message as plain JSON", () => {
    const { received } = setup();
    for (const message of received) expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it("tells only the sender when a command is rejected", () => {
    const { host, connection, received } = setup();
    received.length = 0;
    connection.send({ type: "command", command: { type: "setBlock", position: [0, 0, 0], block: "lava" } });
    host.tick();
    expect(received).toContainEqual({ type: "rejected", command: "setBlock", reason: 'Unknown block "lava".' });
  });

  it("does not send a new client the same chunk twice", () => {
    const { received } = setup();
    const keys = received.filter((m) => m.type === "chunk").map((m) => JSON.stringify((m as { coords: unknown }).coords));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("resynchronises clients after loading a save", () => {
    const { sim, host, client, connection } = setup();
    const p = sim.state.entities.get(connection.playerId)!.position;
    const target: [number, number, number] = [Math.floor(p[0]) + 2, Math.floor(p[1]), Math.floor(p[2])];
    connection.send({ type: "command", command: { type: "setBlock", position: target, block: "stone" } });
    host.tick();
    const saved = JSON.parse(JSON.stringify(sim.snapshot()));

    connection.send({ type: "command", command: { type: "setBlock", position: target, block: "air" } });
    host.tick();
    expect(getBlock(client, ...target)).toBe(0);

    host.load(saved);
    host.tick();
    expect(makeRegistry("reversed").name(getBlock(client, ...target)!)).toBe("stone");
  });

  it("refuses to send entity data that JSON cannot represent", () => {
    const { host, connection, sim } = setup();
    (sim.state.entities.get(connection.playerId)!.data as Record<string, unknown>).bad = 1n;
    expect(() => host.tick()).toThrow();
  });

  it("gives each client its own copy of every message in strict mode, as a network would", () => {
    const registry = makeRegistry();
    const sim = new Simulation({ registry, generator: terrain(), seed: 3, loadRadius: 1 });
    const host = new LocalHost(sim);
    const a = new ClientWorld(registry);
    const b = new ClientWorld(registry);
    host.connect({ onMessage: (m) => a.apply(m) });
    const second = host.connect({ onMessage: (m) => b.apply(m) });
    host.tick();
    host.tick();
    // A client that edits what it received must not change what another client sees.
    a.entities.get(second.playerId)!.position[1] += 100;
    expect(b.entities.get(second.playerId)!.position[1]).toBe(sim.state.entities.get(second.playerId)!.position[1]);
  });
});
