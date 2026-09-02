import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generateFixtures } from "./generate-file-fixtures.mjs";

await generateFixtures();
await mkdir(".test-build", { recursive: true });
// Execute the actual application worker. Only the browser's Worker/FileReader
// adapters are replaced; extraction is not pre-seeded or mocked.
await build({
  stdin: { resolveDir: process.cwd(), contents: `
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
globalThis.self = globalThis;
self.location = { origin: 'http://127.0.0.1:1420' };
// Browser resource fetch adapter: read the same bundled font/CMap files locally.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const path = new URL(String(url));
  if (path.origin === self.location.origin && /^\\/pdf-assets\\/(?:cmaps|standard_fonts)\\/[a-zA-Z0-9_.-]+$/.test(path.pathname)) {
    return readFile(resolve('node_modules/pdfjs-dist', path.pathname.slice('/pdf-assets/'.length))).then(bytes => new Response(bytes));
  }
  return nativeFetch(url, options);
};
self.postMessage = value => parentPort.postMessage(value);
await import('./src/lib/document.worker.ts');
parentPort.on('message', data => self.onmessage({ data }));
` }, bundle: true, platform: "node", format: "esm", packages: "external", outfile: ".test-build/document-worker.mjs",
  plugins: [{ name: "pdf-worker-url", setup(api) {
    api.onResolve({ filter: /pdf\.worker\.min\.mjs\?url$/ }, () => ({ path: "pdf-worker-url", namespace: "fixture-url" }));
    api.onLoad({ filter: /.*/, namespace: "fixture-url" }, () => ({ contents: `export default ${JSON.stringify(pathToFileURL(resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")).href)}`, loader: "js" }));
  } }]
});
await build({ entryPoints: ["tests/file-regression.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: ".test-build/file-regression.mjs", define: { "import.meta.env.DEV": "false" } });
await import(pathToFileURL(resolve(".test-build/file-regression.mjs")).href);
