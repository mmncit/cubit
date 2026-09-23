import {
  BlockRegistry,
  CHUNK_SIZE,
  Simulation,
  createChunk,
  createTerrainGenerator,
  voxelIndex,
  type WorldGenerator,
} from "../src";

export function makeRegistry(order: "normal" | "reversed" = "normal"): BlockRegistry {
  const defs = [
    { name: "stone", color: 0x808080 },
    { name: "dirt", color: 0x8b5a2b },
    { name: "grass", colors: { top: 0x55aa33, side: 0x8b5a2b, bottom: 0x8b5a2b } },
    { name: "leaves", color: 0x2f7d32, opaque: false },
    { name: "glass", color: 0xddeeff, opaque: false },
  ];
  const registry = new BlockRegistry();
  for (const def of order === "reversed" ? [...defs].reverse() : defs) registry.define(def);
  return registry;
}

/** Stone up to and including y = groundY, air above. Two chunks tall. */
export function flatGenerator(groundY = 9): WorldGenerator {
  return {
    verticalRange: [0, 1],
    generate([cx, cy, cz], registry) {
      const chunk = createChunk(cx, cy, cz);
      const stone = registry.id("stone");
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const y = cy * CHUNK_SIZE + ly;
        if (y > groundY) break;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) chunk.blocks[voxelIndex(lx, ly, lz)] = stone;
        }
      }
      return chunk;
    },
  };
}

export function terrain(): WorldGenerator {
  return createTerrainGenerator({
    surface: "grass",
    subsurface: "dirt",
    deep: "stone",
    trees: { trunk: "dirt", leaves: "leaves", chance: 0.02 },
    verticalChunks: 3,
  });
}

export function flatSim(groundY = 9): Simulation {
  return new Simulation({ registry: makeRegistry(), generator: flatGenerator(groundY), seed: 1, loadRadius: 1 });
}
