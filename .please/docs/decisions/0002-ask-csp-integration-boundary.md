---
adr: 0002
title: ask ↔ csp integration boundary (acquisition feeds retrieval)
status: Accepted
date: 2026-07-02
---

# ADR-0002: ask ↔ csp integration boundary (acquisition feeds retrieval)

## Status

Accepted (implemented 2026-07-02, track `ask-csp-integration-20260701`).

## Context

`ask` (Agent Skills Kit) and `csp` ([pleaseai/code-search](https://github.com/pleaseai/code-search))
both serve AI coding agents, and their scopes are adjacent enough that "should they merge / share a
language / call each other in-process?" is a real question. Two forces prompted this ADR:

1. A proposal to **rewrite the ask CLI in Rust** (the `amondnet/rust` branch) — primarily motivated
   by startup time, after noticing csp is a fast Rust binary.
2. The need to make ask's stated use case — *"how does X work internally"* — actually good, which
   requires **searching** a library's source, not just fetching it.

### What the two tools actually are

- **ask** = **acquisition / provenance.** Resolves a spec to the *exact installed/pinned version* and
  materializes its docs + source tree into the PM-unified store
  (`~/.ask/github/<host>/<owner>/<repo>/<ref>/`). I/O-bound (registry lookups, git clone, tarball).
- **csp** = **retrieval / relevance.** Indexes an on-disk code tree (tree-sitter chunking +
  Model2Vec `potion-code-16M` embeddings + BM25, fused via RRF) and returns ranked snippets for a
  natural-language query at ~98% fewer tokens than grep+read. CPU-bound.

Neither completes the internal-source use case alone: ask guarantees the corpus is the correct
version's real source; csp makes that corpus semantically queryable.

### Startup benchmark evidence (why "rewrite ask in Rust for speed" is weak)

Measured on this machine (hyperfine, `--warmup 20 --min-runs 50`, `--version` and a real `list`):

| Runtime / form | startup |
|---|---:|
| ask: node (current bin) | ~160 ms |
| ask: bun (script) | ~90 ms |
| ask: bun --compile (standalone binary) | ~90 ms |
| Rust native binary via **node launcher** (opensrc/csp npm shim) | ~68 ms |
| Rust native binary **direct on PATH** (opensrc, reqwest-class deps) | ~6.6 ms |

Findings: (a) `bun --compile` does **not** reduce startup — it bundles JS but still boots
JavaScriptCore. (b) A Rust binary distributed on npm behind a Node launcher (`spawnSync`) pays
Node's ~60 ms boot on every call — ~90 % of the native advantage evaporates; the fast 6.6 ms only
materializes with direct-on-PATH distribution (curl/brew/cargo-binstall, or a copy-over-shim npm
layout). (c) For ask's dominant `install` workload, git/network I/O dwarfs startup regardless.

## Decision

### 1. ask stays TypeScript; csp stays Rust.

The language split follows the workload: **ask is I/O-bound (Rust buys little), csp is CPU-bound
(Rust is justified).** ask additionally shares its zod schema (`@pleaseai/ask-schema`) with the Nuxt
registry and integrates JS-only `@tanstack/intent`; a rewrite would fork both. Startup — the stated
motivation — is better addressed by distribution + bundling than by language, and does not move the
I/O-bound commands. **The Rust-port proposal is declined for ask.**

### 2. The integration is loosely coupled: two processes, contract = a path.

- **ask owns acquisition; csp owns retrieval.** ask resolves spec→pinned path; csp turns path→ranked
  snippets.
- **The handoff is a filesystem path, not an in-process API / FFI.** `ask src --json` emits
  `{ …, checkoutDir }`; `ask search` spawns `csp search "<query>" <checkoutDir>`. This is precisely
  what lets the two stay in different languages (decision 1).
- **csp is optional.** ask never hard-depends on it; when csp is absent, ask prints the path + a
  runnable recipe and exits 0.

### Invariants

- **INV-1: ask does not search.** Ranking / embeddings / chunking stay in csp.
- **INV-2: csp does not resolve versions or fetch from registries.** It consumes an existing corpus.
  (ask's cache-gc note about stale csp indexes only *informs* — it never invokes csp.)
- **INV-3: ask does not hard-depend on csp.** Runtime PATH/`CSP_BIN` probe; graceful degradation.
- **INV-4: the contract is process + path.** No shared library; enables the TS/Rust split.

## Consequences

- **Positive:** each tool stays in its right language; either can evolve independently; the combined
  `ask src → csp` pipeline delivers version-accurate, token-efficient internal-source answers; no new
  runtime dependency in the CLI.
- **Negative / trade-offs:** two binaries to install for the full experience (mitigated by graceful
  degradation + recipe); csp's index cache keys on source path + content-selection + ref, not file
  bytes, so a mutable-ref checkout re-fetched after `ask cache gc` could serve a stale index (bounded;
  FR-C3 note + `csp clear index` escape hatch). Pinned refs — the common case — are unaffected.
- **Distribution follow-up (separate track):** if ask's own startup ever matters, prefer an
  esbuild single-bundle + lazy `import()` (≈90→40 ms) and/or a direct-on-PATH binary layout over a
  language rewrite.

## Alternatives considered

- **Rewrite ask in Rust for one fast toolchain.** Declined — see decision 1 (I/O-bound; shared
  schema + intent; startup is a distribution problem).
- **Embed csp as an in-process library/FFI.** Declined — violates INV-4 and forces a shared language.
- **csp learns to resolve specs / fetch repos.** Declined — violates INV-2; csp *can* take a git URL,
  but ask deliberately passes the local checkout so acquisition stays in ask.
