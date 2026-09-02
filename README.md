# NTH.

A finished, local-first desktop companion built with Tauri 2, React, TypeScript,
Rust, and Ollama.

## Product

- Frameless native window with custom titlebar controls
- Persistent conversation history with automatic titles and date groups
- Streaming local responses with clean cancellation
- Screenshot paste, image drop, attachment previews, and vision answers
- Optional SearXNG web search with ranked citations and evidence verification
- RUN / JOG / WALK modes, ready for separate model IDs later
- Local profile avatar with crop, preview, replacement, and removal
- Animated monochrome NTH Glyph Matrix with response-state signals
- Recent-turn contextual follow-ups with date-aware automatic WEB routing
- Conversation-only routing precedence and verified-context reuse without repeat searches
- Lightweight per-chat topic state, capped multi-question search decomposition, and deterministic age calculation
- Separated explicit/search/history context with failed-search protection and bounded local-search retries
- Topic-aware rolling conversation memory with a strict prompt budget and correction handling
- Per-topic verified WEB evidence memory with freshness-based expiry and restart restoration
- Collapsed-by-default verified source cards
- In-app settings and service status without developer-facing error dumps
- Cached Ollama/model health, on-demand SearXNG health, and in-place Retry
- Cancellable, time-bounded search, verification, generation, and vision
- Interrupted-response recovery and guarded atomic chat persistence
- Local PDF/text/code attachments with conversation-scoped retrieval and page citations
- Composer stays editable while answering, with intent-aware keyboard focus

## Files & documents (0.6.0)

### File context hotfix (0.6.1)

File focus now survives unqualified questions ("Who is the lead developer?",
"What's the budget?", "By how much?") and saved-chat follow-ups. The outgoing
message and transactional cache—not draft UI state—supply authoritative file
references. An explicit extraction status gates generation; missing, damaged,
or incomplete file records fail visibly instead of becoming LOCAL answers.
Failed imports block Send until successfully reattached or explicitly excluded.

PDF extraction uses matching PDF.js compatibility builds. Prompts identify each
file's name/type and page boundaries, retain context across multi-question turns,
and preserve distinctive beginning/middle/end facts in summaries. Multi-page
questions prioritize each requested page without lifting the context budget.

Generate the local development fixtures with `npm run fixtures`. Run
`npm run test:files` for full ingestion/prompt contract checks, or
`npm run test:files:live` for actual Gemma answer assertions. The harness uses the
real extraction worker and chat/cache round-trips; only browser APIs are adapted
for Node. Contract mode mocks model output. Both modes use deterministic WEB
fixtures, not live search engines. Reports with expected/actual results are
written to `test-fixtures/reports/{contract,live}.{json,md}`. The release workflow
gates publishing on the offline contract suite. Fixtures and reports are not
bundled with NTH. See [fixture documentation](test-fixtures/README.md).

Local diagnostics now include extraction start/end/failure, approximate token
and character counts, pages/chunks, cache hits/misses, chosen chunks, route and
prompt size. No document contents or telemetry are logged.

### Attachment behavior

Attach up to four images/files per message using the picker, drop, or clipboard
files. PDFs, TXT, Markdown, JSON, CSV/TSV, and common source-code/config files are
supported. Image attachments still use the existing vision pipeline.

Documents are parsed and retrieved in a cancellable worker, entirely on-device.
PDF.js and its font/CMap resources are bundled locally; no CDN or OCR is used.
Limits: 20 MB/PDF, 2 MB/text file, 500 PDF pages, and 240,000 extracted characters
per document. Password-protected, corrupt, empty, binary, and image-only PDFs
receive readable errors. Mixed PDFs warn about pages without embedded text;
embedded images are not automatically analyzed.

