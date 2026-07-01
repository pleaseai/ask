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

## Phase 2 — `ask search` wrapper (FR-B*, FR-C*)

Depends on Phase 0 (exact csp argv) + Phase 1 (shared resolution path).

- [ ] New `packages/cli/src/commands/search.ts` with `runSearch(options, deps)`:
      - `deps.ensureCheckout` (default real), `deps.spawn` (default `node:child_process`),
        `deps.resolveCsp` (default PATH/`CSP_BIN` probe), `deps.log/error/exit`.
      - Flow: `ensureCheckout(spec)` → `resolveCsp()`:
        - **found:** `spawn(csp, ['index', checkoutDir])` (idempotent) then
          `spawn(csp, ['search', query, '--path', checkoutDir, ...contentArgs, ...limitArgs])`
          with `stdio: 'inherit'`; forward exit code (FR-B4).
        - **not found:** print `checkoutDir` + recipe, `exit(0)` (FR-B3).
- [ ] `csp` resolution helper: `CSP_BIN` env → `which csp`/PATH scan → null (FR-B2, NFR-4).
- [ ] Register `search: searchCmd` in `packages/cli/src/index.ts` subCommands (next to `src`, `docs`).
- [ ] Tests: found-path (asserts index-then-search argv + forwarded exit code), not-found-path
      (asserts recipe + exit 0), `--content`/`--limit` pass-through, `--no-fetch` propagation.

**Files:** `commands/search.ts`, `commands/resolve-csp.ts`, `index.ts`, `test/commands/search.test.ts`.
**Exit:** `ask search react "how does useState schedule re-renders"` streams csp snippets when csp is
installed; prints a runnable recipe when it is not.

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
