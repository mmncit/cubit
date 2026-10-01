# Cubit architecture

Cubit is a voxel engine for browser games. It is built so that a game written
for one player in a browser tab can later run with a server and many players,
without rewriting how the game's state works. This document describes how that
is arranged, what exists now, and what comes next.

## Packages

| Package | Runs in | Depends on | Holds |
|---|---|---|---|
| `@cubit/core` | browser or server | `simplex-noise` only | blocks, chunks, entities, commands, physics, simulation, serialization, the host and the client replica, meshing |
| `@cubit/three` | browser | core, three.js | a renderer that draws a client's world |
| `@cubit/input` | browser | nothing | keyboard, mouse and touch, turned into abstract actions |
| `examples/sandbox` | browser | all three | a small game that exercises the engine |

`@cubit/core` never imports three.js and never touches a browser global. It is
typechecked without the DOM library and its tests run in node. That is what lets
the same simulation code run on a server later. `packages/core/test/isolation.test.ts`
fails if that ever changes.

## The flow of one frame

```
input device ──> InputManager ──> Command ──> Connection ──> LocalHost ──> Simulation
                                                                              │ tick
renderer <── ClientWorld <── ServerMessage <── LocalHost <── SimEvent ────────┘
```

1. The input layer turns keys, mouse and touch into an `InputFrame`.
2. The game turns intent into `Command`s (`input`, `setBlock`) and sends them
   through its `Connection`.
3. `LocalHost` stamps each command with the sender's entity id and queues it on
   the `Simulation`. The client never gets to say who it is.
4. At a fixed 60 ticks per second the simulation applies commands in order,
   validates each one (known block, integer position, loaded chunk, within reach,
   not inside an entity, and the game's own `canEdit` check if it gives one),
   steps physics, streams chunks, and returns `SimEvent`s. A game whose world
   changes only through its own actions refuses every raw `setBlock` there.
5. The host turns events into `ServerMessage`s: chunk contents, block changes, and
   the entity list for the tick.
6. `ClientWorld` rebuilds its own copy of the world from those messages alone.
7. The renderer draws the client's copy, never the simulation's.

Single player is this whole loop in one tab. By default `LocalHost` passes every
message through `JSON.stringify` and `JSON.parse` in both directions, the way a
network would. Anything that cannot be serialized fails in single player, long
before there is a server to find it.

## State is plain data

Everything in game state is data that can be copied, logged, saved and sent:

- Vectors are `[x, y, z]` tuples, not class instances.
- An `Entity` is a plain object with a JSON bag, `data`, for game-specific fields.
- A `Command` is a plain object. Every change to the world goes through one, so a
  command log replays to the same state, which the determinism test checks.
- A chunk is 16 by 16 by 16 blocks in a `Uint16Array`, plus its coordinates and a
  `modified` flag.

Block ids are small numbers local to one registry in one process. They depend on
the order a game defines its blocks, so **they never leave the process**. Saves
and messages name blocks instead.

## Serialization

`JSON.stringify` on a typed array produces an object keyed `"0"`, `"1"`, and so
on, which does not come back as an array. Chunks therefore go through an explicit
codec (`codec.ts`):

- a format byte
- a palette of the block **names** the chunk uses
- the chunk's blocks as run-length encoded palette indices

A uniform chunk encodes to a few bytes. The same bytes travel as base64 inside
JSON messages and snapshots.

A `Snapshot` (`snapshot.ts`) is a JSON-safe copy of the game: format, version,
tick, seed, encoded chunks and entities. By default it stores only chunks changed
since generation. The rest regenerate from the seed, because a `WorldGenerator`
must be a pure function of its coordinates and seed. `encodeSnapshotBinary`
gives a compact binary form for storage or the network. Both forms are tested to
round-trip exactly.

Snapshots carry a version number. A change to their shape bumps it, and
`restoreSnapshot` must learn to read the old version before the new one ships.

## Rendering

Each chunk becomes one merged, face-culled mesh with per-face vertex colours and
a fixed brightness per face direction. There are no textures and no lights. That
keeps the download small (the whole sandbox is about 140 KB gzipped, most of it
three.js) and the draw cheap on low-end phones, and it suits a low-poly look.

The mesher is a pure function in core that returns typed arrays, so it can move
into a web worker without changes. The renderer remeshes at most a few chunks per
frame, nearest first, and drops meshes that leave the render distance.

A block defined with `liquid: true` (water) is neither solid nor opaque unless it
says so. The mesher can build the solid world and the liquids apart
(`liquids: "skip"` or `"only"`), and a liquid's open surface sits
`LIQUID_SURFACE_DROP` below the top of its block. The renderer draws liquids in a
second mesh per chunk, see-through, from both sides, after everything solid and
without writing depth, so what lies under the water still shows. A world with no
liquid meshes exactly as it did before.

Physics reports landings. `stepEntity` returns how fast a walker was falling
when it landed, and the simulation hands the last tick's landings to game
systems as `landings`, by entity id. It is not part of the state, so snapshots
do not change; a game uses it to judge a hard landing.

## Touch first

The Qarya concept that prompted this engine makes a roughly $100 Android phone the
target device. The input package ships on-screen controls: drag on the left to
move, drag on the right to look, and three buttons. They are pointer events, so
they work with a mouse too. Pixel ratio is capped and render distance is smaller
on touch screens.

The in-app browser used during development is not a cheap phone. The real
performance test has to happen on one.

## Multiplayer: what is done and what is not

Done, and exercised by every single-player session:

- the authoritative simulation, with validation of every command
- commands in, messages out, all JSON-safe and checked in strict mode
- a client that works only from messages
- entity interpolation between ticks on the client

Not done yet, roughly in the order it would be needed:

1. **A WebSocket server.** A node process holding a `Simulation` and a host that
   sends the same `ServerMessage`s over sockets instead of callbacks.
2. **Interest management.** The host currently sends every loaded chunk and every
   entity to every client. A server should send each client only what is near it.
3. **Client-side prediction.** Over a real network the local player should move
   immediately and be corrected by the server, instead of waiting a round trip.
4. **Delta entity updates.** Every tick currently sends the full entity list.
5. **Chunk unloading.** Chunks stay in memory once loaded. A long session on a
   server needs to drop unmodified chunks far from every player.

Physics uses `Math.sin` and `Math.cos`, which are not guaranteed to give
identical results in every JavaScript engine. The design is server-authoritative
for that reason: clients never need to compute exactly what the server computes.

## Out of scope for now

Greedy meshing, web workers, ambient occlusion, textures, transparency sorting,
inventory, crafting, audio, and any game-specific content. The engine stays
content-neutral: a game brings its own blocks, generator and rules.
