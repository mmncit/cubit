# @cubit/minimap

A top-down map of a [Cubit](https://github.com/mmncit/cubit) client world,
drawn on a 2D canvas, with the player's position and heading and any markers a
game adds. Published to GitHub Packages as `@mmncit/cubit-minimap` and imported
as `@cubit/minimap`:

```bash
pnpm add @cubit/minimap@npm:@mmncit/cubit-minimap@^0.10.0
```

It either follows the player across an endless world or shows a fixed area,
such as a hand-built level, and redraws its terrain only when chunks change.

```ts
import { Minimap } from "@cubit/minimap";

const minimap = new Minimap({ registry, container: document.querySelector<HTMLElement>("#map")!, radius: 40, size: 150 });

// Each message from the host:
minimap.applyChanges(client.apply(message));
// Each frame:
minimap.update(client, { position: playerPosition, yaw }, performance.now(), [{ position: goal, color: "#e8452c" }]);
```

Pass `area` instead of `radius` for a fixed map, and call `resize` to enlarge
it. See the [main README](https://github.com/mmncit/cubit#using-cubit-in-a-game)
for installation and a complete example.

MIT licensed.
