# Global ASK docs store at `~/.ask/`

> Track: global-docs-store-20260410
> Type: feature

## Overview

ASK currently materializes downloaded documentation into the **per-project** directory `.ask/docs/<pkg>@<v>/`. Every project that uses `next@16.2.3` pays the full 421-file disk cost again, and every `github:` source re-downloads the same tar.gz instead of reusing a shared git object cache. This track introduces a **global immutable docs store** at `~/.ask/` (with `ASK_HOME` environment override) so identical `<pkg>@<version>` entries are fetched and stored once per machine and reused across projects — the same idea Cargo, Go modules, pnpm, and Deno all converged on.

The store is **orthogonal to the in-place npm optimization** tracked separately in `in-place-npm-docs-20260410`. This track covers the `github:`, `web:`, `llms-txt:`, and "npm tarball miss" cases where ASK still needs to materialize files somewhere; that track covers the "docs are already sitting in `node_modules/<pkg>/<subdir>`" case. Both tracks can ship in either order without blocking each other because they touch different code paths (`storage.ts` + `sources/*` for this one, `discovery/*` + AGENTS.md emission for the other).

## Motivation

- **Cross-project dedup**: A developer running 5 Next.js projects on one machine pays the `.ask/docs/next@16.2.3/` disk cost 5×. After this track: 1× in `~/.ask/npm/next@16.2.3/`, 5 thin pointer files in the project-local `.ask/docs/`.
- **Git source efficiency**: `github:vercel/next.js@v16.2.3` today re-downloads the full tar.gz on every `ask install`, even if another project on the same machine already has it. Cargo's model (single bare clone + per-ref checkout directory) handles this with one network fetch. ASK should do the same.
- **Multi-version coexistence**: Two projects pinning `next@15` and `next@16` already work today by having two copies, but they also keep two copies on every machine. With the store, each version is materialized once globally and referenced from anywhere.
- **Faster repeat installs**: Subsequent `ask install` runs on known versions become a near-instant "store lookup + pointer refresh" instead of a fetch-extract-write cycle.
- **Deterministic agent path**: The project-local pointer path stays `.ask/docs/<pkg>@<v>/` for AGENTS.md stability, so nothing about what the agent reads changes from the agent's point of view. The store is a backend implementation detail.

## Scope

### 1. Store layout at `~/.ask/`

```
~/.ask/                                                 # ASK_HOME (tilde-expanded)
├── npm/
│   └── <pkg>@<version>/                                # immutable; contains INDEX.md + docs tree
│       └── ...
├── github/
│   ├── db/
│   │   └── <owner>__<repo>.git/                        # shared bare clone
│   └── checkouts/
│       └── <owner>__<repo>/
│           ├── <short-sha-or-tag>/                     # one directory per checked-out ref
│           └── ...
├── web/
│   └── <sha256-of-normalized-url>/                     # crawled snapshots
│       └── ...
├── llms-txt/
│   └── <sha256-of-url>@<version>/
└── store.json                                          # minimal metadata: schema version, GC hints
```

### 2. `ASK_HOME` resolution

Precedence (first non-empty wins):

1. `ASK_HOME` environment variable (absolute path, tilde-expanded)
2. `~/.ask/` (default)

XDG enthusiasts can opt into data-directory placement via `ASK_HOME=$XDG_DATA_HOME/ask`. No automatic XDG detection — keeping resolution simple matches Cargo/bun.

### 3. Project-local references

Each project's `.ask/docs/<pkg>@<v>/` remains the canonical AGENTS.md target. How it's materialized from the store is configured by a new `ask.json` field + CLI flag:

```json
{ "storeMode": "copy" | "link" | "ref" }
```

