import { defineConfig } from "tsdown";

// srvx only ships ES modules, so the CommonJS build can't require() it in
// loaders without require(esm), like Jest's. Bundle it into both builds, so
// each is self-contained and both run the srvx version we tested.
const srvx = /^srvx(\/|$)/;

export default defineConfig({
  entry: ["src/index.ts", "src/preview.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  fixedExtension: false,
  deps: { alwaysBundle: [srvx], onlyBundle: [srvx] },
  // Ship srvx's MIT license with the code we bundle from it.
  copy: [{ from: "node_modules/srvx/LICENSE", to: "dist/licenses/srvx" }],
});
