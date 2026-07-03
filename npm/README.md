# npm distribution wrapper

> Internal note (not published). The published `@pleaseai/ask` package will be
> the Rust-binary wrapper generated from this directory by
> `scripts/generate-platform-packages.mjs`. Until the Rust port reaches parity,
> the published `@pleaseai/ask` is still the Bun-compiled TypeScript CLI from
> `packages/cli/`; this wrapper is prepared and tested but not yet the publish
> source (see track `rust-port-20260704`, the Phase 2 cut-over).

## Goal

Preserve the existing entrypoint — `bunx @pleaseai/ask` / `npx @pleaseai/ask` —
while shipping the Rust-compiled `ask` binary instead of a bundled JS CLI. The
layout follows the [Biome](https://github.com/biomejs/biome) optional-dependency
model, and the launch path uses the [esbuild](https://github.com/evanw/esbuild)
**copy-over-shim** optimization:

- `@pleaseai/ask` (the `ask/` dir) is a thin **wrapper** package. Its `bin`
  points at a Node launcher (`bin/ask.js`) that resolves and `exec`s the correct
  platform binary — used as a **fallback** when the copy-over did not run. The
  fallback forwards argv, stdio, exit code, and termination signals to the child.
- A `postinstall` step (`install.js`) copies the resolved platform binary
  **over** `bin/ask.js`, so npm's `.bin/ask` symlink resolves directly to native
  code. After install there is **no Node.js process on the hot path**.
- The shared platform resolver lives in `lib/resolve.js` (required by both the
  launcher and `install.js`); it is never the file overwritten by the copy-over,
  so re-running the postinstall (`npm rebuild`, `npm ci`) is idempotent.
- Per-platform packages (`@pleaseai/ask-<target>`) each carry one prebuilt binary
  and declare `os` + `cpu` so npm/bun install only the matching one.
- The wrapper lists every platform package under `optionalDependencies`, so a
  failed-to-match platform is skipped rather than failing the whole install.

### Package-manager note (bun)

The copy-over runs as a `postinstall` script. **npm** and **pnpm** run it by
default. **bun blocks lifecycle scripts for untrusted dependencies by default**,
so under `bun install` the copy-over does not run and `bin/ask.js` stays the JS
launcher — still fully functional, just without the startup win. bun users who
want the fast path add `@pleaseai/ask` to `trustedDependencies`:

```jsonc
{ "trustedDependencies": ["@pleaseai/ask"] }
```

`bunx @pleaseai/ask` continues to work regardless via the launcher fallback.

```
@pleaseai/ask                     (wrapper — bin/ask.js launcher)
├── @pleaseai/ask-darwin-arm64    (optionalDependency, os=darwin cpu=arm64)
├── @pleaseai/ask-darwin-x64
├── @pleaseai/ask-linux-x64
├── @pleaseai/ask-linux-arm64
├── @pleaseai/ask-linux-x64-musl
└── @pleaseai/ask-win32-x64       (ask.exe)
```

## Layout

- `ask/` — the wrapper package:
  - `bin/ask.js` — the runtime launcher. On a successful `postinstall` the
    copy-over replaces it with the native binary; it is left in place (and used
    as the fallback) on Windows, unsupported platforms, when lifecycle scripts
    are skipped, or if the copy fails.
  - `install.js` — the `postinstall` copy-over step.
  - `lib/resolve.js` — the shared platform resolver (never overwritten).
- `scripts/generate-platform-packages.mjs` — at release time, generates the
  per-platform package directories from the built `ask-<target>` assets and the
  release version, ready to `npm publish` each one.

## Release flow

1. `release-rust.yml` builds `ask-<target>` binaries + checksums.
2. `node npm/scripts/generate-platform-packages.mjs <version> <assets-dir>`
   materializes `npm/dist/<pkg>/` for each platform (and the wrapper, with the
   repo-root `README.md` + `LICENSE` copied in).
3. Publish each platform package, then the wrapper, with
   `npm publish ./<pkg> --access public` (CI: `id-token: write`, npm Trusted
   Publishing/OIDC — no token, provenance generated automatically).

## Homebrew note

The unix asset names emitted by `release-rust.yml` (`ask-darwin-arm64`,
`ask-darwin-x64`, `ask-linux-x64`, `ask-linux-arm64`) are also what the
`pleaseai/homebrew-tap` `ask.rb` formula downloads. Renaming them here would
break `brew install` — keep the two in sync.