- **`copy`** (default on Windows, safe default on all platforms): read the store entry, write a copy into `.ask/docs/<pkg>@<v>/`. Preserves today's behavior for anyone who doesn't opt in.
- **`link`**: create a symlink `.ask/docs/<pkg>@<v>/` → `<ASK_HOME>/npm/<pkg>@<version>/`. Zero disk dedup cost within a project, cross-project dedup via the store. Fallback to `copy` silently on Windows if symlink creation fails (no admin, Developer Mode off). Optional hardlink (per-file) fallback lives under a `link` subvariant if needed — out of scope for v1, tracked as follow-up.
- **`ref`**: no project-local materialization at all. AGENTS.md points directly at `<ASK_HOME>/npm/<pkg>@<version>/`. Maximum dedup, minimum disk. Used when the agent sandbox is known to be able to read `$HOME` (e.g. local dev, Cloudflare sandbox with bind mount). NOT recommended for Docker/CI runs by default.

CLI precedence: `--store-mode=<copy|link|ref>` beats `ask.json` beats default (`copy`).

### 4. Store writers

Each source adapter grows a "materialize into store" code path that writes to `<ASK_HOME>/<kind>/<key>/` under a temp directory + atomic rename, then `storage.ts` copies/links/refs from there to the project. Sources impacted:

- **`sources/npm.ts`**: on tarball fetch, extract into `<ASK_HOME>/npm/<pkg>@<version>/` (or skip if already present and `contentHash` matches). `NpmSource.fetch` returns both the store path and the file list so the project-side materializer can act.
- **`sources/github.ts`**: rewrite to use `<ASK_HOME>/github/db/<owner>__<repo>.git` as a bare clone (`git init --bare` + `git fetch origin <ref>`), then `git worktree add` or `git archive | tar x` into `<ASK_HOME>/github/checkouts/<owner>__<repo>/<ref>/`. Subsequent fetches of different refs reuse the bare db. Fall back to the current tar.gz path if `git` is not on PATH.
- **`sources/web.ts`**: crawl into `<ASK_HOME>/web/<sha256-normalized-url>/`. Content-addressed so the same URL produces the same store key regardless of which project is fetching it.

### 5. Concurrency and safety

- **Write lock per store entry**: a simple `<entry>.lock` file (created via `fs.openSync(..., 'wx')`) prevents two concurrent `ask install` runs from clobbering the same `<pkg>@<version>` directory. Readers do not need to lock because entries are immutable once finalized (atomic rename from temp).
- **Atomic writes**: always write to `<entry>.tmp-<random>` then `fs.renameSync` to `<entry>`. Partial directories are never observable.
- **Checksum validation**: compute a content hash over the finalized directory and persist it in a per-entry `.ask-hash` file. Skipped on read unless `--verify-store` is passed.

### 6. GC and introspection

Two new CLI commands:

- `ask cache ls [--kind npm|github|web|llms-txt]` — list store entries with sizes and last-use timestamps.
- `ask cache gc [--older-than 30d] [--dry-run]` — remove store entries no `ask.json` on the machine currently references. Walks `~/.ask/` + every `.ask/resolved.json` found under `$HOME` (configurable roots via `ASK_GC_SCAN_ROOTS`, defaults to `$HOME`).

### 7. Migration

- On first `ask install` under a CLI that supports the store, if `~/.ask/` does not exist, it is created. Existing project-local `.ask/docs/<pkg>@<v>/` directories are NOT touched automatically — they continue to work because `storeMode: 'copy'` is the default.
- A best-effort `ask cache adopt` command (out of scope for v1, tracked as follow-up) would scan the project-local tree and seed the store with anything it finds.

## Success Criteria

