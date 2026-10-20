import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/index-v2.ts", "src/preview.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  fixedExtension: false,
});
