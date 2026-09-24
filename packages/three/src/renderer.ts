import * as THREE from "three";
import {
  CHUNK_SIZE,
  chunkKey,
  meshChunk,
  meshModel,
  parseChunkKey,
  toChunk,
  type BlockRegistry,
  type ChunkKey,
  type ChunkStore,
  type ClientChange,
  type Vec3,
  type VoxelModel,
} from "@cubit/core";

/** Where a held model sits in front of the camera. */
export interface HeldOptions {
  /**
   * Right, up and back from the eye, in blocks. Forward is -z. On a screen
   * narrower than it is tall, right is scaled down so the model stays in view.
   */
  offset?: Vec3;
  /** Turn about the vertical, in radians. */
  yaw?: number;
  /** Tilt towards the camera, in radians. */
  pitch?: number;
  scale?: number;
}

const HELD_DEFAULTS = { offset: [0.28, -0.24, -0.62] as Vec3, yaw: 0.9, pitch: 0.35, scale: 0.42 };

export interface VoxelRendererOptions {
  canvas: HTMLCanvasElement;
  registry: BlockRegistry;
  /** Horizontal radius in chunks. */
  renderDistance?: number;
  /** Sky and fog colour, 0xRRGGBB. */
  sky?: number;
  fov?: number;
  /** Caps devicePixelRatio. High-density phones pay a lot for little gain above 1.5 to 2. */
  maxPixelRatio?: number;
  antialias?: boolean;
  /** Most chunks remeshed per frame, so a burst of changes never stalls a frame. */
  remeshBudget?: number;
}

/**
 * How to draw one entity, facing `yaw`: a body and a head, coloured, or a voxel
 * model defined earlier with `defineModel`.
 */
export interface EntityLook {
  id: string;
  /** Centre of the feet. */
  position: Vec3;
  yaw: number;
  /** Width, height and depth of the collision box. */
  size: Vec3;
  /** 0xRRGGBB. Used when there is no `model`. */
  body?: number;
  head?: number;
  /** The name of a model given to `defineModel`. Drawn instead of a body and head. */
  model?: string;
}

const FACE_SHADE = [0.8, 0.8, 1, 0.5, 0.65, 0.65]; // +x, -x, +y, -y, +z, -z, as the mesher does

