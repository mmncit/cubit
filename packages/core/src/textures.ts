/**
 * Block textures, painted in code. Each style is a small tileable grey pattern
 * that multiplies a block's own colour, so a game keeps its palette and gains
 * surface detail: grain in sand, courses in a stone wall, boards in a door.
 *
 * Everything here is plain data and pure functions, so it runs anywhere and the
 * same style always paints the same pixels. A renderer packs the styles a
 * registry uses into one atlas with `paintAtlas`, and the mesher reads each
 * face's rectangle from its layout.
 */

/** Edge of one texture tile, in pixels. */
export const TILE_SIZE = 16;
/** Tile plus the wrapped border around it, so mipmaps never reach a neighbour. */
const CELL_SIZE = 32;
const PAD = (CELL_SIZE - TILE_SIZE) / 2;

export const TEXTURE_STYLES = [
  "flat", "speckle", "sand", "soil", "furrow", "grass", "stalks", "gravel", "stone",
  "ashlar", "slabs", "plaster", "planks", "bark", "rings", "leaves", "cloth", "water",
] as const;
export type TextureStyle = (typeof TEXTURE_STYLES)[number];

export function isTextureStyle(name: string): name is TextureStyle {
  return (TEXTURE_STYLES as readonly string[]).includes(name);
}

// ---- noise, tileable at 16 pixels ------------------------------------------------------

/** A repeatable hash of integer coordinates to [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const wrap = (n: number, period: number) => ((n % period) + period) % period;
const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Smooth value noise with `cells` lattice cells across the tile (or `cellsY` down
 * it, for streaks), wrapping at its edges so the tile repeats without a seam.
 */
function noise(x: number, y: number, cells: number, seed: number, cellsY = cells): number {
  const gx = (x / TILE_SIZE) * cells;
  const gy = (y / TILE_SIZE) * cellsY;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = smooth(gx - x0);
  const ty = smooth(gy - y0);
  const at = (i: number, j: number) => hash(wrap(i, cells), wrap(j, cellsY), seed);
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

// ---- the styles ------------------------------------------------------------------------

/** Brightness 0 to 1 of one pixel of a style. Rows run top to bottom. */
type Painter = (x: number, y: number) => number;

const grit = (x: number, y: number, seed: number, amount: number) => (hash(x, y, seed) > 0.86 ? -amount : 0);

const PAINTERS: Record<TextureStyle, Painter> = {
  flat: () => 1,

  // Fine dust: a gentle wash with a few darker grains.
  speckle: (x, y) => 0.94 + 0.05 * noise(x, y, 4, 1) + grit(x, y, 2, 0.08),

  // Wind ripples running across, with grains.
  sand: (x, y) => {
    const ripple = Math.sin(((y + 2.5 * noise(x, y, 2, 3)) / TILE_SIZE) * Math.PI * 2 * 3);
    return 0.93 + 0.035 * ripple + 0.03 * noise(x, y, 8, 4) + grit(x, y, 5, 0.06);
  },

  // Clods and dark specks.
  soil: (x, y) => 0.84 + 0.12 * noise(x, y, 4, 6) + grit(x, y, 7, 0.1),

  // Ploughed soil: a dark trench every four rows.
  furrow: (x, y) => (y % 4 === 3 ? 0.74 : 0.86 + 0.1 * noise(x, y, 4, 8)) + grit(x, y, 9, 0.06),

  // Short blades, lighter tips over darker roots.
  grass: (x, y) => {
    const blade = hash(x, Math.floor(y / 3), 10) > 0.55;
    return (blade ? 0.96 : 0.8) + 0.08 * noise(x, y, 4, 11) - (y % 3 === 2 && blade ? 0.06 : 0);
  },

  // Standing stalks, one pixel wide, with a head every so often.
  stalks: (x, y) => {
    const stalk = wrap(x + Math.floor(hash(Math.floor(x / 3), 0, 12) * 3), 3) === 0;
    const head = stalk && wrap(y + Math.floor(hash(x, 1, 13) * 16), 16) < 3;
    return head ? 1 : stalk ? 0.72 + 0.1 * noise(x, y, 4, 14) : 0.9 + 0.06 * noise(x, y, 8, 15);
  },

  // Packed pebbles: bright stones with dark gaps between them.
  gravel: (x, y) => {
    const n = noise(x, y, 8, 16);
    return (n > 0.62 ? 0.78 : 0.92 + 0.08 * noise(x, y, 4, 17)) + grit(x, y, 18, 0.05);
  },

  // Rough rock: blotches and a few cracks.
  stone: (x, y) => {
    const crack = Math.abs(noise(x, y, 4, 19) - 0.5) < 0.035;
    return (crack ? 0.72 : 0.82 + 0.1 * noise(x, y, 4, 20) + 0.06 * noise(x, y, 8, 21));
  },

  // Dressed stone laid in courses: blocks eight wide and eight high, every other course offset.
  ashlar: (x, y) => {
    const course = Math.floor(y / 8);
    const shifted = wrap(x + (course % 2) * 4, TILE_SIZE);
    const joint = y % 8 === 7 || shifted % 8 === 7;
    if (joint) return 0.74;
    const tone = hash(Math.floor(shifted / 8), course, 22) * 0.06;
    return 0.9 + tone + 0.04 * noise(x, y, 8, 23);
  },

  // Paving slabs, eight by eight, each a slightly different tone.
  slabs: (x, y) => {
    if (x % 8 === 7 || y % 8 === 7) return 0.76;
    return 0.88 + 0.07 * hash(Math.floor(x / 8), Math.floor(y / 8), 24) + 0.04 * noise(x, y, 8, 25) + grit(x, y, 26, 0.05);
  },

  // Lime plaster: nearly even, with soft patches.
  plaster: (x, y) => 0.93 + 0.06 * noise(x, y, 4, 27) + grit(x, y, 28, 0.04),

  // Boards four pixels high, with grain along them and a dark seam between.
  planks: (x, y) => {
    if (y % 4 === 3) return 0.7;
    const board = Math.floor(y / 4);
    const grain = noise(x, y, 2, 29 + board, 16);
    return 0.84 + 0.08 * hash(board, 0, 30) + 0.1 * grain;
  },

  // Bark: deep vertical fissures.
  bark: (x, y) => {
    const fissure = noise(x, y, 8, 31, 2);
    return fissure < 0.38 ? 0.68 : 0.82 + 0.14 * noise(x, y, 8, 32);
  },

  // The cut end of a log: rings around the heart.
  rings: (x, y) => {
    const r = Math.hypot(x - 7.5, y - 7.5);
    if (r > 7) return 0.72;
    return 0.86 + 0.08 * Math.cos(r * 2.2 + noise(x, y, 4, 33) * 2);
  },

  // Clumps of leaves with shadowed gaps.
  leaves: (x, y) => {
    const clump = noise(x, y, 8, 34);
    return clump < 0.35 ? 0.7 : 0.84 + 0.16 * hash(x, y, 35) * clump;
  },

  // Woven cloth, with a band across it.
  cloth: (x, y) => ((x + y) % 2 === 0 ? 0.97 : 0.9) - (y % 8 === 0 ? 0.08 : 0),

  // Still water: soft bands and a few glints.
  water: (x, y) => {
    const wave = Math.sin(((y + 2 * noise(x, y, 2, 36)) / TILE_SIZE) * Math.PI * 2 * 2);
    return hash(x, y, 37) > 0.97 ? 1 : 0.88 + 0.06 * wave;
  },
};

/**
 * Paints one style as a `TILE_SIZE` square of grey levels, 0 to 255, row by row.
 * The pattern tiles: its right edge runs on into its left, and its bottom into its top.
 */
export function paintTexture(style: TextureStyle): Uint8Array {
  const painter = PAINTERS[style];
  if (!painter) throw new Error(`Unknown texture style "${style}". Known: ${TEXTURE_STYLES.join(", ")}.`);
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const v = Math.max(0, Math.min(1, painter(x, y)));
      out[y * TILE_SIZE + x] = Math.round(v * 255);
    }
  }
  return out;
}

