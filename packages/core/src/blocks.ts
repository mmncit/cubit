export interface BlockColors {
  top: number;
  side: number;
  bottom: number;
}

export interface BlockDef {
  /** Stable identifier. Saves and network messages refer to blocks by name. */
  name: string;
  /** Entities collide with it. */
  solid: boolean;
  /** Hides the faces of neighbouring blocks. */
  opaque: boolean;
  /** 0xRRGGBB in sRGB, per face direction. */
  colors: BlockColors;
}

export interface BlockInput {
  name: string;
  solid?: boolean;
  opaque?: boolean;
  /** One colour for every face. */
  color?: number;
  /** Per-face colours. Missing faces fall back to `color`, then to `side`. */
  colors?: Partial<BlockColors>;
}

export const AIR = 0;
export const AIR_NAME = "air";

/**
 * Maps block names to the small numeric ids chunks store. The ids are local to
 * one registry and one process: they depend on definition order, so they never
 * leave it. Everything serialized uses names.
 */
export class BlockRegistry {
  private readonly defs: BlockDef[] = [
    { name: AIR_NAME, solid: false, opaque: false, colors: { top: 0, side: 0, bottom: 0 } },
  ];
  private readonly byName = new Map<string, number>([[AIR_NAME, AIR]]);

  define(input: BlockInput): number {
    if (!input.name || typeof input.name !== "string") {
      throw new Error("A block needs a non-empty name.");
    }
    if (this.byName.has(input.name)) {
      throw new Error(`Block "${input.name}" is already defined.`);
    }
    if (this.defs.length >= 0xffff) {
      throw new Error("A registry holds at most 65535 block types.");
    }
    const base = input.color ?? input.colors?.side ?? 0xff00ff;
    const colors: BlockColors = {
      top: input.colors?.top ?? input.color ?? base,
      side: input.colors?.side ?? input.color ?? base,
      bottom: input.colors?.bottom ?? input.color ?? base,
    };
    const id = this.defs.length;
    this.defs.push({
      name: input.name,
      solid: input.solid ?? true,
      opaque: input.opaque ?? true,
      colors,
    });
    this.byName.set(input.name, id);
    return id;
  }

  /** The id for a name. Throws if the block is not defined. */
  id(name: string): number {
    const id = this.byName.get(name);
    if (id === undefined) throw new Error(`Unknown block "${name}".`);
    return id;
  }

  tryId(name: string): number | undefined {
    return this.byName.get(name);
  }

  get(id: number): BlockDef {
    const def = this.defs[id];
    if (!def) throw new Error(`Unknown block id ${id}.`);
    return def;
  }

  name(id: number): string {
    return this.get(id).name;
  }

  isSolid(id: number): boolean {
    return this.defs[id]?.solid ?? false;
  }

  isOpaque(id: number): boolean {
    return this.defs[id]?.opaque ?? false;
  }

  get size(): number {
    return this.defs.length;
  }

  all(): readonly BlockDef[] {
    return this.defs;
  }
}
