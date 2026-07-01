---
product_spec_domain: cli/ask-csp-integration
---

# ask ↔ csp Integration — Acquisition Feeds Retrieval

> Track: ask-csp-integration-20260701

## Overview

`ask` (Agent Skills Kit) and `csp` ([pleaseai/code-search](https://github.com/pleaseai/code-search))
are two halves of the same agent-context pipeline:

```
ask  (what to acquire, at which version)   →   csp  (which slice answers the query)
   acquisition / provenance                       retrieval / relevance
```

- **ask** resolves a library spec to the *exact installed/pinned version* and materializes its
  source tree into the PM-unified store (`~/.ask/github/<host>/<owner>/<repo>/<ref>/`).
- **csp** indexes a code tree (tree-sitter chunking + Model2Vec `potion-code-16M` embeddings + BM25,
  fused via RRF) and returns ranked snippets for a natural-language query at ~98% fewer tokens than
  grep+read.

Neither tool alone completes ask's stated use case *"how does X work internally"*. Together they do:
ask guarantees the corpus is the **correct version's real source**; csp makes that corpus
**semantically queryable and token-efficient**.

This track defines a **loosely-coupled** integration where ask owns spec→path and csp owns
path→snippets. ask never performs search; csp never performs version resolution or registry fetch.
csp is an **optional** dependency — ask degrades gracefully when it is absent.

## Boundary Invariants (must not be violated)

- **INV-1: ask does not search.** ask stops at emitting a version-pinned path + metadata. Ranking,
  embeddings, and chunking stay in csp.
- **INV-2: csp does not resolve versions or fetch from registries.** csp only consumes an existing,
  on-disk corpus path. *What* to index and *at which version* is ask's responsibility.
- **INV-3: ask does not hard-depend on csp.** No `dependencies`/`optionalDependencies` entry that
  breaks `ask install` when csp is missing. Detection is runtime (PATH probe), failure is a
  helpful recipe, not an error.
- **INV-4: The handoff contract is a path, not an in-process API.** The two binaries stay separate
  processes; the contract is `ask`'s stdout (`checkoutDir`) → `csp index/search` argv. This is what
  lets ask stay TypeScript and csp stay Rust (see decision `ask-stays-ts-csp-stays-rust`).

## Requirements

### Functional Requirements

#### A. Stable machine-readable handoff from `ask src`

- [ ] FR-A1: Add `ask src <spec> --json` emitting a single JSON object with the fields already on
  `EnsureCheckoutResult`: `{ spec, owner, repo, ref, resolvedVersion, checkoutDir, npmPackageName? }`.
  Mirrors the existing `ask docs --json` precedent (`packages/cli/src/commands/docs.ts`).
- [ ] FR-A2: `checkoutDir` in the JSON MUST be the immutable, version-pinned store path
  (`~/.ask/github/<host>/<owner>/<repo>/<ref>/`). This path is content-stable per ref, which csp
  relies on for index-cache reuse (FR-C2).
- [ ] FR-A3: Default (non-`--json`) behavior of `ask src` is unchanged — prints `checkoutDir` only.
  `--no-fetch` semantics unchanged (exit 1 on cache miss).

#### B. Convenience command `ask search` (ask-side wrapper, csp-optional)

- [ ] FR-B1: Add `ask search <spec> <query> [--content code|docs|config|all] [--top-k N]`.
  Pipeline: `ensureCheckout(spec)` → detect csp → `csp search "<query>" <checkoutDir> [--content <c>]
  [--top-k <n>]` → stream csp stdout through verbatim. **Path is a positional arg after the query**
  (verified against csp clap defs, Phase 0). No separate `csp index` step is required — `csp search`
  auto-indexes into `~/.csp/index/` and reuses the cache (see FR-C1).
- [ ] FR-B2: csp detection order: (1) `CSP_BIN` env override, (2) `csp` on `PATH`, (3) not found.
- [ ] FR-B3: **Graceful degradation** — when csp is not found, print the resolved `checkoutDir` plus
  a copy-pasteable recipe (`csp search "<query>" <dir>`) and exit 0. ask must never fail solely
  because csp is absent (INV-3).
- [ ] FR-B4: `ask search` forwards csp's exit code when csp *is* present (so agents/scripts see real
  failures), except the csp-absent path which is exit 0 with the recipe.
- [ ] FR-B5: `--content` maps to csp `--content` (repeatable enum); `--top-k` maps to csp `--top-k`/`-k`.
  ask forwards them without interpretation, keeping INV-1 intact. ask passes the **local** checkoutDir
  (never a git URL) even though csp accepts URLs — honoring INV-2.

#### C. Index-cache coordination

- [ ] FR-C1: ask does **not** pre-index by default. `csp search` auto-indexes into
  `~/.csp/index/<sha256>/`, keyed by `{ normalized source path, sorted content-selection, git_ref }`
  (verified in `crates/csp/src/indexing/cache.rs`, Phase 0). ask relies on this auto-cache; an
  optional `--prewarm` calling `csp index <dir> -o <path>` is a non-default nicety only.
- [ ] FR-C2: Because ask's `checkoutDir` (`~/.ask/github/.../<ref>/`) is a distinct, content-stable
  path per pinned ref — and `ensureCheckout` never mutates an existing checkout in place — csp's
  path-derived key maps 1:1 to a stable corpus, so a given ref is indexed at most once across all
  `ask search` invocations. Holds without any csp change.
- [ ] FR-C3: `ask cache gc` / store eviction that removes a `checkoutDir` SHOULD surface a note
  that any csp index built over that path is now stale (csp owns its own `csp clear`; ask only
  informs — INV-2).

#### D. Agent discovery surface

- [ ] FR-D1: Document the combined recipe in the generated skill / AGENTS.md guidance so agents
  learn the `ask src → csp` pattern (e.g. a `<pkg>-docs` skill note: "for internal source
  questions, run `ask search <pkg> \"<question>\"`").
- [ ] FR-D2: The recipe text is emitted only when the integration command exists; no behavioral
  change to AGENTS.md generation for docs-only entries.

### Non-Functional Requirements

- [ ] NFR-1: Zero startup regression for existing commands — `ask search`/`--json` are additive; the
  hot path of `install`/`list`/`docs`/`src` is untouched.
- [ ] NFR-2: No new runtime dependency in `packages/cli/package.json` (csp is spawned, not imported).
- [ ] NFR-3: `runSearch` is unit-testable with injected deps (mock `ensureCheckout`, mock csp spawn),
  same test-seam pattern as `runSrc`/`runDocs`.
- [ ] NFR-4: Cross-platform csp resolution (PATH probe works on darwin/linux/win32).

## Out of Scope

- Porting ask to Rust (explicitly rejected — see decision `ask-stays-ts-csp-stays-rust`; ask is
  I/O-bound, csp is CPU-bound).
- Embedding csp as an in-process library / FFI. The contract is process + path (INV-4).
- csp changes. This track only touches ask; csp consumes an unchanged CLI surface.
- Bundling/startup optimization of ask (separate track; not required for this integration).

## Open Questions

- OQ-1: Should `ask search` also accept a bare local path (already-checked-out dir) in addition to a
  spec, so it works outside the ask store? (Leaning yes — thin, keeps INV boundaries.) **Still open.**
- OQ-2: **RESOLVED (Phase 0).** csp takes the directory as a **positional** arg after the query
  (`csp search "<query>" <dir>`, defaults to `.`), not a `--path` flag. `--limit` is actually
  `--top-k`/`-k`. See [phase0-findings.md](./phase0-findings.md).
- OQ-3: **RESOLVED (Phase 0).** csp's index is content-addressed by `{normalized source path,
  content-selection, git_ref}` (SHA256 → `~/.csp/index/<hash>/`), not by a hash of file bytes.
  `csp search` auto-indexes+reuses. FR-C2's "index once per pinned ref" holds because ask's per-ref
  checkoutDir is a distinct, stable path. Byte-level auto-invalidation is a future csp task (T016),
  so mutable-ref staleness after clean+re-fetch is a bounded, low risk (see R2 / FR-C3).
