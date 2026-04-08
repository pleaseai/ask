# Plan: Vendored Docs Ignore Management

> Track: ignore-vendored-docs-20260408
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: ignore-vendored-docs-20260408
- **Issue**: TBD
- **Created**: 2026-04-08
- **Approach**: Hybrid — self-contained nested config files + extend AGENTS.md auto-generated block + targeted root patching for nested-unaware tools

## Purpose

Mark `.ask/docs/` as vendored so lint/format/code-review tools skip it, while keeping the directory readable as AI context. Achieved by combining nested config files inside `.ask/docs/` (for tools that support hierarchical resolution) with an intent notice inside the existing AGENTS.md auto-generated block (consumed by AI review tools), and minimal root patching only for Prettier and SonarQube.

## Context

The existing CLI already manages `AGENTS.md` via `agents.ts:8-89` using a marker block pair (`<!-- BEGIN:ask-docs-auto-generated -->` / `<!-- END:ask-docs-auto-generated -->`) and writes `CLAUDE.md` with an `@AGENTS.md` import line. The new functionality plugs into that same lifecycle: `add`, `sync`, and `remove` already call `generateAgentsMd(projectDir)` at the tail end of their flow (`index.ts:282, 419-421, 469`) — `manageIgnoreFiles(projectDir)` is invoked at the same locations. The Zod `ConfigSchema` (`schemas.ts:57-60`) gains an optional `manageIgnores` field with default `true`.

## Architecture Decision

### Three categories, three strategies

1. **Category A (self-contained)** — write nested config files inside `.ask/docs/`. ESLint flat config, Biome, markdownlint-cli2, and Git all walk up from each file to find the nearest config, so a config dropped inside `.ask/docs/` automatically scopes itself to that directory without touching anything at the root.
2. **Category B (intent notice)** — extend the existing `generateAgentsMd` auto-generated block to prepend a "vendored / read-only" notice section. Avoids introducing a second marker convention; the existing block is already idempotently rewritten on every `add`/`sync`/`remove`.
3. **Category C (root patching)** — only Prettier (`.prettierignore`) and SonarQube (`sonar-project.properties`) lack nested resolution. Patch them through a small `MarkerBlock` helper that injects/refreshes/removes a `# <!-- ask:start -->` ... `# <!-- ask:end -->` block in-place.

### Why not patch root ESLint/Biome/Cursor?

- Root flat config files are user-owned JS/JSON whose AST surface is too broad to mutate safely.
- `.cursorignore` would block Cursor from reading docs as AI context — the opposite of ASK's value proposition.
- Nested config covers ESLint and Biome perfectly without touching the root.

### Why extend the existing auto-generated block?

`agents.ts` already owns a marker block. Introducing a second `<!-- ask:start -->` block would duplicate the idempotency machinery and confuse readers. Prepending the notice as a sub-section inside the existing block is a one-line edit.

### Idempotency model

All writes are read-modify-write with deterministic templates. The `MarkerBlock` helper (new file `markers.ts`) provides:

- `inject(content, block)` — insert if absent, replace if marker pair found
- `remove(content)` — strip the marker block; return content unchanged if not found
- `wrap(payload, syntax)` — wrap a payload in marker pair using the requested comment syntax (`html` for markdown, `hash` for properties/ignore)

## Architecture Diagram

```
ask docs add / sync / remove
        ↓
generateAgentsMd (existing — extended)
        ↓
manageIgnoreFiles (new)
        ↓
   ┌────┴────┬─────────────┐
   ↓         ↓             ↓
   A         B (folded     C
            into A's      (root patch)
            agents call)
   ↓                       ↓
.ask/docs/            .prettierignore
  .gitattributes      sonar-project.properties
  eslint.config.mjs   .markdownlintignore (legacy)
  biome.json
  .markdownlint-cli2.jsonc
```

## Tasks

- [x] **T-1** — Add `manageIgnores` to `ConfigSchema` (`packages/cli/src/schemas.ts`), update `packages/cli/test/schemas.test.ts`
- [x] **T-2** — Create `packages/cli/src/markers.ts` (pure helpers: `inject`, `remove`, `wrap`) + `packages/cli/test/markers.test.ts`
- [x] **T-3** — Create `packages/cli/src/ignore-files.ts` with `writeNestedConfigs` / `removeNestedConfigs` for `.ask/docs/.gitattributes`, `eslint.config.mjs`, `biome.json`, `.markdownlint-cli2.jsonc` + tests
- [x] **T-4** — Extend `packages/cli/src/agents.ts` to prepend vendored-docs notice inside the existing auto-generated block + update `packages/cli/test/agents.test.ts`
- [x] **T-5** — Add `patchRootIgnores` / `unpatchRootIgnores` in `ignore-files.ts` for `.prettierignore`, `sonar-project.properties`, legacy `.markdownlintignore` (detection-only, marker-block based) + tests
- [x] **T-6** — Orchestrator `manageIgnoreFiles(projectDir, mode)` in `ignore-files.ts`; respects `manageIgnores` config; consola logging
- [x] **T-7** — Wire `manageIgnoreFiles` into `addCmd`, `runSync`, `removeCmd` in `packages/cli/src/index.ts`
- [x] **T-8** — Integration test covering full add → remove lifecycle (`packages/cli/test/ignore-lifecycle.test.ts`)
- [x] **T-9** — Documentation: update root `CLAUDE.md` Gotchas and, if applicable, `packages/cli/README.md`

## Dependencies

