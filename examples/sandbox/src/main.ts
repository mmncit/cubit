import {
  AIR,
  BlockRegistry,
  ClientWorld,
  EYE_HEIGHT_RATIO,
  LocalHost,
  Simulation,
  assertSnapshot,
  createTerrainGenerator,
  entityOverlapsBlock,
  raycast,
  viewDirection,
  type Vec3,
} from "@cubit/core";
import { InputManager } from "@cubit/input";
import { VoxelRenderer } from "@cubit/three";

// A generic demo of the engine. Colours only, no textures: small to download,
// and no borrowed art.
const registry = new BlockRegistry();
const PALETTE = [
  { name: "grass", colors: { top: 0x6fae4a, side: 0x8a6a45, bottom: 0x7b5b3a } },
  { name: "dirt", color: 0x8a6a45 },
  { name: "stone", color: 0x8d9197 },
  { name: "sand", color: 0xdcc98c },
  { name: "wood", colors: { top: 0xb58a55, side: 0x6e4b2a, bottom: 0xb58a55 } },
  { name: "leaves", color: 0x3f8a3a, opaque: false },
  { name: "planks", color: 0xc49a62 },
  { name: "brick", color: 0xa4533b },
] as const;
for (const block of PALETTE) registry.define(block);

const generator = createTerrainGenerator({
  surface: "grass",
  subsurface: "dirt",
  deep: "stone",
  shore: "sand",
  shoreHeight: 14,
  trees: { trunk: "wood", leaves: "leaves", chance: 0.012 },
  baseHeight: 20,
  amplitude: 12,
  verticalChunks: 3,
});

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed")) || 12345;
const touch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
const renderDistance = touch ? 3 : 5;
const REACH = 6;
const SAVE_KEY = "cubit.sandbox.save.v1";

const sim = new Simulation({ registry, generator, seed, loadRadius: renderDistance + 1, reach: REACH });
const host = new LocalHost(sim);
const client = new ClientWorld(registry);

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const overlay = document.querySelector<HTMLDivElement>("#overlay")!;
const status = document.querySelector<HTMLDivElement>("#status")!;
const stats = document.querySelector<HTMLDivElement>("#stats")!;
const hotbar = document.querySelector<HTMLDivElement>("#hotbar")!;
document.body.classList.toggle("touch", touch);

const renderer = new VoxelRenderer({ canvas, registry, renderDistance, maxPixelRatio: touch ? 1.5 : 2 });
const input = new InputManager(canvas, {
  touch,
  touchContainer: document.querySelector<HTMLDivElement>("#app")!,
  onPointerLockChange: (locked) => (overlay.hidden = locked),
  onLookModeChange: (mode) => {
    // Some browsers and embedded panes refuse pointer lock. Play on with
    // drag-to-look instead of leaving the card up forever.
    if (mode === "drag") {
      overlay.hidden = true;
      say("This browser will not capture the mouse, so drag to look. A click still removes a block.");
    }
  },
});
overlay.addEventListener("click", () => canvas.click());

const say = (text: string) => (status.textContent = text);

const connection = host.connect({
  onMessage: (message) => {
    const changes = client.apply(message);
    renderer.applyChanges(changes);
    for (const change of changes) if (change.type === "rejected") say(change.reason);
  },
});

// View angles belong to the client; the host only hears about them as input.
let yaw = 0;
let pitch = -0.2;
let selected = 0;

function buildHotbar() {
  hotbar.replaceChildren();
  PALETTE.forEach((block, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.title = block.name;
    const def = registry.get(registry.id(block.name));
    button.style.background = `#${def.colors.top.toString(16).padStart(6, "0")}`;
    button.setAttribute("aria-pressed", String(i === selected));
    button.setAttribute("aria-label", block.name);
    const n = document.createElement("span");
    n.textContent = String(i + 1);
    button.append(n);
    button.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      selected = i;
      buildHotbar();
    });
    hotbar.append(button);
  });
}
buildHotbar();

document.querySelector("#save")!.addEventListener("click", () => {
  const snapshot = sim.snapshot();
  const text = JSON.stringify(snapshot);
  try {
    localStorage.setItem(SAVE_KEY, text);
    say(`Saved ${snapshot.chunks.length} changed chunk${snapshot.chunks.length === 1 ? "" : "s"}, ${(text.length / 1024).toFixed(1)} KB.`);
  } catch {
    say("This browser would not let the game save. Private browsing can block it.");
  }
});

document.querySelector("#load")!.addEventListener("click", () => {
  let text: string | null = null;
  try {
    text = localStorage.getItem(SAVE_KEY);
  } catch {
    // Storage can be blocked entirely; treated the same as no save.
  }
  if (!text) {
    say("There is no save yet. Press Save first.");
    return;
  }
  try {
    const snapshot: unknown = JSON.parse(text);
    assertSnapshot(snapshot);
    if (snapshot.seed !== seed) {
      location.search = `?seed=${snapshot.seed}&load=1`;
      return;
    }
    host.load(snapshot);
    say(`Loaded the save from tick ${snapshot.tick}.`);
  } catch (error) {
    say(`That save could not be read: ${(error as Error).message}`);
  }
});

document.querySelector("#new")!.addEventListener("click", () => {
  location.search = `?seed=${Math.floor(Math.random() * 1e9)}`;
});

if (params.get("load") === "1") {
  queueMicrotask(() => (document.querySelector("#load") as HTMLButtonElement).click());
}

function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

let last = performance.now();
let frames = 0;
let fpsTime = last;

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const intent = input.consume();
  yaw -= intent.lookX;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - intent.lookY));
  if (intent.select !== null && intent.select < PALETTE.length) {
    selected = intent.select;
    buildHotbar();
  }
  connection.send({
    type: "command",
    command: { type: "input", forward: intent.forward, strafe: intent.strafe, jump: intent.jump, sprint: intent.sprint, yaw, pitch },
  });

  const alpha = host.advance(dt);
  const player = client.player();
  if (player) {
    const feet = client.interpolatedPosition(player.id, alpha)!;
    const eye: Vec3 = [feet[0], feet[1] + player.size[1] * EYE_HEIGHT_RATIO, feet[2]];
    renderer.setView(eye, yaw, pitch);

    const hit = raycast(client, eye, viewDirection(yaw, pitch), REACH);
    renderer.setHighlight(hit ? hit.position : null);
    if (hit && intent.primary) {
      connection.send({ type: "command", command: { type: "setBlock", position: hit.position, block: "air" } });
    }
    if (hit && intent.secondary) {
      const target: Vec3 = [hit.position[0] + hit.normal[0], hit.position[1] + hit.normal[1], hit.position[2] + hit.normal[2]];
      const block = PALETTE[selected]!.name;
      // The host checks this too. Checking here as well avoids a rejected
      // command every time a player clicks the ground under their own feet.
      if (registry.id(block) === AIR || !entityOverlapsBlock(player, ...target)) {
        connection.send({ type: "command", command: { type: "setBlock", position: target, block } });
      }
    }
  }

  renderer.render(client);

  frames++;
  if (now - fpsTime > 500) {
    const fps = (frames * 1000) / (now - fpsTime);
    frames = 0;
    fpsTime = now;
    const p = client.player()?.position;
    stats.textContent = `${fps.toFixed(0)} fps · ${renderer.meshCount} meshes · ${client.chunks.size} chunks` +
      (p ? ` · ${p.map((n) => n.toFixed(1)).join(", ")}` : "");
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for debugging in the console, not part of the engine's API.
Object.assign(window, { cubit: { sim, host, client, renderer, input } });
