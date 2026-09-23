import { renderTopDown, type BlockRegistry, type ChunkStore, type ClientChange, type TopDownArea, type Vec3 } from "@cubit/core";

export interface MinimapOptions {
  registry: BlockRegistry;
  /** Where the map is added. */
  container: HTMLElement;
  /**
   * A fixed area to show, such as a whole authored level. Without one the map
   * follows the player and shows `radius` blocks around them.
   */
  area?: TopDownArea;
  radius?: number;
  /** Size on screen in CSS pixels. The map is always square. */
  size?: number;
  /** Least time between redraws of the terrain, in milliseconds. */
  refreshMs?: number;
  /** Accessible name for the map. */
  label?: string;
}

export interface MinimapViewer {
  position: Vec3;
  /** Same convention as core's viewDirection: 0 faces north (-z), positive turns left. */
  yaw: number;
}

/**
 * A map of the world seen from above, north up. The terrain is redrawn only when
 * chunks change, at most every `refreshMs`; the player's arrow is redrawn every
 * frame. Reads the client's world, never the simulation's.
 */
export class Minimap {
  readonly element: HTMLCanvasElement;
  private readonly registry: BlockRegistry;
  private readonly fixedArea: TopDownArea | undefined;
  private readonly radius: number;
  private readonly refreshMs: number;
  private readonly terrain = document.createElement("canvas");
  private area: TopDownArea | null = null;
  private dirty = true;
  private lastDrawn = -Infinity;
  private size: number;

  constructor(options: MinimapOptions) {
    this.registry = options.registry;
    this.fixedArea = options.area;
    this.radius = options.radius ?? 48;
    this.refreshMs = options.refreshMs ?? 250;
    this.size = options.size ?? 160;

    this.element = document.createElement("canvas");
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", options.label ?? "Map of the area, north at the top");
    this.element.dataset.cubitMinimap = "";
    options.container.append(this.element);
    this.resize(this.size);
  }

  /** Changes the on-screen size, for example to enlarge the map on a tap. */
  resize(size: number): void {
    this.size = size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.element.width = Math.round(size * dpr);
    this.element.height = Math.round(size * dpr);
    this.element.style.width = `${size}px`;
    this.element.style.height = `${size}px`;
  }

  /** Feed in what ClientWorld.apply returned. */
  applyChanges(changes: ClientChange[]): void {
    if (changes.some((c) => c.type === "chunk" || c.type === "block" || c.type === "reset")) this.dirty = true;
  }

  /** Call once per frame. */
  update(store: ChunkStore, viewer: MinimapViewer | undefined, now = performance.now()): void {
    const area = this.fixedArea ?? (viewer ? this.followArea(viewer.position) : null);
    if (!area) return;
    const moved = !this.area || area.minX !== this.area.minX || area.minZ !== this.area.minZ;
    if ((this.dirty || moved) && now - this.lastDrawn >= this.refreshMs) {
      this.drawTerrain(store, area);
      this.area = area;
      this.dirty = false;
      this.lastDrawn = now;
    }
    this.compose(viewer);
  }

  dispose(): void {
    this.element.remove();
  }

  private followArea([x, , z]: Vec3): TopDownArea {
    // Snap to an 8-block grid so the terrain is not redrawn on every step.
    const cx = Math.round(x / 8) * 8;
    const cz = Math.round(z / 8) * 8;
    const r = this.radius;
    return { minX: cx - r, minZ: cz - r, maxX: cx + r - 1, maxZ: cz + r - 1 };
  }

  private drawTerrain(store: ChunkStore, area: TopDownArea): void {
    const image = renderTopDown(store, this.registry, area);
    this.terrain.width = image.width;
    this.terrain.height = image.height;
    const ctx = this.terrain.getContext("2d")!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
  }

  private compose(viewer: MinimapViewer | undefined): void {
    const ctx = this.element.getContext("2d")!;
    const w = this.element.width;
    const h = this.element.height;
    const area = this.area;
    ctx.clearRect(0, 0, w, h);
    if (!area) return;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrain, 0, 0, w, h);

    const scaleX = w / (area.maxX - area.minX + 1);
    const scaleZ = h / (area.maxZ - area.minZ + 1);
    const unit = w / 160;

    // North marker.
    ctx.font = `600 ${Math.round(11 * unit * 1.2)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 3 * unit;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillStyle = "#fff";
    ctx.strokeText("N", w / 2, 4 * unit);
    ctx.fillText("N", w / 2, 4 * unit);

    if (!viewer) return;
    const px = (viewer.position[0] - area.minX) * scaleX;
    const pz = (viewer.position[2] - area.minZ) * scaleZ;
    // Facing direction on the map: x to the right, z (south) downwards.
    const dx = -Math.sin(viewer.yaw);
    const dz = -Math.cos(viewer.yaw);
    const angle = Math.atan2(dz, dx);
    const len = 9 * unit;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(len, 0);
    ctx.lineTo(-len * 0.6, len * 0.6);
    ctx.lineTo(-len * 0.3, 0);
    ctx.lineTo(-len * 0.6, -len * 0.6);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = 2 * unit;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}
