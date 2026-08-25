import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/handoff/cli.ts", "src/hub/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: false,
  // tsup's default node-protocol plugin rewrites `node:sqlite` to a bare `sqlite`
  // import (it does not recognize the experimental builtin), which resolves to
  // nothing at runtime. Disable the rewrite so `node:` prefixes survive the build
  // and node resolves the builtin itself.
  removeNodeProtocol: false,
});
