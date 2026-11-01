/**
 * Ways of combining values. A semigroup combines two values into one, and
 * `concat` must be associative, so any grouping of a fold gives the same answer.
 * A monoid adds an `empty` that changes nothing when combined, so a fold has
 * somewhere to start and an empty collection has an answer. Those two laws are
 * what let a fold be split, cached or run in pieces; the tests check them for
 * every instance here.
 *
 * Exported from `@cubit/core` as the namespace `Monoid`, so `Monoid.sum`,
 * `Monoid.box3`, `Monoid.foldMap(...)`.
 */
import { identity } from "./function";

export interface Semigroup<A> {
  readonly concat: (x: A, y: A) => A;
}

export interface Monoid<A> extends Semigroup<A> {
  readonly empty: A;
}

export const sum: Monoid<number> = { concat: (x, y) => x + y, empty: 0 };
export const product: Monoid<number> = { concat: (x, y) => x * y, empty: 1 };
export const min: Monoid<number> = { concat: (x, y) => Math.min(x, y), empty: Infinity };
export const max: Monoid<number> = { concat: (x, y) => Math.max(x, y), empty: -Infinity };
export const all: Monoid<boolean> = { concat: (x, y) => x && y, empty: true };
export const any: Monoid<boolean> = { concat: (x, y) => x || y, empty: false };
export const string: Monoid<string> = { concat: (x, y) => x + y, empty: "" };

const emptyArray: readonly never[] = [];
/** Joins arrays, never copying when one side is empty. */
export const array = <A>(): Monoid<readonly A[]> => ({
  concat: (x, y) => (x.length === 0 ? y : y.length === 0 ? x : [...x, ...y]),
  empty: emptyArray,
});

/** Chains functions from a type to itself, the first given runs first: `concat(f, g)(a)` is `g(f(a))`. */
export const endo = <A>(): Monoid<(a: A) => A> => ({
  concat: (f, g) => (a) => g(f(a)),
  empty: identity,
});

/** Combines records field by field, each field with its own monoid. */
export const struct = <A extends Readonly<Record<string, unknown>>>(
  fields: { readonly [K in keyof A]: Monoid<A[K]> },
): Monoid<{ readonly [K in keyof A]: A[K] }> => {
  const keys = Object.keys(fields) as (keyof A & string)[];
  const build = (value: (key: keyof A & string) => unknown) =>
    Object.fromEntries(keys.map((k) => [k, value(k)])) as { readonly [K in keyof A]: A[K] };
  return {
    concat: (x, y) => build((k) => fields[k].concat(x[k], y[k])),
    empty: build((k) => fields[k].empty),
  };
};

/** A closed range of numbers, `[min, max]`. Empty when `min > max`. */
export type Interval = readonly [min: number, max: number];

/** The smallest interval holding both: union of ranges. `empty` holds nothing. */
export const interval: Monoid<Interval> = {
  concat: (x, y) => [Math.min(x[0], y[0]), Math.max(x[1], y[1])],
  empty: [Infinity, -Infinity],
};
export const isEmptyInterval = (i: Interval): boolean => i[0] > i[1];

/** An axis-aligned box in world space, its least corner and its greatest. Empty when any `min` passes its `max`. */
export interface Box3 {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** The smallest box holding both: union of boxes. `empty` holds nothing. */
export const box3: Monoid<Box3> = {
  concat: (a, b) => ({
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }),
  empty: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
};
export const isEmptyBox = (b: Box3): boolean => b.min[0] > b.max[0] || b.min[1] > b.max[1] || b.min[2] > b.max[2];
/** The box one voxel or block fills, from its corner `[x, y, z]` to `[x + 1, y + 1, z + 1]`. */
export const cellBox = (x: number, y: number, z: number): Box3 => ({ min: [x, y, z], max: [x + 1, y + 1, z + 1] });

/** Combines every value, left to right, starting from `empty`. */
export const concatAll =
  <A>(M: Monoid<A>) =>
  (values: Iterable<A>): A => {
    let acc = M.empty;
    for (const value of values) acc = M.concat(acc, value);
    return acc;
  };

/** Maps every value into the monoid and combines the results. */
export const foldMap =
  <A>(M: Monoid<A>) =>
  <B>(f: (b: B) => A) =>
  (values: Iterable<B>): A => {
    let acc = M.empty;
    for (const value of values) acc = M.concat(acc, f(value));
    return acc;
  };
