import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Reuse Vite's compiler. A local build file keeps failure traces readable.
await mkdir(".test-build", { recursive: true });
await build({
  entryPoints: ["tests/reliability.test.ts"],
  bundle: true,
  outfile: ".test-build/unit-tests.mjs",
  platform: "node",
  format: "esm",
  define: { "import.meta.env.DEV": "false" }
});
await import(pathToFileURL(resolve(".test-build/unit-tests.mjs")).href);
