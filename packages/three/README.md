# @cubit/three

A [three.js](https://threejs.org) renderer for a [Cubit](https://github.com/mmncit/cubit)
client world. Published to GitHub Packages as `@mmncit/cubit-three` and imported
as `@cubit/three`:

```bash
pnpm add @cubit/three@npm:@mmncit/cubit-three@^0.10.0
```

Each chunk becomes one face-culled mesh, rebuilt a few chunks per frame, nearest
first. Block textures are painted in code from the styles in `@cubit/core`, so
there are no image files to download. It can light the world with a sun and
soft shadows, draw blocky clouds, show liquids see-through, draw entities as
voxel models, and highlight the block the player is aiming at.

```ts
import { VoxelRenderer } from "@cubit/three";

const renderer = new VoxelRenderer({ canvas, registry, renderDistance: 5, lighting: true, shadows: true });
renderer.setSun({ azimuth: 2.2, elevation: 0.75 });
renderer.setClouds({ height: 60 });
renderer.resize(innerWidth, innerHeight);

// Each message from the host:
renderer.applyChanges(client.apply(message));
// Each frame:
renderer.setView(eye, yaw, pitch);
renderer.render(client);
```

Shadows are the costliest option; leave them off on cheap phones, and cap
`maxPixelRatio` at about 1.5 there. The renderer only ever reads the client's
copy of the world, never the simulation's.

`three` and `@types/three` are dependencies, because the package ships
TypeScript source that your project compiles. See the
[main README](https://github.com/mmncit/cubit#using-cubit-in-a-game) for
installation and a complete example.

MIT licensed.