- [ ] SC-1: Running `ask install` on a fresh machine creates `~/.ask/npm/next@16.2.3/` with the full docs tree, and `.ask/docs/next@16.2.3/` in the project via the default `copy` mode. Content in both locations is byte-identical.
- [ ] SC-2: Running `ask install` in a **second** project on the same machine that also pins `next@16.2.3` does NOT re-fetch from the npm registry (no `https://` request), detects the store hit, and completes under 500ms for the next entry.
- [ ] SC-3: Running `ask install --store-mode=link` creates `.ask/docs/next@16.2.3/` as a symlink to `~/.ask/npm/next@16.2.3/` on Linux/macOS. On Windows, the CLI emits a `warn` line explaining the fallback to `copy` and still succeeds.
- [ ] SC-4: Running `ask install --store-mode=ref` on a project whose `ask.json` has a single `npm:next` entry writes AGENTS.md pointing at `<ASK_HOME>/npm/next@16.2.3/` directly and does NOT create `.ask/docs/next@16.2.3/`.
- [ ] SC-5: For a `github:vercel/next.js` entry with `ref: v16.2.3`, the first install creates `<ASK_HOME>/github/db/vercel__next.js.git` (bare) and `<ASK_HOME>/github/checkouts/vercel__next.js/v16.2.3/`. A second install of the same repo with a different ref reuses the bare db (no second clone) and only creates a new checkout directory.
- [ ] SC-6: Two concurrent `ask install` runs in two different projects pinning the same `next@16.2.3` do not corrupt the store: both succeed, exactly one performs the fetch, the other waits briefly on the lock and then reads the finalized entry.
- [ ] SC-7: `ask cache ls` enumerates existing entries with sizes. `ask cache gc --dry-run` reports entries that would be removed but does not touch anything. `ask cache gc` (no dry-run) removes them.
- [ ] SC-8: `ASK_HOME=/tmp/custom-store ask install` redirects all store writes under `/tmp/custom-store/`.
- [ ] SC-9: All existing tests remain green. New tests cover store layout, concurrency, symlink fallback, `ref` mode, and `cache gc`.

## Constraints

- **Backward compatible default** — `storeMode: 'copy'` keeps byte-identical output at the project level. No user who doesn't set `storeMode` observes any change in `AGENTS.md`, `.ask/docs/<pkg>@<v>/`, or `.ask/resolved.json` layout.
- **Windows must not regress** — the CLI must work without symlink privileges. `link` mode detects `EPERM`/`ERROR_PRIVILEGE_NOT_HELD` and falls back to `copy` with a single `warn` line per run.
- **No home-pollution beyond `~/.ask/`** — no new files under `~/.config/`, `~/.cache/`, or `~/.local/`. All ASK state lives under `ASK_HOME`.
- **Agent sandbox compatibility** — `ref` mode may be incompatible with Docker/CI where `$HOME` is not mounted. Default stays `copy` for this reason.
- **No change to `ask.json` schema defaults** — the new `storeMode` field is optional and defaults to `copy`. Existing `ask.json` files parse unchanged.
- **Cross-platform path encoding** — github slugs containing special characters are normalized to `<owner>__<repo>` (double underscore) to survive Windows filename rules.
- **No forced migration** — existing per-project `.ask/docs/` layouts continue to work indefinitely. The store is additive.

## Out of Scope

- `ask cache adopt` — scanning pre-existing project `.ask/docs/` trees and importing them into the store. Follow-up track.
- Content-addressed store (Nix/pnpm style) — `~/.ask/store/<sha256>/` with per-file dedup across different versions. YAGNI for current scale; revisit if store size grows past ~10GB for typical users.
- Network proxy / mirror configuration for the store. Inherits whatever the current sources use.
- Shared store across users on the same machine (multi-user installs). `ASK_HOME=/srv/ask` would technically allow it but locking semantics need more thought.
- `in-place-npm-docs` optimization (convention discovery pointing at `node_modules/<pkg>/<subdir>` directly, bypassing the store). Separate track: `in-place-npm-docs-20260410`.
- Claude Code skill emission changes. Orthogonal, covered by `skill-emission-opt-in-20260410`.
- XDG auto-detection. Explicit `ASK_HOME=$XDG_DATA_HOME/ask` is the escape hatch.
- Removing `.ask/resolved.json`. It still serves as the project's "which entries are declared and resolved" cache, unchanged.
