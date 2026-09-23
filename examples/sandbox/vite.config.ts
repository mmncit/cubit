import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // three.js is most of the bundle (about 140 KB gzipped in total), so one
    // chunk over the default 500 KB warning is expected.
    chunkSizeWarningLimit: 700,
  },
});
