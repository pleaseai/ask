# Plan — Rust port of `ask`

Phased migration. TS (`packages/cli/`) stays the published product until the
Rust line reaches parity (mirrors code-search ADR-0003 cut-over).

## Progress

- [x] Phase 0 — workspace + clap CLI skeleton (all subcommands, stubs, `--version`).
- [x] Phase 1 — npm copy-over shim (`npm/ask/`, generator). Launcher + generator
  verified locally.
- [x] Phase 2 — release-rust.yml, release-cargo.yml, release-please version sync.
  `cargo publish --dry-run` passes locally. NOT wired to auto-publish yet.
- [ ] Phase 3 — logic port (in progress):
  - [x] `spec` (parse_spec / slugify_npm_name) — 9 parity tests.
  - [ ] schemas / ask.json, io, registry, sources, resolvers, lockfiles, store,
    discovery, agents/skills, commands.
- [ ] Cut-over — swap release.yml binary source from Bun compile to Rust; retire
  the TS compile job.

## Phase 0 — Scaffold + walking skeleton  ← current

- Root `Cargo.toml` workspace (`members = ["crates/ask"]`), `workspace.package`
  (version `0.4.8` matching current CLI, `# x-release-please-version` anchor),
  release profile (lto, codegen-units=1, strip).
- `crates/ask/Cargo.toml` — `name = "ask-please"`, `[lib] name = "ask"`,
  `[[bin]] name = "ask"`.
- `rust-toolchain.toml` (channel `1.94.1`, rustfmt+clippy), `rustfmt.toml`.
- `crates/ask/src/{lib.rs,main.rs,cli.rs}` — clap derive CLI mirroring the full
  command surface. `--version` real; un-ported subcommands print a one-line
  "not yet ported (use npm/Homebrew build)" notice and exit non-zero.
- Gate: `cargo build --release` green, `ask --version` prints `0.4.8`,
  `ask --help` lists all subcommands.

## Phase 1 — npm copy-over shim

- `npm/ask/{package.json,install.js,bin/ask.js,lib/resolve.js}` +
  `npm/scripts/generate-platform-packages.mjs` + `npm/README.md`, adapted from
  code-search (rename pass). optionalDependencies pin the 6 platform packages.
- Local test: `cargo build --release`, run `bin/ask.js` fallback path against
  `target/release/ask` via `resolveDevBinaryPath`.

## Phase 2 — release + distribution wiring

- `release-rust.yml` (reusable): cross-compile `ask-cli` → 6 targets. Emit BOTH
  the npm asset names (`ask-<target>` per generator) AND the legacy Homebrew
  names (`ask-darwin-x64`, …). Simplest: build once per target, stage under both
  names, upload all. Verify `./asset --version` in-job.
- Extend `release-please-config.json` extra-files: sync `Cargo.toml` (generic
  marker) + `npm/ask/package.json` `$.version`.
- `release.yml`: add npm platform-package publish (Trusted Publishing/OIDC) and
  a `cargo publish -p ask-please` step. Keep Homebrew job; swap its binary source
  from `bun build --compile` to the Rust artifacts once Phase 3 hits parity.
- Do NOT delete the Bun compile job until cut-over.

## Phase 3+ — port CLI logic (module dependency order)

Bottom-up so each layer compiles against ported deps. Move the matching
`bun:test` suite with each module.

1. `spec` + `schemas` (ask.json union, specFromEntry/entryFromSpec, parseSpec)
2. `io` (readAskJson/writeAskJson lax, findEntry) + ignore-files + markers
3. `registry` (fetch w/ 10s timeout, detectEcosystem, selectBestStrategy)
4. `sources/*` (github clone-at-tag + fallback chain, npm local-first tarball,
   web html→md, llms-txt) — needs git, tar+flate2, html2md, http client
5. `resolvers/*` (npm/pypi/pub/maven metadata → owner/repo)
6. `lockfiles/*` (bun/npm/pnpm/yarn/package.json, format-aware)
7. `store/*` (cpDirAtomic verbatimSymlinks, hashDir, verifyEntry, quarantine,
   cache ls/gc/clean, STORE_VERSION)
8. `discovery/*` (local-ask, local-intent, local/repo conventions)
9. `agents` + `agents-intent` + `skill` + `skills/*` (marker blocks, symlinks)
10. `commands/*` + `install.rs` orchestrator + `list/*` render
11. Cut over release workflow to Rust artifacts; retire TS compile job.

## Dependency menu (Phase 3, opt-in per phase)

`clap` (derive), `serde`/`serde_json`, `anyhow`/`thiserror`, `reqwest` (rustls)
or `ureq`, `tar` + `flate2`, `sha2`, `ignore`, `walkdir`, an html→markdown crate
(`htmd`/`html2md`), `tempfile`, `regex` + `fancy-regex` (parity with TS
lookbehind patterns), `semver`. Git via `git2` or shelling `git` (decide when we
reach `sources/github` — csp shells `git`, matching the TS impl's execFile).

## Risks / open questions

- html→markdown crate parity with `node-html-markdown` output — may need
  golden-file tests and per-rule tuning.
- git2 (libgit2) vs shelling out — the TS impl shells `git` and relies on
  `GITHUB_TOKEN` URL injection + `redactToken`; shelling keeps behavioral parity
  and the private-repo host-exact-match auth logic 1:1. Lean shell-out.
- Windows path/symlink behavior for the store (`verbatimSymlinks` analog).
