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
- In-app settings and service status without developer-facing error dumps

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
