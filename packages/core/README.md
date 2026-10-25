# @cubit/core

The renderer-free heart of [Cubit](https://github.com/mmncit/cubit): blocks,
chunks, entities, commands, walking physics, the fixed-tick simulation, the host
and the client replica, serialization, meshing and texture styles.

It never imports a renderer and never touches a browser global, so the same
simulation runs in a browser tab today and on a server later. Everything in its
state is plain data that survives `JSON.stringify`.

Published to GitHub Packages as `@mmncit/cubit-core` and imported as
`@cubit/core`:

```bash
pnpm add @cubit/core@npm:@mmncit/cubit-core@^0.10.0
```

Installing from GitHub Packages needs a token; the
[main README](https://github.com/mmncit/cubit#using-cubit-in-a-game) explains
the setup and has a complete example.

```ts
import { BlockRegistry, ClientWorld, createTerrainGenerator, LocalHost, Simulation } from "@cubit/core";

const registry = new BlockRegistry();
registry.define({ name: "grass", color: 0x6fae4a, texture: "grass" });
registry.define({ name: "dirt", color: 0x8a6a45, texture: "soil" });
registry.define({ name: "stone", color: 0x8d9197, texture: "stone" });

const sim = new Simulation({
  registry,
  generator: createTerrainGenerator({ surface: "grass", subsurface: "dirt", deep: "stone" }),
  seed: 1,
});
const host = new LocalHost(sim);
const client = new ClientWorld(registry);
const connection = host.connect({ onMessage: (message) => client.apply(message) });

connection.send({ type: "command", command: { type: "input", forward: 1, strafe: 0, jump: false, sprint: false, yaw: 0, pitch: 0 } });
host.advance(1 / 60);
```

`sim.snapshot()` saves the game as JSON, storing only the chunks that changed;
`encodeSnapshotBinary` gives a compact binary form. How the parts fit together
is in [docs/architecture.md](https://github.com/mmncit/cubit/blob/main/docs/architecture.md).

MIT licensed.
