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

(Filled by /please:tasks — see Phase 4 task generation.)

### T-1 — Add `manageIgnores` to ConfigSchema

- Extend `ConfigSchema` in `packages/cli/src/schemas.ts` with `manageIgnores: z.boolean().optional().default(true)`
- Update tests in `packages/cli/test/schemas.test.ts`
- **Files**: `schemas.ts`, `schemas.test.ts`

### T-2 — Create `markers.ts` helper

- New module providing `inject`, `remove`, `wrap` for marker blocks
- Two comment syntaxes: `html` (`<!-- ask:start -->`) and `hash` (`# <!-- ask:start -->`)
- Pure functions, no I/O
- **Files**: `packages/cli/src/markers.ts`, `packages/cli/test/markers.test.ts`

### T-3 — Create `ignore-files.ts` module (Category A)

- Function `writeNestedConfigs(projectDir)` that creates 4 files inside `.ask/docs/`:
  - `.gitattributes`, `eslint.config.mjs`, `biome.json`, `.markdownlint-cli2.jsonc`
- Function `removeNestedConfigs(projectDir)` deletes them
- **Files**: `packages/cli/src/ignore-files.ts`, `packages/cli/test/ignore-files.test.ts`

### T-4 — Extend `generateAgentsMd` with vendored notice (Category B)

- Modify `packages/cli/src/agents.ts` to prepend a "Vendored Documentation" sub-section inside the existing auto-generated block
- Notice text per spec FR-B1
- Update `packages/cli/test/agents.test.ts`
- **Files**: `agents.ts`, `agents.test.ts`

### T-5 — Add root patching for Prettier and Sonar (Category C)

- New functions `patchRootIgnores(projectDir)` and `unpatchRootIgnores(projectDir)` in `ignore-files.ts`
- Detect `.prettierignore`, `sonar-project.properties`, legacy `.markdownlintignore` and patch in place using `MarkerBlock`
- Skip silently if file absent
- For legacy `.markdownlintignore`, also `consola.warn` recommending markdownlint-cli2
- **Files**: `ignore-files.ts`, `ignore-files.test.ts`

### T-6 — Top-level `manageIgnoreFiles` orchestrator

- Single entry point in `ignore-files.ts` exporting `manageIgnoreFiles(projectDir, mode: 'install' | 'remove')`
- Reads `manageIgnores` from config; short-circuits if `false`
- Calls `writeNestedConfigs` + `patchRootIgnores` (install) or `removeNestedConfigs` + `unpatchRootIgnores` (remove)
- Logs created/updated/removed files via consola (FR-E2)
- **Files**: `ignore-files.ts`, `ignore-files.test.ts`

### T-7 — Wire into add/sync/remove commands

- `addCmd.run`: call `manageIgnoreFiles(projectDir, 'install')` after `generateAgentsMd`
- `runSync`: same call after `generateAgentsMd` block
- `removeCmd.run`: if `listDocs(projectDir).length === 0` after removal, call `manageIgnoreFiles(projectDir, 'remove')`; otherwise `'install'` to keep things in sync
- **Files**: `index.ts`

### T-8 — Integration test for add/remove lifecycle

- E2E test: add a doc → assert all 4 nested files + agents notice + root patches present (when those root files exist) → remove doc → assert all artifacts cleaned up
- **Files**: `packages/cli/test/ignore-lifecycle.test.ts`

### T-9 — Documentation

- Update `packages/cli/README.md` (if it documents config) with `manageIgnores`
- Update root `CLAUDE.md` Gotchas section if relevant
- **Files**: `README.md`, root `CLAUDE.md`

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

(Filled during implementation.)

## Decision Log

- **2026-04-08**: Reuse existing `<!-- BEGIN:ask-docs-auto-generated -->` block in `agents.ts` instead of introducing a second marker convention (`<!-- ask:start -->`). Reduces code duplication and avoids confusion for readers.
- **2026-04-08**: Skip auto-patching root ESLint flat config / Biome / `.cursorignore`. ESLint and Biome are covered by nested configs inside `.ask/docs/`; `.cursorignore` would block AI context access (anti-goal). Documented in spec Out of Scope.
- **2026-04-08**: cubic and CodeRabbit need no dedicated configuration file patching — both auto-consume AGENTS.md/CLAUDE.md as context (verified via vendor docs). The single AGENTS.md notice transitively covers them.

## Surprises & Discoveries

(Filled during implementation.)
