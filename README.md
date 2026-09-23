# Cubit

A generic voxel game engine for the browser. Game state is plain, serializable
data, so the same engine can run a single-player game in a tab today and sit
behind a server for multiplayer later.

```bash
pnpm install
pnpm dev
```

Then open http://127.0.0.1:5173. On a computer: click to play, WASD to move, Space
to jump, mouse to look, left click removes a block, right click places one, 1 to 8
picks a block. On a phone: drag on the left to move, drag on the right to look.

- `packages/core`: state, simulation, physics, serialization. Runs in a browser
  or on a server.
- `packages/three`: a three.js renderer.
- `packages/input`: keyboard, mouse and touch.
- `examples/sandbox`: a small game built on all three.

How it fits together, and what is still to do for multiplayer, is in
[docs/architecture.md](docs/architecture.md).
