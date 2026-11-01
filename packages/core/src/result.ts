/**
 * A value or the reason there is none, as data rather than a thrown error, so
 * a refusal shows in the signature and can be passed along, mapped or turned
 * into a message where it is shown. Data last and curried, for `pipe`.
 *
 * Exported from `@cubit/core` as the namespace `Result`, so `Result.ok(x)`,
 * `Result.map(f)`, and the type `Result.Result<E, A>`.
 */

export interface Ok<A> {
  readonly ok: true;
  readonly value: A;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}
export type Result<E, A> = Ok<A> | Err<E>;

export const ok = <A>(value: A): Ok<A> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <E, A>(r: Result<E, A>): r is Ok<A> => r.ok;
export const isErr = <E, A>(r: Result<E, A>): r is Err<E> => !r.ok;

export const map =
  <A, B>(f: (a: A) => B) =>
  <E>(r: Result<E, A>): Result<E, B> =>
    r.ok ? ok(f(r.value)) : r;

export const mapError =
  <E, F>(f: (e: E) => F) =>
  <A>(r: Result<E, A>): Result<F, A> =>
    r.ok ? r : err(f(r.error));

/** Continues with a step that may itself refuse. The first refusal wins. */
export const flatMap =
  <A, E2, B>(f: (a: A) => Result<E2, B>) =>
  <E1>(r: Result<E1, A>): Result<E1 | E2, B> =>
    r.ok ? f(r.value) : r;

/** Fails with `error` unless the value passes `predicate`. */
export const ensure =
  <A, E>(predicate: (a: A) => boolean, error: (a: A) => E) =>
  <E0>(r: Result<E0, A>): Result<E0 | E, A> =>
    !r.ok || predicate(r.value) ? r : err(error(r.value));

export const getOrElse =
  <E, A>(fallback: (e: E) => A) =>
  (r: Result<E, A>): A =>
    r.ok ? r.value : fallback(r.error);

/** The value, or a thrown Error built from the reason: for a boundary that has to throw. */
export const getOrThrow =
  <E>(toError: (e: E) => Error = (e) => new Error(String(e))) =>
  <A>(r: Result<E, A>): A => {
    if (r.ok) return r.value;
    throw toError(r.error);
  };
