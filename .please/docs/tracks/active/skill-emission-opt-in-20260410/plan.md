# Plan: Default-off Claude Code skill emission

> Track: skill-emission-opt-in-20260410
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:new-track → /please:plan
- **Track**: skill-emission-opt-in-20260410
- **Issue**: TBD
- **Created**: 2026-04-10
- **Approach**: Guard-at-caller — add `emitSkill?: boolean` to the `AskJsonSchema`, plumb a `--emit-skill` CLI flag through `runInstall` options, and wrap the existing `generateSkill(...)` call in `installOne` with a single precedence-resolved boolean. The `skill.ts` helper stays untouched; the `agents.ts` output stays byte-identical; `ask remove` stays unchanged because `removeSkill` is already idempotent via `fs.existsSync`.

## Purpose

Stop emitting `.claude/skills/<name>-docs/SKILL.md` by default from `ask install`, because the eval evidence in this repo (`evals/nuxt-ui/`, 2026-04-10) and Vercel's public benchmark both show the skill delivery format underperforms the AGENTS.md pointer for the same docs payload. Preserve a frictionless opt-in escape hatch so early adopters who depend on the old behavior are not broken.

## Context

Today, `installOne` (`packages/cli/src/install.ts:197`) unconditionally calls `generateSkill(...)` after `saveDocs(...)`. Downstream, `runInstall` calls `generateAgentsMd(...)` + `manageIgnoreFiles(...)` once for the whole batch. The CLI surface in `packages/cli/src/index.ts:44` defines `installCmd` with only a `--force` boolean flag and delegates to `runInstall(cwd, { force })`. Schema validation lives in `packages/schema/src/ask-json.ts:69`: `AskJsonSchema` is `.strict()`, so any new field must be added explicitly or the parse will reject it.

`ask remove` (`packages/cli/src/index.ts:180`) already calls `removeSkill(projectDir, libName)` unconditionally, and `removeSkill` itself (`packages/cli/src/skill.ts:117`) checks `fs.existsSync(skillDir)` before deleting, so it's safe to leave as-is even when the default flips: pre-existing skill directories from old installs or from `--emit-skill` runs are still cleaned up.

## Architecture Decision

**Chosen: guard-at-caller, keep helper intact.**

Three options were considered:

1. **Delete `skill.ts` outright** — rejected. Loses the ability to re-enable by default if Claude Code improves skill auto-trigger heuristics and a future eval shows parity. Also orphans `removeSkill`, forcing a parallel cleanup implementation.

2. **Deprecation warning + two-release removal** — rejected. Extra release cycle noise. Users who care will read the CHANGELOG; users who don't will not read a deprecation warning either, and the `--emit-skill` flag is a zero-cost escape hatch.

3. **Guard-at-caller (chosen)** — single `if (emitSkill) generateSkill(...)` in `installOne`. `skill.ts` stays untouched so the helper is still testable, the remove path is unchanged, and the opt-in flag is cheap to wire. Minimal diff, maximum reversibility.

