import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test runs in node. @cubit/core has to work on a server, so its
    // suite must never get a DOM to lean on.
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
  },
});
