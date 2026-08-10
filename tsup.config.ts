import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  shims: true,
  // Keep native modules external. They use CommonJS require.
  external: ["better-sqlite3", "sqlite-vec"],
});
