# Contributing to Cubit

Thanks for wanting to help. Bug reports, fixes and small improvements are all
welcome. For anything larger, such as a new package, a change to the snapshot
format or a new kind of command, open an issue first so we can agree on the
shape before you write it.

## Setting up

You need Node.js 20.19 or newer and pnpm 10 (`corepack enable` gives you the
version pinned in `package.json`).

```bash
pnpm install
pnpm dev          # the sandbox at http://127.0.0.1:5173
```

## Before you send a change

```bash
pnpm test         # vitest, in node
pnpm typecheck    # every package; core without the DOM library
pnpm build        # production build of the sandbox
```

All three must pass. CI runs the same commands on every pull request.

Add a test with every fix and every feature. When a test is for a bug, check
that it fails without the fix: a test that passes either way protects nothing.

## The rules that keep multiplayer possible

[docs/architecture.md](docs/architecture.md) explains the design. The short
version, which review will hold changes to:

1. `@cubit/core` imports no renderer and touches no browser global (`window`,
   `document`, `localStorage`, `performance`, `requestAnimationFrame`).
   `packages/core/test/isolation.test.ts` enforces it. Browser code belongs in
   `@cubit/three`, `@cubit/input` or `@cubit/minimap`.
2. Every change to the world is a command applied by the simulation. Game and
   renderer code never write to chunks directly.
3. State is plain data: tuples, numbers, strings and JSON. No class instances,
   functions or `Map`s inside an entity.
4. Block ids never leave the process. Saves and messages name blocks.
5. The client draws and raycasts against its own `ClientWorld`, never the
   simulation's state.
6. Changing the snapshot or chunk format bumps its version, and the reader
   learns the old version first.
7. World generators are pure: the same coordinates and seed give the same chunk.

Some tests pin these down: the codec and snapshot round-trips, the
palette-by-name test with a reordered registry, the mesher face counts, the
determinism test, the strict-mode test in `host.test.ts` and
`isolation.test.ts`. A change that alters one of them needs a reason in the
pull request.

## Code and assets from elsewhere

Write engine code yourself. Do not copy code, textures, models or fonts from
other voxel projects unless their licence allows it, and never use Minecraft's
assets. Block textures are painted in code in `packages/core/src/textures.ts`:
add a style there rather than an image file. Keep styles tileable and no darker
than 0.65, so a block's own colour still reads.

## Style

Match the code around you: TypeScript in strict mode, small pure functions where
the logic allows, and comments that explain why rather than what. Keep the
engine content-neutral; anything specific to one game belongs in that game.

## Pull requests

Branch from `main`, keep each pull request to one change, and describe what it
does and how you checked it. Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org) with the package as
the scope, such as `fix(three): ...` or `feat(core): ...`.

By contributing, you agree that your contribution is licensed under the
[MIT licence](LICENSE).