**Precedence resolution** for the `emitSkill` value (evaluated per `runInstall` call, not per-entry — it's a global install behavior, not a per-library setting):

```
explicit CLI flag (--emit-skill)   ← highest
  ↓ (if absent)
ask.json `emitSkill: true|false`
  ↓ (if absent)
false                              ← default
```

This matches how other boolean CLI flags override config files in ASK's codebase (`--force` has no corresponding ask.json field, so this is the first precedence chain we introduce — document it in CHANGELOG).

## Key Files

- `packages/schema/src/ask-json.ts:69` — `AskJsonSchema` top-level object; add `emitSkill: z.boolean().optional()` inside the `.strict()` block.
- `packages/cli/src/install.ts:40-57` — `RunInstallOptions` type + `runInstall` signature; add `emitSkill?: boolean` option, resolve against `askJson.emitSkill` with CLI flag winning.
- `packages/cli/src/install.ts:111-203` — `installOne` receives the resolved boolean via a new parameter and guards the `generateSkill(...)` call.
- `packages/cli/src/index.ts:44-57` — `installCmd` definition; add `emit-skill` boolean arg and pass it into `runInstall`.
- `packages/cli/src/index.ts:90-130` — `addCmd` similarly shares the install pipeline; add the same flag so `ask add npm:foo --emit-skill` works symmetrically.
- `packages/cli/src/index.ts:180` — `removeSkill` call site; no change needed (already idempotent).
- `packages/cli/test/install.test.ts` (or closest equivalent) — new tests covering SC-1 through SC-4.
- `packages/schema/test/ask-json.test.ts` (or closest equivalent) — new tests covering schema acceptance of `emitSkill`.
- `packages/cli/CHANGELOG.md` — unreleased entry.

## Tasks

- [ ] T001 [P] Add `emitSkill?: boolean` to `AskJsonSchema` and export the inferred type (file: packages/schema/src/ask-json.ts)
- [ ] T002 [P] Add schema tests verifying `emitSkill: true | false | undefined` all parse, and unknown keys still reject (file: packages/schema/test/ask-json.test.ts) (depends on T001)
- [ ] T003 Add `emitSkill?: boolean` to `RunInstallOptions` and resolve precedence inside `runInstall` (CLI flag > ask.json > false); thread the resolved value into `installOne` as a parameter (file: packages/cli/src/install.ts) (depends on T001)
- [ ] T004 Guard the `generateSkill(...)` call in `installOne` behind the resolved `emitSkill` boolean (file: packages/cli/src/install.ts) (depends on T003)
- [ ] T005 Add `--emit-skill` boolean flag to `installCmd` and `addCmd` in the CLI surface; pass it into `runInstall` options (file: packages/cli/src/index.ts) (depends on T003)
- [ ] T006 Add install tests: default run does NOT create `.claude/skills/<name>-docs/`; `--emit-skill` flag DOES create it; `ask.json` `emitSkill: true` DOES create it; CLI flag overrides ask.json (file: packages/cli/test/install.test.ts) (depends on T004, T005)
- [ ] T007 Add remove test: `ask remove <pkg>` cleans up a pre-existing `.claude/skills/<pkg>-docs/` directory even when the current `emitSkill` setting is false (file: packages/cli/test/remove.test.ts or closest) (depends on T005)
- [ ] T008 Add CHANGELOG entry under unreleased `@pleaseai/ask` section documenting the default flip and the opt-in precedence (`--emit-skill` > `ask.json` `emitSkill` > default false) (file: packages/cli/CHANGELOG.md) (depends on T004, T005)
- [ ] T009 Run `bun run --cwd packages/schema build && bun run --cwd packages/cli build && bun test` from root and verify all packages pass cleanly (depends on T006, T007, T008)

## Dependencies

```
T001 ──┬── T002 (schema tests)
       └── T003 ── T004 ── T006 ── T009
                    │         │
                    └── T005 ──┘
                         │
                         └── T007
                         │
                         └── T008
```

## Verification

- **Functional**:
  - `cd example && bun /path/to/cli/dist/cli.js install` → no `.claude/skills/` created; `.ask/docs/next@16.2.3/`, `AGENTS.md`, `CLAUDE.md` still created as before.
  - `cd example && bun /path/to/cli/dist/cli.js install --emit-skill` → `.claude/skills/next-docs/SKILL.md` appears with the same content today's output produces.
  - Add `"emitSkill": true` to `example/ask.json`, drop the flag, re-run install → skill file appears (ask.json wins when CLI flag is absent).
  - With `"emitSkill": false` in `ask.json` and `--emit-skill` on the CLI → skill file appears (CLI flag wins).
  - `ask remove npm:next` with a pre-existing `.claude/skills/next-docs/` → directory is removed regardless of current `emitSkill`.
- **Schema**: `bun test packages/schema` passes; new `emitSkill` cases green.
- **Install orchestrator**: `bun test packages/cli` passes; new install + remove tests green; existing tests unchanged.
- **Docs**: CHANGELOG diff present, references eval results in this repo + Vercel benchmark.

## Progress

- Spec drafted
- Plan drafted

## Decision Log

- 2026-04-10: Chose guard-at-caller over full removal or deprecation. Rationale in Architecture Decision section.
- 2026-04-10: CLI flag > ask.json > default precedence, matching conventional CLI override semantics. Documented in CHANGELOG per SC-6.

## Surprises & Discoveries

- (empty — to be populated during implementation)