The local IndexedDB cache transactionally stores a private copy, extracted pages,
and chunks; chat JSON stores only references. Renaming/moving the original file
does not remove NTH's copy. References remain with their chat across restarts and
context compaction. Missing/damaged cache entries preserve the chat and ask for
reattachment. Clearing/deleting a saved chat removes its associated file cache
after the chat-history write succeeds. This is not a global file library.

Follow-ups, filenames, and ordinal references such as “the second file” resolve
against that conversation. Lexical/BM25-style retrieval selects excerpts within
the existing 24,000-character context budget. Summaries process every extracted
section in order before combining notes—never just the first matching chunks.
Large summaries are capped at 24 local section passes and ten minutes total for
those passes, with the existing 45-second per-call timeout and Stop support.
Requests exceeding the limit ask you to summarize fewer files at once.

FILE answers distinguish untrusted document evidence from general knowledge.
Filename/page citations open a small local **extracted-text** reader at the
relevant page; it is not a visual PDF renderer. Document-only recommendations
stay local. Freshness comparisons or forced WEB use short public-topic queries
through the existing search/verifier pipeline; document files are never uploaded.

Enter and Send return focus to the composer, which accepts a next draft during
generation (it is not queued or sent automatically). Shift+Enter stays multiline.
Completion, Retry, and Stop respect intentional focus changes, text selection,
Settings, and source interactions. Focus calls do not scroll the chat.

Run `npm test` for deterministic regression tests. With Ollama running,
`node scripts/smoke-documents.mjs` exercises real Gemma document follow-ups using
synthetic files only. `tests/browser.html` is a development-only UI harness with
synthetic PDF/text/error fixtures and a delayed mocked model (F8 completes a
reply); it is not part of the production build.

## Reliability (0.5.9)

Ollama health and the exact configured model are checked at startup and at a
30-second idle cadence. Retry refreshes the model check. Missing models are never
silently replaced; Settings offers the exact install command. SearXNG is checked
on demand and its failure does not block LOCAL conversations.

Search retains its existing two-worker limit, six-second native request limit,
and one transient retry, with a 25-second overall search budget. Generation and
vision have 45-second limits; verification has a 40-second limit. Stop cancels
active native requests and prevents queued work or late tokens from continuing.
Retry replaces the failed assistant response without adding a second user turn.

Chat snapshots use an atomic localStorage replacement. New turns and completed
operations save immediately, streaming snapshots are throttled, and interrupted
responses reopen as stopped, retryable entries. Damaged context metadata is
rebuilt from visible messages. Unreadable history is retained rather than
overwritten, and write failures are shown inside the app.

The last 100 diagnostic events stay on this device under `nth.diagnostics.v1`
and are available as `window.__NTH_DIAGNOSTICS__` after an event. They contain
operation/status metadata, not prompts, answers, images, or telemetry.

Run the regression checks with `npm test` and
`cargo test --manifest-path src-tauri/Cargo.toml`.

## Protected AI behavior

- Model: `hf.co/ggml-org/gemma-4-12B-it-GGUF:Q4_0`
- Policy: NTH Policy v2
- `think: false`
- `temperature: 0`
- Existing vision, SearXNG, ranking, and evidence-verification pipelines

## Development

```powershell
npm install
npm run tauri dev
```

## Release build

```powershell
npm run tauri build
```

Windows installers are written to `src-tauri/target/release/bundle`.

## Signed in-app updates

NTH checks its built-in GitHub release channel at startup and can install a
newer signed build from **Settings → App Update**. The embedded public key
validates every artifact; unsigned or differently signed packages are refused.

The updater private key is stored outside this repository at
`C:\Users\Schatten\.tauri\nth-updater.key`. Back it up securely. To publish
through GitHub Releases:

1. Add the private key content as the repository secret
   `TAURI_SIGNING_PRIVATE_KEY`.
2. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is password protected.
3. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`, then push an `app-vX.Y.Z` tag.

The included release workflow builds the NSIS installer, its signature, and
`latest.json`. The release channel is embedded in NTH, so users never need to
enter or manage an update URL.
