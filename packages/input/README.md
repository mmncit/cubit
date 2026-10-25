# @cubit/input

Keyboard, mouse and touch input for [Cubit](https://github.com/mmncit/cubit)
games, turned into abstract actions: move, look, jump, sprint, a primary and a
secondary action, and picking a slot. Published to GitHub Packages as
`@mmncit/cubit-input` and imported as `@cubit/input`:

```bash
pnpm add @cubit/input@npm:@mmncit/cubit-input@^0.10.0
```

On a computer it captures the mouse with pointer lock. Where a browser refuses
pointer lock, it falls back to drag-to-look and says so through
`onLookModeChange`. On a touch screen it draws on-screen controls: drag on the
left to move, drag on the right to look, and buttons for the actions.

```ts
import { InputManager, isTouchScreen } from "@cubit/input";

const input = new InputManager(canvas, {
  touch: isTouchScreen(),
  touchContainer: document.querySelector<HTMLElement>("#app")!,
  touchLabels: { primary: "Dig", secondary: "Place" },
  onLookModeChange: (mode) => { if (mode === "drag") showHint("Drag to look"); },
});

// Each frame:
const intent = input.consume();
yaw -= intent.lookX;
pitch -= intent.lookY;
```

It has no dependencies and knows nothing about the world, so it works with any
game loop. See the [main README](https://github.com/mmncit/cubit#using-cubit-in-a-game)
for installation and a complete example.

MIT licensed.
