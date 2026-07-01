# Implementation Plan — ask ↔ csp Integration

> Track: ask-csp-integration-20260701
> Spec: [spec.md](./spec.md)

## Guiding principle

Ship the **stable contract first** (`ask src --json`), then the **convenience layer**
(`ask search`) on top of it. Each phase is independently useful and mergeable. csp stays optional
throughout.

## Phase 0 — Confirm csp CLI surface (blocks FR-B1/FR-C1) ✅ DONE

Resolved OQ-2/OQ-3. Full write-up: [phase0-findings.md](./phase0-findings.md).

- [x] Read csp's actual `index`/`search` argv (`crates/csp-cli/src/main.rs`) and cache semantics
      (`crates/csp/src/indexing/cache.rs`) in pleaseai/code-search@main.
- [x] OQ-2: `csp search` takes the dir as a **positional** arg after the query (`csp search "<q>" <dir>`,
      defaults `.`), NOT a `--path` flag. Limit flag is `--top-k`/`-k`.
- [x] OQ-3: index is content-addressed by `{normalized path, content-selection, git_ref}` → SHA256 →
      `~/.csp/index/<hash>/`; `csp search` auto-indexes. Per-ref stable path ⇒ FR-C2 holds, no csp change.
- [x] Spec updated (FR-B1, FR-B3, FR-B5, FR-C1, FR-C2, OQ-2, OQ-3).

**Pinned invocation ask will emit:** `csp search "<query>" <checkoutDir> [--content <c>] [--top-k <n>]`
(no separate `csp index`; auto-cache handles it).

## Phase 1 — `ask src --json` (FR-A*) ✅ DONE

The load-bearing, low-risk contract. No csp dependency.

- [x] `packages/cli/src/commands/src.ts`: added `--json` boolean arg + `SrcModelSchema` (zod).
- [x] On `--json`, serialize the `EnsureCheckoutResult` subset:
      `{ spec, owner, repo, ref, resolvedVersion, checkoutDir, npmPackageName }`
      (`npmPackageName ?? null`). Same zod-schema-as-output-contract style as `docs.ts`.
- [x] Default path (`log(result.checkoutDir)`) unchanged (FR-A3) — verified by smoke test.
- [x] Tests: 3 new cases (JSON shape, github→npmPackageName null, no-JSON-on-cache-miss).
      9/9 pass; tsc + lint clean.
- [x] E2E smoke: `ask src github:sindresorhus/slugify@v2.2.1 --json` → correct pinned
      `checkoutDir`; jq-style extraction resolves to a real on-disk dir (the csp handoff).

**Files:** `commands/src.ts`, `test/commands/src.test.ts`.
**Exit:** ✅ `ask src <spec> --json | jq .checkoutDir` returns the pinned path.

## Phase 2 — `ask search` wrapper (FR-B*, FR-C*) ✅ DONE

Depends on Phase 0 (exact csp argv) + Phase 1 (shared resolution path).

- [x] New `packages/cli/src/commands/search.ts` with `runSearch(options, deps)`:
      - injected `ensureCheckout`, `resolveCsp`, `runCsp` (wraps `spawnSync`, `stdio:'inherit'`),
        `log/error/exit`.
      - Flow: `ensureCheckout(spec)` → `resolveCsp()`:
        - **found:** `csp search "<query>" <checkoutDir> [--content …] [--top-k …]` (positional path,
          auto-cache — NO `csp index` step, per Phase 0); forward csp's exit code (FR-B4).
        - **not found:** print `checkoutDir` + runnable recipe, `exit(0)` (FR-B3, INV-3).
      - `buildCspArgs()` extracted + unit-tested (positional path, `--content` repeatable, `--top-k`).
- [x] `resolve-csp.ts`: `CSP_BIN` → PATH scan (PATHEXT on win32) → null (FR-B2, NFR-4).
- [x] Registered `search: searchCmd` in `index.ts` subCommands (next to `src`, `docs`).
- [x] Tests: 19 cases (buildCspArgs, csp-present forwards exit code, csp-absent recipe+exit0,
      content/top-k passthrough, cache-miss no-csp-spawn, resolver error) — all pass; tsc + lint clean.
- [x] **Live E2E** (csp actually installed at `/usr/local/bin/csp`):
      `ask search github:sindresorhus/slugify@v2.2.1 "how does slugify strip diacritics" --content docs
      --top-k 5` → ask cloned pinned checkout → csp auto-indexed + returned ranked snippets. Degradation
      path (PATH without csp) → path + recipe, exit 0. Both verified.

**Files:** `commands/search.ts`, `commands/resolve-csp.ts`, `index.ts`,
`test/commands/search.test.ts`, `test/commands/resolve-csp.test.ts`.

## Phase 3 — Agent discovery + cache note (FR-D*, FR-C3)

- [ ] `skill.ts` / AGENTS.md generation: when `ask search` exists, add a one-line hint to the
      generated `<pkg>-docs` skill ("internal source questions → `ask search <pkg> \"...\"`").
      Gate on integration presence (FR-D2).
- [ ] `store/cache.ts`: when eviction removes a `checkoutDir`, emit a note that csp indexes over it
      may be stale (informational only — INV-2). No csp invocation.
- [ ] Tests: skill snapshot includes the hint; cache-clean note asserted.

## Phase 4 — Docs + decision record

- [ ] ADR `.please/docs/decisions/ask-csp-integration.md`: the acquisition↔retrieval boundary,
      the four INVs, and why the contract is process+path (enables TS/Rust split).
- [ ] Decision `ask-stays-ts-csp-stays-rust` (referenced by spec Out-of-Scope): I/O-bound vs
      CPU-bound rationale + the startup benchmark evidence (node 160ms / bun 90ms / rust-native
      6.6ms / node-launcher 68ms).
- [ ] README + ARCHITECTURE.md: add the `ask src → csp` pipeline diagram and the combined recipe.

## Risks / mitigations

- **R1: csp argv drifts.** Mitigate by isolating the exact command (now pinned in Phase 0) in
  `resolve-csp.ts` + one argv-builder fn; a csp change touches one place. Add a smoke test that
  fails loudly if `csp --help` no longer advertises the positional path / `--top-k` / `--content`.
- **R2: csp index staleness on mutable refs — LOW/bounded (resolved Phase 0).** csp keys its cache on
  `{path, content, git_ref}`, not file bytes, and ask never mutates a `checkoutDir` in place. For the
  common **pinned ref**, path+content are stable ⇒ correct reuse. Staleness only arises after an
  explicit `ask cache clean` + re-fetch of a **moving ref** (branches — allowed by `ask src`, rejected
  by `ask.json` strict validation). Mitigation: FR-C3 note on cache-clean; advanced escape hatch is
  `csp clear index` or ask forwarding `--index`. No default-path change needed.
- **R3: Windows PATH probe.** Cover in `resolve-csp.ts` (`.exe`, `where` fallback) + NFR-4 test.

## Sequencing

Phase 1 is mergeable alone (pure additive JSON, high value for scripting). Phase 0 → Phase 2 is the
core. Phases 3–4 follow. Estimated: P1 small, P2 medium, P3–4 small.
