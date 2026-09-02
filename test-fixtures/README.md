# Local file regression fixtures

Run `npm run test:files` to generate synthetic files and exercise the real import,
extraction worker, transactional cache, saved message references, routing,
retrieval, and prompt construction. No Ollama or SearXNG is needed in contract
mode. Mocked answers are not evidence of model correctness.

Run `npm run test:files:live` with Ollama and the unchanged configured Gemma Q4
model installed to check actual answers as well. WEB transport is deterministic
in this harness, so it does not claim to test live search engines.

`files/` contains generated UTF-8 text, Markdown, nested JSON, CSV, TypeScript,
10-page and 100-page text PDFs, a real image-only PDF, an encrypted PDF
(test password `fixture-only`), corrupt/empty/unsupported inputs, archived
hardware notes, and an injection fixture. They contain no user data.

`reports/` contains JSON and Markdown results, including expected/actual route,
content, errors, and whether the run used real Gemma or mocked model transport.
Generated files/reports and the temporary test build are ignored by Git and are
not production Vite entries or Tauri resources.
