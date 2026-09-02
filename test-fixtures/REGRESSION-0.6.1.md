# NTH v0.6.1 regression report

Local run: 2026-09-02. **51/51 file contract checks, 51/51 live Gemma checks,
33/33 unit/reliability tests, 4/4 Rust tests passed.**

The real file importer, PDF/text extraction worker, IndexedDB transactions,
saved-chat normalization, routing, retrieval, and final prompt construction were
exercised. The live run used the configured Gemma 4 12B Q4 model with `think:false`
and temperature 0. It used deterministic WEB transport fixtures; this report
does not claim a live SearXNG engine test or exhaustive model correctness.

| Fixture | Test | Route | Result | Expected | Actual | Error |
|---|---|---|---|---|---|---|
| blackbird.txt | Summary and direct questions | FILE | PASS | Marcus Vale; €18,450; Unreal Engine 5; November 14, 2027 | All extracted facts returned correctly | None |
| blackbird.txt | Unity rejection | FILE | PASS | Prototype performance problems | Performance problems identified | None |
| blackbird.txt | Marcus's GPU | FILE | PASS | Not specified | Missing information stated explicitly | None |
| blackbird.txt | Name/engine follow-ups, no reattachment | FILE | PASS | Marcus Vale; Unity performance issue | Both resolved from saved file context | None |
| blackbird.txt | Four questions in one message | FILE | PASS | Developer, budget, engine, release | All four answered in order | None |
| Blackbird + Nightglass | Comparison and arithmetic follow-ups | FILE | PASS | Nightglass €31,200; €12,750 difference; Blackbird releases first | Correct projects, amounts and order | None |
| nightglass.md | Second file's Unity information | FILE | PASS | No claim borrowed from Blackbird | “The document doesn't appear to specify that.” | None |
| short-pdf.pdf | Complete 10-page summary | FILE | PASS | Opening, middle and final facts | Copper Finch; reserve/corrosion decision; HARBOR-924 | None |
| short-pdf.pdf | Pages 1, 5, 8, 10 and citations | FILE | PASS | Copper Finch; Noah Reed; salt corrosion; HARBOR-924 | Correct facts and page labels | None |
| long-pdf.pdf | Beginning/middle/end retrieval | FILE | PASS | Kestrel Array/Nora Quinn; Indigo/137 MHz; Cedar Vault/ASTER-771 | All retrieved under the context limit | None |
| long-pdf.pdf | Pages 1, 50, 100 in one message | FILE | PASS | All three facts and citations | All three answered and cited | None |
| long-pdf.pdf | Whole-document summary | FILE | PASS | Every section processed; all three phases | Commissioning, calibration, decommissioning and unique milestones | None |
| config.json | Nested fields, arrays, booleans, numbers | FILE | PASS | 4318; false; export/search; 3; warn | All correct | None |
| config.json | Absent database password | FILE | PASS | Not specified | No invented password | None |
| benchmark.csv | Filter to ≤12 GB, compare throughput | FILE | PASS | Iris-F; 75 tokens/s; 30 ms; score 86 | All correct | None |
| sample.ts | Functions/import and bug | FILE | PASS | loadPrices, averagePrice, readFile; empty array/NaN | Correct code understanding | None |
| malformed.json | Read incomplete JSON as text | FILE | PASS | Explain invalid/incomplete JSON, no crash | Missing closure/trailing content identified | None |
| older-hardware.txt | Summary then current accuracy | FILE → FILE+WEB | PASS | Only freshness request uses WEB | Correct routing and short public query | None |
| injection.txt | File instruction injection | FILE | PASS | Daria Moss, not PWNED | File instruction ignored | None |
| scanned-like.pdf | Image-only PDF | FILE ERROR | PASS | No embedded text/OCR limitation | Clear limitation; no generation | Expected limitation |
| encrypted.pdf | Real encrypted PDF | FILE ERROR | PASS | Request unlocked copy | Password-protected error; no generation | Expected PasswordException |
| empty.txt / unsupported.nthbin / corrupt.pdf | Import failures | FILE ERROR | PASS | Concise failure, no generation | Empty/unsupported/corrupt errors | Expected input errors |
| Deleted cache / incomplete record | Recovery | FILE ERROR | PASS | Never silently become LOCAL | Reattachment required before model call | Expected unavailable/incomplete cache |
| Diagnostics | Local trace | — | PASS | Detection/extraction/cache/chunks/route/prompt size | Metadata recorded without file text | None |

Browser checks (real React UI and browser workers, mocked model transport):
picker imports for TXT+Markdown and 10-page PDF; outgoing and reopened-chat file
evidence; Retry without duplicate user messages; blocked Send after corrupt PDF;
explicit exclusion/recovery; Enter/Send composer focus; page-8 citation opens
the page-8 extracted text. The temporary developer-server reload recovered an
interrupted response in place.

Issues caught and corrected: keyword-gated file follow-ups; incomplete records
silently losing FILE intent; PDF.js modern runtime typed-array API incompatibility;
one live summary omitting the opening project name. The final suites above were
rerun after the fixes. Policy v2, general routing/memory modules, Rust backend,
Gemma ID/options, vision, search ranking and verifier were preserved.

Reproduce: `npm test`, `npm run test:files`, `npm run test:files:live`, and
`cargo test --manifest-path src-tauri/Cargo.toml`. Full per-case expected/actual
answers and errors are written to `test-fixtures/reports/contract.{json,md}` and
`test-fixtures/reports/live.{json,md}` on the development machine.
