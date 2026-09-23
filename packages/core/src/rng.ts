/**
 * Seeded pseudo-random numbers. Only integer arithmetic via Math.imul, so a
 * given seed produces the same sequence in every JavaScript engine.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A well-mixed 32-bit hash of a seed and three integer coordinates. */
export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (y | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ (z | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  return h >>> 0;
}

/** hash3 mapped to [0, 1). */
export function hashFloat(seed: number, x: number, y: number, z: number): number {
  return hash3(seed, x, y, z) / 4294967296;
}
