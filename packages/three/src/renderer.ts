import * as THREE from "three";
import {
  CHUNK_SIZE,
  chunkKey,
  meshChunk,
  atlasLayout,
  glowCentre,
  meshModel,
  paintAtlas,
  parseChunkKey,
  toChunk,
  type BlockRegistry,
  type ChunkKey,
  type ChunkMesh,
  type ChunkStore,
  type ClientChange,
  type Vec3,
  type AtlasLayout,
  type VoxelModel,
} from "@cubit/core";

/** A model as the renderer keeps it: the ordinary part, the part that glows, and where its light is. */
interface ModelParts {
  rest: THREE.BufferGeometry;
  glow: THREE.BufferGeometry | null;
  halo: { centre: Vec3; radius: number } | null;
}

function geometryOf(mesh: ReturnType<typeof meshModel>): THREE.BufferGeometry | null {
  if (mesh.faceCount === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Smooth value noise over the cloud tile's cells, wrapping so the tile repeats without a seam. */
function cloudNoise(i: number, j: number, cells: number, seed: number): number {
  const at = (a: number, b: number) => {
    let h = ((((a % cells) + cells) % cells) * 374761393 + (((b % cells) + cells) % cells) * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const f = (n: number, period: number) => {
    const x = n / period;
    const x0 = Math.floor(x);
    const t = x - x0;
    return { x0, t: t * t * (3 - 2 * t) };
  };
  let total = 0;
  let weight = 0;
  for (const [period, w] of [[4, 0.65], [2, 0.35]] as const) {
    const a = f(i, period);
    const b = f(j, period);
    const p = cells / period;
    const g = (u: number, v: number) => at(((u % p) + p) % p + 1000 * period, ((v % p) + p) % p);
    const top = g(a.x0, b.x0) * (1 - a.t) + g(a.x0 + 1, b.x0) * a.t;
    const bottom = g(a.x0, b.x0 + 1) * (1 - a.t) + g(a.x0 + 1, b.x0 + 1) * a.t;
    total += (top * (1 - b.t) + bottom * b.t) * w;
    weight += w;
  }
  return total / weight;
}

/** One tile of blocky clouds: cells where the noise is high, merged into slabs with only their outside faces. */
function cloudGeometry(coverage: number, seed: number): THREE.BufferGeometry {
  const cells = CLOUD_TILE / CLOUD_CELL;
  const on = (i: number, j: number) => cloudNoise(i, j, cells, seed) > 1 - Math.max(0, Math.min(1, coverage)) * 0.9 - 0.05;
  const positions: number[] = [];
  const colors: number[] = [];
  const s = CLOUD_CELL;
  const h = 3;
  const quad = (a: number[], b: number[], c: number[], d: number[], k: number) => {
    for (const v of [a, b, c, a, c, d]) positions.push(v[0]!, v[1]!, v[2]!), colors.push(k, k, k);
  };
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      if (!on(i, j)) continue;
      const x = i * s;
      const z = j * s;
      quad([x, h, z], [x, h, z + s], [x + s, h, z + s], [x + s, h, z], 1); // top
      quad([x, 0, z], [x + s, 0, z], [x + s, 0, z + s], [x, 0, z + s], 0.72); // underside
      if (!on(i + 1, j)) quad([x + s, 0, z], [x + s, h, z], [x + s, h, z + s], [x + s, 0, z + s], 0.88);
      if (!on(i - 1, j)) quad([x, 0, z], [x, 0, z + s], [x, h, z + s], [x, h, z], 0.88);
      if (!on(i, j + 1)) quad([x, 0, z + s], [x + s, 0, z + s], [x + s, h, z + s], [x, h, z + s], 0.82);
      if (!on(i, j - 1)) quad([x, 0, z], [x, h, z], [x + s, h, z], [x + s, 0, z], 0.82);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A soft round light, bright in the middle and gone at the edge, drawn once. */
function haloTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d")!;
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.45)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

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
  /** Draw the blocks' texture styles. On by default; off gives flat colours. */
  textures?: boolean;
  /**
   * Light the world with a sun and the sky instead of flat colour. Off by
   * default. Place the sun with `setSun`.
   */
  lighting?: boolean;
  /** With lighting, the sun casts soft shadows. The costliest thing here: leave it off on cheap phones. */
  shadows?: boolean;
  /** Edge of the shadow map in pixels. 2048 by default. */
  shadowMapSize?: number;
}

/** Where the sun is: `azimuth` from north towards east, `elevation` above the horizon, in radians. */
export interface SunOptions {
  azimuth: number;
  elevation: number;
  /** 0xRRGGBB. White by default; warmer towards dusk. */
  color?: number;
}

/** A layer of blocky clouds high over the world. */
export interface CloudOptions {
  /** Height of the cloud base, in blocks. */
  height: number;
  /** Share of the sky covered, 0 to 1. 0.4 by default. */
  coverage?: number;
  /** Drift eastwards, in blocks a second. 1.5 by default. */
  speed?: number;
  /** Changes the pattern. */
  seed?: number;
}

// Faces are shaded a little less when the world is lit, since the lights shade them too.
const LIT_SHADE = { top: 1, bottom: 0.82, x: 0.94, z: 0.88 };
const CLOUD_TILE = 256;
const CLOUD_CELL = 8;

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
  private readonly material: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial;
  private readonly atlas: AtlasLayout | undefined;
  private readonly meshes = new Map<ChunkKey, THREE.Mesh>();
  // Liquids get a mesh of their own per chunk, drawn see-through after everything solid.
  private readonly liquidMeshes = new Map<ChunkKey, THREE.Mesh>();
  private readonly liquidMaterial: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial;
  private readonly empty = new Set<ChunkKey>();
  private readonly dirty = new Set<ChunkKey>();
  private readonly highlight: THREE.LineSegments;
  private readonly figureMaterial: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial;
  // Lighting, when asked for: a sun that follows the camera, and the sky's light.
  private readonly lit: boolean;
  private readonly shadows: boolean;
  private readonly sun: THREE.DirectionalLight | null = null;
  private readonly skyLight: THREE.HemisphereLight | null = null;
  private readonly sunDirection = new THREE.Vector3(0, 1, 0);
  private readonly shadowExtent: number = 0;
  private readonly shadowMapSize: number = 2048;
  // Clouds, drawn in their own pass with their own, longer fog.
  private readonly cloudScene = new THREE.Scene();
  private clouds: { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshBasicMaterial; offset: number; speed: number } | null = null;
  private sky: number;
  private brightness = 1;
  private lastFrameTime = 0;
  private readonly figures = new Map<string, { group: THREE.Group; key: string }>();
  private readonly models = new Map<string, ModelParts>();
  // Glowing faces are drawn at full brightness and seen through fog; their halo
  // is faint by day and strong at dusk.
  private readonly glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  private haloMaterial: THREE.SpriteMaterial | null = null;
  private haloStrength = 0;
  // What the player holds: its own scene and a camera fixed at the origin, drawn
  // after the world so it sits in front of everything.
  private readonly heldScene = new THREE.Scene();
  private readonly heldCamera: THREE.PerspectiveCamera;
  private held: { name: string; mesh: THREE.Object3D; options: HeldOptions } | null = null;
  private readonly waypoint: THREE.Mesh;
  private waypointAt: Vec3 | null = null;
  private readonly timer = new THREE.Timer();
  private readonly renderDistance: number;
  private readonly remeshBudget: number;
  private cameraChunk = "";

  constructor(options: VoxelRendererOptions) {
    this.registry = options.registry;
    this.lit = options.lighting ?? false;
    this.shadows = this.lit && (options.shadows ?? false);
    const Material = this.lit ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial;
    this.material = new Material({ vertexColors: true });
    this.figureMaterial = new Material({ vertexColors: true });
    if (options.textures !== false) {
      // One small atlas of every style the blocks use, multiplied into their colours.
      // Pixels stay crisp up close and blend smoothly far away.
      this.atlas = atlasLayout(this.registry.all().flatMap((b) => [b.textures.top, b.textures.side, b.textures.bottom]));
      const texture = new THREE.DataTexture(paintAtlas(this.atlas), this.atlas.width, this.atlas.height, THREE.RGBAFormat);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.colorSpace = THREE.NoColorSpace; // grey levels are multipliers, not colours
      texture.needsUpdate = true;
      this.material.map = texture;
    }
    // See-through, seen from above and below, and never hiding what lies behind it in the depth buffer.
    this.liquidMaterial = new Material({ vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
    this.liquidMaterial.map = this.material.map;
    this.renderDistance = options.renderDistance ?? 4;
    this.remeshBudget = options.remeshBudget ?? 4;
    const sky = options.sky ?? 0x9fc9e8;
    this.sky = sky;

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
    this.cloudScene.fog = new THREE.Fog(sky, 140, 380);

    if (this.lit) {
      // Sky light from above and a warm bounce from the ground, so shaded sides stay readable.
      this.skyLight = new THREE.HemisphereLight(0xeef3ff, 0xc2ad8e, 1);
      this.sun = new THREE.DirectionalLight(0xffffff, 0.85);
      this.scene.add(this.skyLight, this.sun, this.sun.target);
      if (this.shadows) {
        this.renderer.shadowMap.enabled = true;
        // three's soft filtering is its PCF map now; the separate soft type is gone.
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.shadowMapSize = options.shadowMapSize ?? 2048;
        this.shadowExtent = Math.min(56, far * 0.7);
        const shadow = this.sun.shadow;
        this.sun.castShadow = true;
        shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
        Object.assign(shadow.camera, { left: -this.shadowExtent, right: this.shadowExtent, top: this.shadowExtent, bottom: -this.shadowExtent, near: 1, far: 260 });
        shadow.camera.updateProjectionMatrix();
        shadow.bias = -0.0004;
        shadow.normalBias = 0.04;
      }
      // Held things are lit evenly, so they read the same wherever the player stands.
      this.heldScene.add(new THREE.HemisphereLight(0xffffff, 0x9a8a70, 2));
      this.setSun({ azimuth: -0.7, elevation: 0.95 });
    }

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
          for (const key of this.meshedKeys()) this.removeMesh(key);
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
    const rest = geometryOf(meshModel(model, { linearColors: true, part: "rest", ...(this.lit ? { shade: LIT_SHADE } : {}) })) ?? new THREE.BufferGeometry();
    const glow = geometryOf(meshModel(model, { linearColors: true, part: "glow" }));
    const old = this.models.get(name);
    this.models.set(name, { rest, glow, halo: glowCentre(model) });
    if (old) {
      // Redraw anything using the old one, then free it.
      for (const [id, figure] of this.figures) if (figure.key.endsWith(`|${name}`)) this.removeFigure(id);
      if (this.held?.name === name) {
        const { options } = this.held;
        this.setHeld(null);
        this.setHeld(name, options);
      }
      old.rest.dispose();
      old.glow?.dispose();
    }
  }

  /** The meshes that draw a model, sharing its geometry. The halo is left out of the held view. */
  private modelGroup(name: string, halo: boolean): THREE.Group {
    const parts = this.models.get(name);
    if (!parts) throw new Error(`No model named "${name}". Call defineModel first.`);
    const group = new THREE.Group();
    const rest = new THREE.Mesh(parts.rest, this.figureMaterial);
    rest.userData.shared = true;
    group.add(rest);
    if (parts.glow) {
      const glow = new THREE.Mesh(parts.glow, this.glowMaterial);
      glow.userData.shared = true;
      glow.userData.glow = true;
      group.add(glow);
    }
    if (halo && parts.halo) {
      this.haloMaterial ??= new THREE.SpriteMaterial({
        map: haloTexture(), color: 0xffc766, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, fog: false, opacity: this.haloStrength,
      });
      const sprite = new THREE.Sprite(this.haloMaterial);
      sprite.position.set(...parts.halo.centre);
      sprite.scale.setScalar(Math.max(0.6, parts.halo.radius * 7));
      sprite.userData.shared = true;
      group.add(sprite);
    }
    return group;
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
    const mesh = this.modelGroup(name, false);
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
        let group = new THREE.Group();
        if (look.model !== undefined) {
          // Shares the model's geometry with every entity drawn with it, so removeFigure leaves it alone.
          group = this.modelGroup(look.model, true);
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
        if (this.shadows) group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.userData.glow !== true) o.castShadow = o.receiveShadow = true; });
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
      this.sky = options.sky;
      this.renderer.setClearColor(options.sky);
      (this.scene.fog as THREE.Fog).color.setHex(options.sky);
      (this.cloudScene.fog as THREE.Fog).color.setHex(options.sky);
    }
    if (options.brightness !== undefined) {
      const b = Math.max(0, Math.min(1, options.brightness));
      this.brightness = b;
      if (this.lit) {
        // The lights dim, not the colours, so shade and shadow keep their shape.
        this.skyLight!.intensity = 0.35 + 0.7 * b;
        this.sun!.intensity = 0.75 * b;
      } else {
        this.material.color.setRGB(b, b, b);
        this.figureMaterial.color.setRGB(b, b, b);
      }
      this.haloStrength = Math.max(0, Math.min(0.9, (0.95 - b) * 1.8));
      if (this.haloMaterial) this.haloMaterial.opacity = this.haloStrength;
    }
    this.tintClouds();
  }

  /**
   * Places the sun, and colours its light. Needs `lighting`. Lower it in the
   * evening for long shadows and warm it towards dusk.
   */
  setSun(options: SunOptions): void {
    if (!this.sun) return;
    const { azimuth, elevation } = options;
    this.sunDirection.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).normalize();
    this.sun.color.setHex(options.color ?? 0xffffff);
  }

  /** Lays a layer of blocky clouds over the world, or clears it with null. */
  setClouds(options: CloudOptions | null): void {
    if (this.clouds) {
      this.cloudScene.remove(this.clouds.group);
      this.clouds.geometry.dispose();
      this.clouds.material.dispose();
      this.clouds = null;
    }
    if (!options) return;
    const geometry = cloudGeometry(options.coverage ?? 0.4, options.seed ?? 1);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false });
    const group = new THREE.Group();
    // Nine copies of one tile, so the sky never runs out as the player walks.
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const tile = new THREE.Mesh(geometry, material);
        tile.position.set(i * CLOUD_TILE, 0, j * CLOUD_TILE);
        group.add(tile);
      }
    }
    group.position.y = options.height;
    this.cloudScene.add(group);
    this.clouds = { group, geometry, material, offset: 0, speed: options.speed ?? 1.5 };
    this.tintClouds();
  }

  /** Clouds are white, taking on the sky's colour towards dusk and dimming with the light. */
  private tintClouds(): void {
    if (!this.clouds) return;
    const white = new THREE.Color(0xffffff);
    const sky = new THREE.Color(this.sky);
    this.clouds.material.color.copy(white.lerp(sky, 0.35)).multiplyScalar(0.45 + 0.55 * this.brightness);
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
    this.timer.update();
    const t = this.timer.getElapsed();
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
    if (this.sun) this.placeSun();
    this.renderer.render(this.scene, this.camera);
    if (this.clouds) {
      // Drift, and keep the tiles centred on the camera.
      this.clouds.offset = (this.clouds.offset + Math.max(0, t - this.lastFrameTime) * this.clouds.speed) % CLOUD_TILE;
      const cx = Math.floor(this.camera.position.x / CLOUD_TILE) * CLOUD_TILE;
      const cz = Math.floor(this.camera.position.z / CLOUD_TILE) * CLOUD_TILE;
      this.clouds.group.position.x = cx + this.clouds.offset - CLOUD_TILE / 2;
      this.clouds.group.position.z = cz - CLOUD_TILE / 2;
      this.renderer.autoClear = false;
      this.renderer.render(this.cloudScene, this.camera);
      this.renderer.autoClear = true;
    }
    this.lastFrameTime = t;
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
    this.timer.dispose();
    for (const key of this.meshedKeys()) this.removeMesh(key);
    for (const id of [...this.figures.keys()]) this.removeFigure(id);
    this.setHeld(null);
    for (const parts of this.models.values()) {
      parts.rest.dispose();
      parts.glow?.dispose();
    }
    this.models.clear();
    this.figureMaterial.dispose();
    this.glowMaterial.dispose();
    this.setClouds(null);
    this.haloMaterial?.map?.dispose();
    this.haloMaterial?.dispose();
    this.waypoint.geometry.dispose();
    (this.waypoint.material as THREE.Material).dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.liquidMaterial.dispose();
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
    for (const key of this.meshedKeys()) {
      if (!this.inRange(key)) this.removeMesh(key);
    }
    for (const key of store.chunks.keys()) {
      if (this.inRange(key) && !this.meshes.has(key) && !this.liquidMeshes.has(key) && !this.empty.has(key)) this.dirty.add(key);
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
      const base = { linearColors: true, atlas: this.atlas, ...(this.lit ? { shade: LIT_SHADE } : {}) };
      const solid = meshChunk(store, this.registry, coords, { ...base, liquids: "skip" });
      const liquid = meshChunk(store, this.registry, coords, { ...base, liquids: "only" });
      if (solid.faceCount === 0 && liquid.faceCount === 0) {
        this.removeMesh(key);
        this.empty.add(key);
        continue;
      }
      this.placeMesh(this.meshes, key, coords, solid, this.material, false);
      this.placeMesh(this.liquidMeshes, key, coords, liquid, this.liquidMaterial, true);
    }
  }

  /** Puts one chunk's mesh in the scene, replaces its geometry, or takes it away if it has no faces. */
  private placeMesh(
    into: Map<ChunkKey, THREE.Mesh>, key: ChunkKey, coords: Vec3, mesh: ChunkMesh,
    material: THREE.Material, liquid: boolean,
  ): void {
    const existing = into.get(key);
    if (mesh.faceCount === 0) {
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        into.delete(key);
      }
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
    if (this.atlas) geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeBoundingSphere();
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }
    const object = new THREE.Mesh(geometry, material);
    // A liquid takes shadows but casts none, and is drawn after the solid world.
    object.castShadow = this.shadows && !liquid;
    object.receiveShadow = this.shadows;
    if (liquid) object.renderOrder = 1;
    object.position.set(coords[0] * CHUNK_SIZE, coords[1] * CHUNK_SIZE, coords[2] * CHUNK_SIZE);
    object.matrixAutoUpdate = false;
    object.updateMatrix();
    this.scene.add(object);
    into.set(key, object);
  }

  /** Keeps the sun's shadow box on the camera, snapped to its texels so shadows do not shimmer. */
  private placeSun(): void {
    const sun = this.sun!;
    const target = this.camera.position.clone();
    if (this.shadows) {
      const texel = (this.shadowExtent * 2) / this.shadowMapSize;
      target.set(Math.round(target.x / texel) * texel, Math.round(target.y / texel) * texel, Math.round(target.z / texel) * texel);
    }
    sun.target.position.copy(target);
    sun.position.copy(target).addScaledVector(this.sunDirection, 120);
    sun.target.updateMatrixWorld();
  }

  private removeFigure(id: string): void {
    const figure = this.figures.get(id);
    if (!figure) return;
    this.scene.remove(figure.group);
    for (const child of figure.group.children) if (!child.userData.shared) (child as THREE.Mesh).geometry?.dispose();
    this.figures.delete(id);
  }

  /** Every chunk with a mesh drawn, solid or liquid. */
  private meshedKeys(): ChunkKey[] {
    return [...new Set([...this.meshes.keys(), ...this.liquidMeshes.keys()])];
  }

  private removeMesh(key: ChunkKey): void {
    for (const into of [this.meshes, this.liquidMeshes]) {
      const mesh = into.get(key);
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      into.delete(key);
    }
  }
}
