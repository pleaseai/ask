# Rust Port of the `ask` CLI

**Track:** `rust-port-20260704`
**Status:** in_progress · phase: scaffold
**Owner:** Minsu Lee (@amondnet)

## Goal

Port the `@pleaseai/ask` CLI from Bun/TypeScript (`packages/cli/`) to Rust, and
ship it through three distribution channels:

1. **npm** — `@pleaseai/ask` as a thin **copy-over shim** wrapper over the Rust
   binary (esbuild/Biome/ast-grep model), preserving `npx @pleaseai/ask`.
2. **Homebrew** — `pleaseai/homebrew-tap` `ask.rb`, unchanged formula contract.
3. **Cargo** — `cargo install ask-please` (binary `ask`) published to crates.io.

## Reference

`pleaseai/code-search` (crate `code-search-please`, npm `@pleaseai/csp`) is the
proven blueprint — a Rust rewrite of a TS CLI distributed to exactly these three
channels. We mirror its *structure and distribution machinery*, not its
dependency menu (embeddings/tree-sitter are csp-specific). See its ADR-0003.

## Key decisions

### Crate topology — single lib+bin crate (NOT csp's 3-crate split)

csp splits `csp` / `csp-cli` / `csp-node` because it ships a napi Node SDK and an
MCP server. `ask` has neither (`ask search` *delegates to* csp; there is no
`ask mcp`). So:

- **One workspace member `crates/ask`** with both `[lib] name = "ask"` and
  `[[bin]] name = "ask"`. Published to crates.io as **`ask-please`** (the short
  names `ask` and `ask-cli` are already taken — verified via sparse index;
  mirrors csp's `code-search-please` fallback).
- **No `ask-node` napi crate** (YAGNI). No `rmcp`/`tokio`/`napi`/`schemars`.
- Dependency menu is derived from `ask`'s real surface, not csp's.

### Naming / identity (unchanged where user-facing)

| Thing            | Value                                    |
| ---------------- | ---------------------------------------- |
| Binary           | `ask`                                    |
| npm wrapper      | `@pleaseai/ask` (unchanged)              |
| npm platform pkg | `@pleaseai/ask-<target>`                 |
| crate            | `ask-please` (lib name `ask`)            |
| Homebrew tap     | `pleaseai/homebrew-tap` → `ask.rb`       |
| Release tag      | `ask-v<version>` (monorepo component tag)|

### Homebrew contract — MUST be preserved

Existing `.github/workflows/release.yml` builds these release assets that the tap
formula downloads. The Rust pipeline must emit the **same asset names** so the
formula keeps working unchanged:

- `ask-darwin-x64`, `ask-darwin-arm64`, `ask-linux-x64`, `ask-linux-arm64`
- plus a `<asset>.sha256` for each.

Note the tag is `ask-v<version>` (NOT csp's `v<version>`), because `packages/cli`
is a release-please component in this monorepo.

### npm copy-over shim — adopt csp's machinery verbatim (renamed)

`npm/csp/{bin/csp.js,install.js,lib/resolve.js}` +
`npm/scripts/generate-platform-packages.mjs` are production-grade and portable.
Copy → `npm/ask/…`, rename `csp`→`ask`, `@pleaseai/csp`→`@pleaseai/ask`,
`code-search`→`ask`, binary `csp`/`csp.exe`→`ask`/`ask.exe`. Platform matrix:
`darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, win32-x64`.

## Command surface to reach parity on

`ask install | add | remove | list | src | docs | fetch | search | skills | cache {ls|gc|clean}`

(from `packages/cli/src/index.ts`). Version injection: `env!("CARGO_PKG_VERSION")`.

## Parity oracle

The existing `bun:test` suites under `packages/cli/` are the behavioral spec —
port each module's tests alongside it. The `CLAUDE.md` gotchas list enumerates
non-obvious behavioral invariants the Rust port MUST preserve; each becomes a
Rust test:

- `cpDirAtomic` `verbatimSymlinks: true`
- strict `ask.json` ref validation (`--allow-mutable-ref` escape hatch)
- pnpm/yarn format-aware lockfile parsers (not regex)
- AGENTS.md marker-block byte-range disjointness (`ask-docs` vs `intent-skills`)
- `authenticatedCloneUrl` exact `github.com` host match (token never leaks)
- `AbortSignal.timeout(10s)` on registry fetch → Rust HTTP client timeout
- store layout `<askHome>/github/<host>/<owner>/<repo>/<tag>/`, no `github/db`
- `ensureCheckout` `skipDocExtraction: true`

## Migration strategy — phased, TS stays source of truth until parity

Mirrors csp/ADR-0003. The Rust tree lives beside the TS tree; the Bun-compiled
binary remains the published product until the Rust line reaches parity, then the
release workflow cuts over (asset names identical, so Homebrew is seamless).

See `plan.md` for the phase breakdown.
