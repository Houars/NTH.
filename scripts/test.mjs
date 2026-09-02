import { build } from "esbuild";

// Reuse Vite's existing compiler; no additional test dependency or generated files.
const result = await build({
  entryPoints: ["tests/reliability.test.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  define: { "import.meta.env.DEV": "false" }
});
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
