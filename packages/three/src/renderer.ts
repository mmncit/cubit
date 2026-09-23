import * as THREE from "three";
import {
  CHUNK_SIZE,
  chunkKey,
  meshChunk,
  parseChunkKey,
  toChunk,
  type BlockRegistry,
  type ChunkKey,
  type ChunkStore,
  type ClientChange,
  type Vec3,
} from "@cubit/core";

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

    const far = this.renderDistance * CHUNK_SIZE;
    this.scene.fog = new THREE.Fog(sky, far * 0.55, far);

    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
      new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.6 }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);
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
  }

  render(store: ChunkStore): void {
    this.trackRange(store);
    this.remesh(store);
    this.renderer.render(this.scene, this.camera);
  }

  /** Number of chunk meshes currently drawn. */
  get meshCount(): number {
    return this.meshes.size;
  }

  dispose(): void {
    for (const key of [...this.meshes.keys()]) this.removeMesh(key);
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

  private removeMesh(key: ChunkKey): void {
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.meshes.delete(key);
  }
}
