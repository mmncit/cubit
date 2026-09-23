import type { BlockRegistry } from "./blocks";
import { ByteReader, ByteWriter, decodeUtf8, encodeUtf8, fromBase64 } from "./bytes";
import { chunkKey, type ChunkData, type ChunkKey } from "./chunk";
import { decodeChunk, decodeChunkBase64, encodeChunkBase64, type DecodeOptions } from "./codec";
import type { Entity } from "./entity";
import { cloneJson } from "./json";
import type { Vec3 } from "./math";

export const SNAPSHOT_FORMAT = "cubit/snapshot";
/** Bump when the snapshot shape changes, and teach restoreSnapshot the old one. */
export const SNAPSHOT_VERSION = 1;

/** The authoritative game state. Plain data plus a Map and typed arrays. */
export interface GameState {
  tick: number;
  seed: number;
  chunks: Map<ChunkKey, ChunkData>;
  entities: Map<string, Entity>;
}

/**
 * A JSON-safe copy of game state. Chunk blocks are encoded with the chunk codec
 * and stored as base64, because JSON.stringify on a typed array produces an
 * object keyed "0", "1", ... that does not round-trip.
 */
export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  tick: number;
  seed: number;
  chunks: { coords: Vec3; data: string }[];
  entities: Entity[];
}

export interface SnapshotOptions {
  /**
   * "modified" stores only chunks changed since generation; the rest are
   * regenerated from the seed on load. "all" stores every loaded chunk.
   */
  include?: "modified" | "all";
}

export function createSnapshot(state: GameState, registry: BlockRegistry, options: SnapshotOptions = {}): Snapshot {
  const include = options.include ?? "modified";
  const chunks: Snapshot["chunks"] = [];
  const keys = [...state.chunks.keys()].sort();
  for (const key of keys) {
    const chunk = state.chunks.get(key)!;
    if (include === "modified" && !chunk.modified) continue;
    chunks.push({ coords: [...chunk.coords], data: encodeChunkBase64(chunk, registry) });
  }
  const entities = [...state.entities.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    tick: state.tick,
    seed: state.seed,
    chunks,
    entities: cloneJson(entities),
  };
}

export function assertSnapshot(value: unknown): asserts value is Snapshot {
  const s = value as Partial<Snapshot> | null;
  if (!s || typeof s !== "object" || s.format !== SNAPSHOT_FORMAT) {
    throw new Error("This is not a cubit snapshot.");
  }
  if (s.version !== SNAPSHOT_VERSION) {
    throw new Error(`Snapshot version ${String(s.version)} is not supported. This build reads version ${SNAPSHOT_VERSION}.`);
  }
  if (!Array.isArray(s.chunks) || !Array.isArray(s.entities) || typeof s.tick !== "number" || typeof s.seed !== "number") {
    throw new Error("Snapshot is missing required fields.");
  }
}

/** Rebuilds game state from a snapshot. Restored chunks are marked modified. */
export function restoreSnapshot(snapshot: Snapshot, registry: BlockRegistry, options?: DecodeOptions): GameState {
  assertSnapshot(snapshot);
  const chunks = new Map<ChunkKey, ChunkData>();
  for (const entry of snapshot.chunks) {
    const chunk = decodeChunkBase64(entry.data, entry.coords, registry, options);
    chunk.modified = true;
    chunks.set(chunkKey(entry.coords[0], entry.coords[1], entry.coords[2]), chunk);
  }
  const entities = new Map<string, Entity>();
  for (const entity of cloneJson(snapshot.entities)) entities.set(entity.id, entity);
  return { tick: snapshot.tick, seed: snapshot.seed, chunks, entities };
}

const BINARY_MAGIC = [0x43, 0x42, 0x54, 0x53]; // "CBTS"

/**
 * A compact binary form of a snapshot, for storage and the network: a JSON
 * header without chunk data, then each chunk's codec bytes.
 */
export function encodeSnapshotBinary(snapshot: Snapshot): Uint8Array {
  const writer = new ByteWriter();
  for (const b of BINARY_MAGIC) writer.u8(b);
  const header = { ...snapshot, chunks: snapshot.chunks.map((c) => ({ coords: c.coords })) };
  const json = encodeUtf8(JSON.stringify(header));
  writer.u32(json.length);
  writer.bytes(json);
  for (const entry of snapshot.chunks) {
    const bytes = fromBase64(entry.data);
    writer.u32(bytes.length);
    writer.bytes(bytes);
  }
  return writer.finish();
}

export function decodeSnapshotBinary(data: Uint8Array, registry: BlockRegistry, options?: DecodeOptions): Snapshot {
  const reader = new ByteReader(data);
  for (const b of BINARY_MAGIC) {
    if (reader.u8() !== b) throw new Error("This is not a binary cubit snapshot.");
  }
  const header = JSON.parse(decodeUtf8(reader.bytes(reader.u32()))) as Omit<Snapshot, "chunks"> & {
    chunks: { coords: Vec3 }[];
  };
  const chunks = header.chunks.map(({ coords }) => {
    const bytes = reader.bytes(reader.u32());
    return { coords, data: encodeChunkBase64(decodeChunk(bytes, coords, registry, options), registry) };
  });
  if (!reader.done) throw new Error("Binary snapshot has trailing bytes.");
  const snapshot = { ...header, chunks };
  assertSnapshot(snapshot);
  return snapshot;
}