```
T-1 (schema) ──┐
               ├──> T-6 (orchestrator) ──> T-7 (wiring) ──> T-8 (e2e)
T-2 (markers) ─┤                                            ↑
               │                                            │
T-3 (cat A) ───┤                                            │
               │                                            │
T-4 (cat B) ───┤                                            │
               │                                            │
T-5 (cat C) ───┘                                            │
                                                            │
                                                  T-9 (docs)
```

T-1, T-2, T-3, T-4, T-5 are independent and can land in any order. T-6 needs T-1/T-3/T-5. T-7 needs T-6 and (for the agents notice) T-4. T-8 needs all of the above.

## Key Files

| File | Role | New / Modified |
|---|---|---|
| `packages/cli/src/schemas.ts` | Add `manageIgnores` field | Modified |
| `packages/cli/src/markers.ts` | Marker block helpers (pure) | New |
| `packages/cli/src/ignore-files.ts` | Categories A/C + orchestrator | New |
| `packages/cli/src/agents.ts` | Extend block with vendored notice | Modified |
| `packages/cli/src/index.ts` | Wire `manageIgnoreFiles` into add/sync/remove | Modified |
| `packages/cli/test/markers.test.ts` | Marker helper unit tests | New |
| `packages/cli/test/ignore-files.test.ts` | Categories A/C unit tests | New |
| `packages/cli/test/ignore-lifecycle.test.ts` | E2E add/remove lifecycle | New |
| `packages/cli/test/agents.test.ts` | Vendored notice presence | Modified |
| `packages/cli/test/schemas.test.ts` | `manageIgnores` schema | Modified |

## Verification

- `bun run --cwd packages/cli test` — all unit + e2e tests green
- `bun run --cwd packages/cli lint` — no new lint warnings
- Manual smoke: in a temp dir with mock project (containing `.prettierignore` and `sonar-project.properties`), run `node packages/cli/dist/index.js docs add npm:react`, verify all artifacts. Then `docs remove react` and verify cleanup.
- Manual: confirm `.ask/docs/.gitattributes` is honored by `git check-attr` for a file inside `.ask/docs/`.
- AC-1 through AC-8 from spec each map to a test in T-3/T-4/T-5/T-8.

## Progress

- 2026-04-08: All 9 tasks complete. Test suite: 199 pass, 0 fail across 21 files. Lint clean for all new files (only pre-existing `package.json` sort-keys errors remain).

## Decision Log

- **2026-04-08**: Reuse existing `<!-- BEGIN:ask-docs-auto-generated -->` block in `agents.ts` instead of introducing a second marker convention (`<!-- ask:start -->`). Reduces code duplication and avoids confusion for readers.
- **2026-04-08**: Skip auto-patching root ESLint flat config / Biome / `.cursorignore`. ESLint and Biome are covered by nested configs inside `.ask/docs/`; `.cursorignore` would block AI context access (anti-goal). Documented in spec Out of Scope.
- **2026-04-08**: cubic and CodeRabbit need no dedicated configuration file patching — both auto-consume AGENTS.md/CLAUDE.md as context (verified via vendor docs). The single AGENTS.md notice transitively covers them.

## Outcomes & Retrospective

### What Was Shipped

- `markers.ts` (pure inject/remove/wrap helpers, two comment syntaxes)
- `ignore-files.ts` (nested-config writer, root-file patcher, top-level orchestrator with `manageIgnores` opt-out)
- Extended `agents.ts` auto-generated block with vendored-docs notice
- Schema field `ConfigSchema.manageIgnores` (optional, default `true`)
- Wired `manageIgnoreFiles(projectDir, mode)` into `addCmd`/`runSync`/`removeCmd`
- 43 new tests across markers, ignore-files, and a full add → remove lifecycle

### What Went Well

- Existing `agents.ts` marker block was reusable — no second marker convention needed
- Bun's nested workspaces let the existing test runner pick up new test files with zero config
- Spec carefully separated nested-capable tools (Cat A) from root-only tools (Cat C), so the implementation matched the design 1:1

### What Could Improve

- WebSearch verification of "tool X supports nested config" went through several wrong answers before landing on accurate sources. A canonical compatibility table inside the spec would have saved iterations.
- Worktrees require a manual `bun run --cwd packages/registry-schema build` before tests pass — surprising and easy to miss. Worth a `prepare` script.
- The PR creation hit a `PreToolUse` review-state hook mid-finalize. Documented in CLAUDE.md gotchas but easy to forget when chaining `/please:*` commands.

### Tech Debt Created

- Sub-threshold review note: ESLint flat config nested resolution should be empirically verified inside `.ask/docs/` (run `eslint .` from project root and confirm files inside `.ask/docs/` are skipped). My research supported it but I did not run an end-to-end check.
- Root `eslint.config.{js,mjs,ts}` and `biome.json` automatic patching is intentionally out of scope; if user feedback shows the nested-config approach is insufficient, revisit.

## Surprises & Discoveries

- **registry-schema not pre-built in worktree**: Full test suite failed with `Cannot find module '@pleaseai/registry-schema'` until `bun run --cwd packages/registry-schema build` was run. The CLI package imports compiled output from `dist/`, so worktrees need an initial build of the shared package. Candidate for a `postinstall` hook or test-time `prepare` step.
- **Marker `remove()` trailing-newline edge case**: First implementation left a stray `\n` after stripping a block in the middle of a file. Fixed by normalising the "after" segment's leading whitespace and only adding a trailing newline if the preserved tail doesn't already have one.