// ---- the atlas -------------------------------------------------------------------------

/** Where each style sits in an atlas, as [u0, v0, u1, v1] from 0 to 1, v down from the top row. */
export interface AtlasLayout {
  width: number;
  height: number;
  rects: Map<TextureStyle, [number, number, number, number]>;
}

/** Lays the styles out in a square grid of padded cells, "flat" first. A power of two on each side. */
export function atlasLayout(styles: Iterable<TextureStyle>): AtlasLayout {
  const unique = ["flat" as TextureStyle, ...new Set(styles)].filter((s, i, all) => all.indexOf(s) === i);
  let columns = 1;
  while (columns * columns < unique.length) columns *= 2;
  const width = columns * CELL_SIZE;
  const rows = Math.ceil(unique.length / columns);
  let height = 1;
  while (height < rows * CELL_SIZE) height *= 2;
  const rects = new Map<TextureStyle, [number, number, number, number]>();
  unique.forEach((style, i) => {
    const x = (i % columns) * CELL_SIZE + PAD;
    const y = Math.floor(i / columns) * CELL_SIZE + PAD;
    rects.set(style, [x / width, y / height, (x + TILE_SIZE) / width, (y + TILE_SIZE) / height]);
  });
  return { width, height, rects };
}

/**
 * Paints an atlas as RGBA pixels, row by row from the top. Each tile is
 * surrounded by its own pattern wrapped round, so filtering and mipmaps blend a
 * tile only with itself.
 */
export function paintAtlas(layout: AtlasLayout): Uint8Array {
  const { width, height } = layout;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  for (const [style, [u0, v0]] of layout.rects) {
    const tile = paintTexture(style);
    const cx = Math.round(u0 * width) - PAD;
    const cy = Math.round(v0 * height) - PAD;
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const v = tile[wrap(y - PAD, TILE_SIZE) * TILE_SIZE + wrap(x - PAD, TILE_SIZE)]!;
        const i = ((cy + y) * width + (cx + x)) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
      }
    }
  }
  return pixels;
}
