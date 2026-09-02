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
