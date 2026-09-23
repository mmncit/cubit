import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const sources = readdirSync(join(root, "src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(join(root, "src", f), "utf8") }));

describe("@cubit/core stays renderer-free and DOM-free", () => {
  // A server will import this package. Anything browser-only here breaks it.
  it("does not depend on three", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })).not.toContain("three");
    for (const { file, text } of sources) expect(text, file).not.toMatch(/from\s+["']three/);
  });

  it("does not touch browser globals", () => {
    const browserOnly = /\b(window|document|navigator|localStorage|requestAnimationFrame|performance)\s*[.(]/;
    for (const { file, text } of sources) expect(text, file).not.toMatch(browserOnly);
  });

  it("is typechecked without the DOM library", () => {
    const tsconfig = JSON.parse(
      readFileSync(join(root, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    );
    expect(tsconfig.compilerOptions.lib).toEqual(["ES2022"]);
  });
});
