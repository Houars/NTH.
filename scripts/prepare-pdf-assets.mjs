import { cp, mkdir } from "node:fs/promises";

// Build-only copies of PDF.js resources. No CDN or external font/CMap fetches.
for (const directory of ["cmaps", "standard_fonts"]) {
  const destination = new URL(`../public/pdf-assets/${directory}/`, import.meta.url);
  await mkdir(destination, { recursive: true });
  await cp(new URL(`../node_modules/pdfjs-dist/${directory}/`, import.meta.url), destination, { recursive: true });
}
await cp(new URL("../node_modules/pdfjs-dist/LICENSE", import.meta.url), new URL("../public/pdf-assets/PDFJS-LICENSE", import.meta.url));
