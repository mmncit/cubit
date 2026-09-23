# AGENTS.md: cubit

Context for AI agents working in this repo. Keep it current. A stale line here
gets acted on.

## What this is

Cubit is a generic voxel game engine for the browser, written in TypeScript. Game
state is plain, serializable data so that single-player games built on it can
later gain a server and multiplayer. It is content-neutral: games bring their own
blocks, world generator and rules. The first game planned on it is Qarya
(`mmncit/qarya`), but nothing Qarya-specific belongs here.

- **Stack:** TypeScript, pnpm workspace, three.js, Vite, Vitest
- **Repo:** `mmncit/cubit` (private)
- **Design:** `docs/architecture.md`. Read it before changing core.

## Run it

```bash
pnpm install
pnpm dev          # the sandbox at http://127.0.0.1:5173
pnpm test         # vitest, node environment
pnpm typecheck    # every package; core without the DOM library
pnpm build        # production build of the sandbox
```

## Rules that keep the multiplayer path open

1. **`@cubit/core` is renderer-free and DOM-free.** No `three`, no `window`,
   `document`, `localStorage`, `performance` or `requestAnimationFrame`. Its
   tsconfig has `lib: ["ES2022"]` and no types. `test/isolation.test.ts` enforces
   this. If something needs the browser, it goes in `@cubit/three` or
   `@cubit/input`.
2. **Every change to the world is a `Command` applied by the `Simulation`.** Do not
   write to chunks from game or renderer code. `writeBlock` exists for generators
   and tests.
3. **State is plain data.** Tuples, numbers, strings, JSON. No class instances,
   functions or `Map`s inside an `Entity`. Game-specific entity fields go in
   `entity.data`.
4. **Block ids never leave the process.** They depend on definition order. Chunks
   serialize with a palette of names through `codec.ts`; messages name blocks.
   Never `JSON.stringify` a typed array: it produces `{"0": ..., "1": ...}` and
   does not round-trip.
5. **The client reads only `ClientWorld`.** The renderer and raycasts take the
   client's replica, never `sim.state`. The sandbox touching `sim` directly is
   limited to save and load, which a server would own.
6. **Changing the snapshot or chunk format bumps its version**, and the reader
   learns the old version before the new one ships.
7. **Generators are pure.** The same coordinates and seed give the same chunk.
   Saves depend on it, since they store only modified chunks.

## Tests that pin the design

Add tests freely. Changing or deleting one of these needs a reason stated in the
PR: codec and snapshot round-trips through JSON and binary, the palette-by-name
test with a reordered registry, the mesher face counts, the determinism test,
the strict-mode test in `host.test.ts`, and `isolation.test.ts`.

When adding a test for a bug, check it fails without the fix. One test in this
repo passed with the feature it claimed to test switched off, and was rewritten.

## Assets and code from elsewhere

Write engine code from scratch. Do not copy code, textures, models or fonts from
other voxel projects unless their licence allows it, and never use Minecraft's
textures or fonts. The sandbox uses flat colours for this reason as well as for
download size.

## Git and GitHub

The `mnc-conventions` skill from `mmncit/platform-context` covers git identity,
pinning `GH_TOKEN` to the `mmncit` account, branching, PRs and commit trailers.
Its brand palette and My Next Coffee copy linting do not apply here.

- Local identity must be `mmncit <mmncit@gmail.com>`.
- The remote is `git@github-personal:mmncit/cubit.git`.
- Branch, open a PR, squash-merge. Do not push to `main`.

## Known gaps

The multiplayer work still to do (server, interest management, prediction, delta
updates, chunk unloading) is listed in `docs/architecture.md`. Performance has
only been checked in a desktop browser, not yet on a low-end Android phone.