/** A box with each face shaded like a chunk face, so figures sit in the world's look. */
function shadedBox(width: number, height: number, depth: number, hex: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const base = new THREE.Color().setHex(hex);
  const colors = new Float32Array(24 * 3);
  for (let face = 0; face < 6; face++) {
    const k = FACE_SHADE[face]!;
    for (let v = 0; v < 4; v++) colors.set([base.r * k, base.g * k, base.b * k], (face * 4 + v) * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

const NEIGHBOURS: Vec3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * Draws a ChunkStore with one merged mesh per chunk. It keeps no game state of
 * its own: it is told what changed and reads blocks from the store.
 */
export class VoxelRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private readonly registry: BlockRegistry;
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly meshes = new Map<ChunkKey, THREE.Mesh>();
  private readonly empty = new Set<ChunkKey>();
  private readonly dirty = new Set<ChunkKey>();
  private readonly highlight: THREE.LineSegments;
  private readonly figureMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly figures = new Map<string, { group: THREE.Group; key: string }>();
  private readonly models = new Map<string, THREE.BufferGeometry>();
  // What the player holds: its own scene and a camera fixed at the origin, drawn
  // after the world so it sits in front of everything.
  private readonly heldScene = new THREE.Scene();
  private readonly heldCamera: THREE.PerspectiveCamera;
  private held: { name: string; mesh: THREE.Mesh; options: HeldOptions } | null = null;
  private readonly waypoint: THREE.Mesh;
  private waypointAt: Vec3 | null = null;
  private readonly clock = new THREE.Clock();
  private readonly renderDistance: number;
  private readonly remeshBudget: number;
  private cameraChunk = "";

  constructor(options: VoxelRendererOptions) {
    this.registry = options.registry;
    this.renderDistance = options.renderDistance ?? 4;
    this.remeshBudget = options.remeshBudget ?? 4;
    const sky = options.sky ?? 0x9fc9e8;

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: options.antialias ?? false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 2));
    this.renderer.setClearColor(sky);

    this.camera = new THREE.PerspectiveCamera(options.fov ?? 70, 1, 0.05, 1000);
    this.camera.rotation.order = "YXZ";
    this.heldCamera = new THREE.PerspectiveCamera(options.fov ?? 70, 1, 0.01, 10);

    const far = this.renderDistance * CHUNK_SIZE;
    this.scene.fog = new THREE.Fog(sky, far * 0.55, far);

    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
      new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.6 }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    // A cone pointing down at a goal, ignoring fog so it can be seen from far
    // off. Walls and hills hide it unless setWaypoint asks for it through walls.
    const cone = new THREE.ConeGeometry(0.35, 0.8, 16);
    cone.rotateX(Math.PI);
    this.waypoint = new THREE.Mesh(
      cone,
      new THREE.MeshBasicMaterial({ color: 0xe8452c, depthTest: true, depthWrite: false, transparent: true, opacity: 0.92, fog: false }),
    );
    this.waypoint.renderOrder = 999;
    this.waypoint.visible = false;
    this.scene.add(this.waypoint);
  }

  /** Feed in what ClientWorld.apply returned. */
  applyChanges(changes: ClientChange[]): void {
    for (const change of changes) {
      switch (change.type) {
        case "reset":
          for (const key of [...this.meshes.keys()]) this.removeMesh(key);
          this.empty.clear();
          this.dirty.clear();
          this.cameraChunk = "";
          break;
        case "chunk": {
          // A new chunk also changes which faces its neighbours need.
          const [cx, cy, cz] = parseChunkKey(change.key);
          this.markDirty(change.key);
          for (const [dx, dy, dz] of NEIGHBOURS) this.markDirty(chunkKey(cx + dx, cy + dy, cz + dz));
          break;
        }
        case "block": {
          const [x, y, z] = change.position;
          this.markDirty(chunkKey(toChunk(x), toChunk(y), toChunk(z)));
          // A block on a chunk edge exposes or hides a face in the next chunk.
          for (const [dx, dy, dz] of NEIGHBOURS) {
            this.markDirty(chunkKey(toChunk(x + dx), toChunk(y + dy), toChunk(z + dz)));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Makes a voxel model available to entities by name. Defining a name again
   * replaces the model for entities drawn from then on.
   */
  defineModel(name: string, model: VoxelModel): void {
    const mesh = meshModel(model, { linearColors: true });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeBoundingSphere();
    const old = this.models.get(name);
    this.models.set(name, geometry);
    if (old) {
      // Redraw anything using the old one, then free it.
      for (const [id, figure] of this.figures) if (figure.key.endsWith(`|${name}`)) this.removeFigure(id);
      if (this.held?.name === name) {
        const { options } = this.held;
        this.setHeld(null);
        this.setHeld(name, options);
      }
      old.dispose();
    }
  }

  /**
   * Shows a model held in front of the camera, low and to the right, the way a
   * first-person game shows what the player carries. Null puts it away. It is
   * drawn after the world with the depth cleared, so it never sinks into a wall.
   */
  setHeld(name: string | null, options: HeldOptions = {}): void {
    if (this.held && (this.held.name !== name || name === null)) {
      this.heldScene.remove(this.held.mesh);
      this.held = null;
    }
    if (name === null || this.held) return;
    const geometry = this.models.get(name);
    if (!geometry) throw new Error(`No model named "${name}". Call defineModel first.`);
    const mesh = new THREE.Mesh(geometry, this.figureMaterial);
    const o = { ...HELD_DEFAULTS, ...options };
    mesh.rotation.set(o.pitch, o.yaw, 0, "YXZ");
    mesh.scale.setScalar(o.scale);
    this.heldScene.add(mesh);
    this.held = { name, mesh, options };
    this.placeHeld();
  }

  private placeHeld(): void {
    if (!this.held) return;
    const [x, y, z] = this.held.options.offset ?? HELD_DEFAULTS.offset;
    this.held.mesh.position.set(x * Math.min(1, this.heldCamera.aspect), y, z);
  }

  /**
   * Draws these entities as simple figures, and removes any not in the list.
   * Leave the local player out; the camera is inside them.
   */
  setEntities(looks: EntityLook[]): void {
    const seen = new Set<string>();
    for (const look of looks) {
      seen.add(look.id);
      const key = `${look.size.join(",")}|${look.body}|${look.head}|${look.model ?? ""}`;
      let figure = this.figures.get(look.id);
      if (!figure || figure.key !== key) {
        if (figure) this.removeFigure(look.id);
        const group = new THREE.Group();
        if (look.model !== undefined) {
          const geometry = this.models.get(look.model);
          if (!geometry) throw new Error(`No model named "${look.model}". Call defineModel first.`);
          // Shared by every entity drawn with this model, so removeFigure leaves it alone.
          const mesh = new THREE.Mesh(geometry, this.figureMaterial);
          mesh.userData.shared = true;
          group.add(mesh);
        } else {
          const [w, h, d] = look.size;
          const bodyHeight = h * 0.72;
          const body = new THREE.Mesh(shadedBox(w, bodyHeight, d * 0.8, look.body ?? 0x808080), this.figureMaterial);
          body.position.y = bodyHeight / 2;
          const headSize = Math.min(w, h - bodyHeight) * 0.95;
          const head = new THREE.Mesh(shadedBox(headSize, h - bodyHeight, headSize, look.head ?? 0x808080), this.figureMaterial);
          head.position.y = bodyHeight + (h - bodyHeight) / 2;
          group.add(body, head);
        }
        this.scene.add(group);
        figure = { group, key };
        this.figures.set(look.id, figure);
      }
      figure.group.position.set(look.position[0], look.position[1], look.position[2]);
      figure.group.rotation.y = look.yaw;
    }
    for (const id of [...this.figures.keys()]) if (!seen.has(id)) this.removeFigure(id);
  }

  /**
   * Sky colour and overall brightness, 0 to 1. Brightness multiplies every
   * colour in the world, a cheap stand-in for light that works on any phone.
   */
  setAmbient(options: { sky?: number; brightness?: number }): void {
    if (options.sky !== undefined) {
      this.renderer.setClearColor(options.sky);
      (this.scene.fog as THREE.Fog).color.setHex(options.sky);
    }
    if (options.brightness !== undefined) {
      const b = Math.max(0, Math.min(1, options.brightness));
      this.material.color.setRGB(b, b, b);
      this.figureMaterial.color.setRGB(b, b, b);
    }
  }

  /**
   * Marks a point in the world with a bouncing cone, or clears it with null.
   * `position` is the ground it points at, such as an entity's feet or the top
   * of a block. The world hides it like any other object; `throughWalls` draws
   * it over everything instead.
   */
  setWaypoint(position: Vec3 | null, options: { color?: number; lift?: number; throughWalls?: boolean } = {}): void {
    this.waypointAt = position ? [position[0], position[1] + (options.lift ?? 2.4), position[2]] : null;
    this.waypoint.visible = !!position;
    const material = this.waypoint.material as THREE.MeshBasicMaterial;
    if (options.color !== undefined) material.color.setHex(options.color);
    material.depthTest = !options.throughWalls;
  }

  /** Places the camera. `yaw` and `pitch` follow the same convention as core's viewDirection. */
  setView(eye: Vec3, yaw: number, pitch: number): void {
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.rotation.set(pitch, yaw, 0);
  }

  setHighlight(position: Vec3 | null): void {
    if (!position) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.visible = true;
    this.highlight.position.set(position[0] + 0.5, position[1] + 0.5, position[2] + 0.5);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.heldCamera.aspect = this.camera.aspect;
    this.heldCamera.updateProjectionMatrix();
    this.placeHeld();
  }

  render(store: ChunkStore): void {
    const t = this.clock.getElapsedTime();
    if (this.waypointAt) {
      const [x, y, z] = this.waypointAt;
      this.waypoint.position.set(x, y + Math.abs(Math.sin(t * 3)) * 0.5, z);
      this.waypoint.rotation.y = t * 1.5;
      // Small up close, larger far away, so it neither looms over the goal nor
      // vanishes across the map.
      const d = this.camera.position.distanceTo(this.waypoint.position);
      this.waypoint.scale.setScalar(Math.min(4, Math.max(0.5, d / 12)));
    }
    this.trackRange(store);
    this.remesh(store);
    this.renderer.render(this.scene, this.camera);
    if (this.held) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.heldScene, this.heldCamera);
      this.renderer.autoClear = true;
    }
  }

  /** Number of chunk meshes currently drawn. */
  get meshCount(): number {
    return this.meshes.size;
  }

  dispose(): void {
    for (const key of [...this.meshes.keys()]) this.removeMesh(key);
    for (const id of [...this.figures.keys()]) this.removeFigure(id);
    this.setHeld(null);
    for (const geometry of this.models.values()) geometry.dispose();
    this.models.clear();
    this.figureMaterial.dispose();
    this.waypoint.geometry.dispose();
    (this.waypoint.material as THREE.Material).dispose();
    this.material.dispose();
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private markDirty(key: ChunkKey): void {
    this.dirty.add(key);
    this.empty.delete(key);
  }

  private inRange(key: ChunkKey): boolean {
    const [cx, , cz] = parseChunkKey(key);
    const [px, , pz] = this.cameraChunkCoords();
    return Math.max(Math.abs(cx - px), Math.abs(cz - pz)) <= this.renderDistance;
  }

  private cameraChunkCoords(): Vec3 {
    const p = this.camera.position;
    return [toChunk(Math.floor(p.x)), toChunk(Math.floor(p.y)), toChunk(Math.floor(p.z))];
  }

  /** When the camera enters a new chunk, mesh what came into range and drop what left it. */
  private trackRange(store: ChunkStore): void {
    const [px, py, pz] = this.cameraChunkCoords();
    const current = `${px},${py},${pz}`;
    if (current === this.cameraChunk) return;
    this.cameraChunk = current;
    for (const key of [...this.meshes.keys()]) {
      if (!this.inRange(key)) this.removeMesh(key);
    }
    for (const key of store.chunks.keys()) {
      if (this.inRange(key) && !this.meshes.has(key) && !this.empty.has(key)) this.dirty.add(key);
    }
  }

  private remesh(store: ChunkStore): void {
    if (this.dirty.size === 0) return;
    const [px, py, pz] = this.cameraChunkCoords();
    const order = [...this.dirty].map((key) => {
      const [cx, cy, cz] = parseChunkKey(key);
      return { key, coords: [cx, cy, cz] as Vec3, d: (cx - px) ** 2 + (cy - py) ** 2 + (cz - pz) ** 2 };
    });
    order.sort((a, b) => a.d - b.d);

    let budget = this.remeshBudget;
    for (const { key, coords } of order) {
      if (budget <= 0) break;
      this.dirty.delete(key);
      if (!store.chunks.has(key) || !this.inRange(key)) {
        this.removeMesh(key);
        continue;
      }
      budget--;
      const mesh = meshChunk(store, this.registry, coords, { linearColors: true });
      if (mesh.faceCount === 0) {
        this.removeMesh(key);
        this.empty.add(key);
        continue;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      geometry.computeBoundingSphere();

      const existing = this.meshes.get(key);
      if (existing) {
        existing.geometry.dispose();
        existing.geometry = geometry;
      } else {
        const object = new THREE.Mesh(geometry, this.material);
        object.position.set(coords[0] * CHUNK_SIZE, coords[1] * CHUNK_SIZE, coords[2] * CHUNK_SIZE);
        object.matrixAutoUpdate = false;
        object.updateMatrix();
        this.scene.add(object);
        this.meshes.set(key, object);
      }
    }
  }

  private removeFigure(id: string): void {
    const figure = this.figures.get(id);
    if (!figure) return;
    this.scene.remove(figure.group);
    for (const child of figure.group.children) if (!child.userData.shared) (child as THREE.Mesh).geometry.dispose();
    this.figures.delete(id);
  }

  private removeMesh(key: ChunkKey): void {
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.meshes.delete(key);
  }
}
