/**
 * Composing functions: `pipe` runs a value through stages, `flow` builds the
 * function that does. Typed stage by stage, so a mismatch is reported at the
 * stage that breaks rather than at the end. Up to nine stages each; past that,
 * name a sub-pipeline, which reads better too.
 */

export const identity = <A>(a: A): A => a;

/** A function that ignores its arguments and returns `a`. */
export const constant =
  <A>(a: A) =>
  (): A =>
    a;

export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
export function pipe<A, B, C, D, E>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): E;
export function pipe<A, B, C, D, E, F>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F): F;
export function pipe<A, B, C, D, E, F, G>(
  a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G,
): G;
export function pipe<A, B, C, D, E, F, G, H>(
  a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H,
): H;
export function pipe<A, B, C, D, E, F, G, H, I>(
  a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H,
  hi: (h: H) => I,
): I;
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H,
  hi: (h: H) => I, ij: (i: I) => J,
): J;
export function pipe(a: unknown, ...stages: ReadonlyArray<(x: unknown) => unknown>): unknown {
  let value = a;
  for (const stage of stages) value = stage(value);
  return value;
}

export function flow<A extends readonly unknown[], B>(ab: (...a: A) => B): (...a: A) => B;
export function flow<A extends readonly unknown[], B, C>(ab: (...a: A) => B, bc: (b: B) => C): (...a: A) => C;
export function flow<A extends readonly unknown[], B, C, D>(ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D): (...a: A) => D;
export function flow<A extends readonly unknown[], B, C, D, E>(
  ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E,
): (...a: A) => E;
export function flow<A extends readonly unknown[], B, C, D, E, F>(
  ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F,
): (...a: A) => F;
export function flow<A extends readonly unknown[], B, C, D, E, F, G>(
  ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G,
): (...a: A) => G;
export function flow<A extends readonly unknown[], B, C, D, E, F, G, H>(
  ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H,
): (...a: A) => H;
export function flow<A extends readonly unknown[], B, C, D, E, F, G, H, I>(
  ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H,
  hi: (h: H) => I,
): (...a: A) => I;
export function flow(first: (...args: unknown[]) => unknown, ...rest: ReadonlyArray<(x: unknown) => unknown>) {
  return (...args: unknown[]): unknown => {
    let value = first(...args);
    for (const stage of rest) value = stage(value);
    return value;
  };
}
