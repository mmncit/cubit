import { describe, expect, it } from "vitest";
import { constant, flow, identity, Monoid, mulberry32, parseSnapshot, pipe, Result } from "../src";

/** Checks a monoid's laws over sample values: associativity, and `empty` changing nothing on either side. */
function obeysLaws<A>(M: Monoid.Monoid<A>, samples: readonly A[], same: (x: A, y: A) => boolean = (x, y) => {
  expect(x).toEqual(y);
  return true;
}) {
  for (const a of samples) {
    expect(same(M.concat(M.empty, a), a), "left identity").toBe(true);
    expect(same(M.concat(a, M.empty), a), "right identity").toBe(true);
    for (const b of samples) {
      for (const c of samples) expect(same(M.concat(M.concat(a, b), c), M.concat(a, M.concat(b, c))), "associativity").toBe(true);
    }
  }
}

const random = mulberry32(7);
const numbers = Array.from({ length: 6 }, () => Math.round((random() - 0.5) * 200));
const boxOf = (): Monoid.Box3 => {
  const p = [0, 1, 2].map(() => Math.round((random() - 0.5) * 50)) as [number, number, number];
  return { min: p, max: [p[0] + 1 + Math.round(random() * 5), p[1] + 1, p[2] + 2] };
};

describe("monoids", () => {
  it("obey the laws: sum, product, min, max, all, any, string", () => {
    obeysLaws(Monoid.sum, numbers);
    obeysLaws(Monoid.product, numbers.map((n) => n % 7));
    obeysLaws(Monoid.min, numbers);
    obeysLaws(Monoid.max, numbers);
    obeysLaws(Monoid.all, [true, false]);
    obeysLaws(Monoid.any, [true, false]);
    obeysLaws(Monoid.string, ["", "a", "bc", "def"]);
  });

  it("obey the laws: arrays, records field by field, intervals and boxes", () => {
    obeysLaws(Monoid.array<number>(), [[], [1], [2, 3], [4, 5, 6]]);
    const totals = Monoid.struct({ count: Monoid.sum, high: Monoid.max, seen: Monoid.any });
    obeysLaws(totals, numbers.map((n, i) => ({ count: i, high: n, seen: n > 0 })));
    obeysLaws(Monoid.interval, numbers.map((n) => [n, n + 3] as const));
    obeysLaws(Monoid.box3, Array.from({ length: 5 }, boxOf));
  });

  it("chain functions in order: endo runs the first one first", () => {
    const M = Monoid.endo<number>();
    const steps = [(n: number) => n + 1, (n: number) => n * 2, (n: number) => n - 3];
    expect(Monoid.concatAll(M)(steps)(5)).toBe(9);
    const same = (f: (n: number) => number, g: (n: number) => number) => numbers.every((n) => f(n) === g(n));
    obeysLaws(M, steps, same);
  });

  it("fold collections, giving empty for nothing", () => {
    expect(Monoid.concatAll(Monoid.sum)([])).toBe(0);
    expect(Monoid.foldMap(Monoid.max)((s: string) => s.length)(["a", "abc", "ab"])).toBe(3);
    const bounds = Monoid.concatAll(Monoid.box3)([Monoid.cellBox(0, 0, 0), Monoid.cellBox(3, -2, 1)]);
    expect(bounds).toEqual({ min: [0, -2, 0], max: [4, 1, 2] });
    expect(Monoid.isEmptyBox(Monoid.box3.empty)).toBe(true);
    expect(Monoid.isEmptyInterval(Monoid.interval.empty)).toBe(true);
    expect(Monoid.isEmptyInterval([2, 2])).toBe(false);
  });

  it("never copies an array joined with an empty one", () => {
    const xs = [1, 2];
    expect(Monoid.array<number>().concat(xs, [])).toBe(xs);
    expect(Monoid.array<number>().concat([], xs)).toBe(xs);
  });
});

describe("Result", () => {
  const half = (n: number): Result.Result<string, number> => (n % 2 === 0 ? Result.ok(n / 2) : Result.err(`${n} is odd`));

  it("keeps the functor laws: mapping identity changes nothing, and two maps are one", () => {
    for (const r of [Result.ok(4), Result.err("no")] as Result.Result<string, number>[]) {
      expect(Result.map(identity<number>)(r)).toEqual(r);
      const f = (n: number) => n + 1;
      const g = (n: number) => n * 3;
      expect(Result.map(g)(Result.map(f)(r))).toEqual(Result.map((n: number) => g(f(n)))(r));
    }
  });

  it("stops at the first refusal, and says why", () => {
    expect(pipe(Result.ok(8), Result.flatMap(half), Result.flatMap(half))).toEqual(Result.ok(2));
    expect(pipe(Result.ok(6), Result.flatMap(half), Result.flatMap(half))).toEqual(Result.err("3 is odd"));
    expect(pipe(Result.ok(5), Result.ensure((n: number) => n > 9, (n) => `${n} is small`))).toEqual(Result.err("5 is small"));
    expect(pipe(Result.err("first"), Result.mapError((e: string) => e.toUpperCase()))).toEqual(Result.err("FIRST"));
  });

  it("turns back into a value, a fallback, or a thrown error at a boundary", () => {
    expect(Result.getOrElse((e: string) => e.length)(half(3))).toBe(8);
    expect(Result.getOrThrow<string>()(half(4))).toBe(2);
    expect(() => Result.getOrThrow<string>((e) => new RangeError(e))(half(3))).toThrow(RangeError);
    expect(Result.isOk(half(2))).toBe(true);
    expect(Result.isErr(half(1))).toBe(true);
  });
});

describe("pipe and flow", () => {
  it("run stages left to right, and flow builds the function that does", () => {
    expect(pipe(2, (n) => n + 1, (n) => n * 10, String)).toBe("30");
    const describe = flow((a: number, b: number) => a + b, (n) => n * 2, (n) => `${n}!`);
    expect(describe(1, 2)).toBe("6!");
    expect(pipe("same")).toBe("same");
    expect(constant(4)()).toBe(4);
  });
});

describe("parseSnapshot", () => {
  it("says why a value is not a snapshot, in the words assertSnapshot throws", () => {
    expect(parseSnapshot(null)).toEqual(Result.err("This is not a cubit snapshot."));
    expect(parseSnapshot({ format: "cubit/snapshot", version: 99 })).toEqual(Result.err("Snapshot version 99 is not supported. This build reads version 1."));
    expect(parseSnapshot({ format: "cubit/snapshot", version: 1 })).toEqual(Result.err("Snapshot is missing required fields."));
    const good = { format: "cubit/snapshot", version: 1, tick: 0, seed: 1, chunks: [], entities: [] };
    expect(parseSnapshot(good)).toEqual(Result.ok(good));
  });
});
