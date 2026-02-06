import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/preview.ts", "src/bin/vercel-slack.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
