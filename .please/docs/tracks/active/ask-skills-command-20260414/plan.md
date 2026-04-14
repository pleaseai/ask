# Plan: `ask skills` Command

> Track: ask-skills-command-20260414
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: ask-skills-command-20260414
- **Issue**: (assigned in metadata after Issue creation)
- **Created**: 2026-04-14
- **Approach**: New `skills` citty namespace with `list|install|remove` subcommands, backed by a `.ask/skills/` vendored store, `.ask/skills-lock.json` lock file, and relative POSIX symlinks into each selected agent's `skills/` directory. Reuses `ensureCheckout` and the existing `findDocLikePaths` walker pattern.

## Purpose

Give users a single command family to surface and consume library-provided (producer-side) skill directories, mirroring `ask docs` for documentation. `install` makes skills actually usable by any supported coding agent (Claude Code, Cursor, OpenCode, Codex) without duplicating bytes across agent dirs.

## Context

- `ask docs` and `ask src` already use a shared `ensureCheckout` helper (`packages/cli/src/commands/ensure-checkout.ts`) and a generic walker (`packages/cli/src/commands/find-doc-paths.ts`). `ask skills` reuses the first verbatim and parallels the second with a `/skill/i` regex.
- Vendoring under `.ask/` is an established pattern: `.ask/docs/` + `.ask/resolved.json` are already managed by `packages/cli/src/ignore-files.ts` via a `# ask:start ... # ask:end` marker block. The same mechanism extends to `.ask/skills/` + `.ask/skills-lock.json` with a single patch payload edit.
- The existing `generateSkill` in `packages/cli/src/skill.ts` emits consumer-side `.claude/skills/<name>-docs/SKILL.md` files (docs pointers). Producer-side skills are orthogonal and must never collide with that path — we install under `<agent>/skills/<skill-name>/` (no `-docs` suffix).

## Architecture Decision

**Why a namespace command instead of flags on `ask install`**: `list` and `install` have incompatible semantics (read-only vs mutating) and `ask install` is already overloaded. A dedicated `skills` namespace keeps the mental model clean and keeps future subcommands (e.g. `ask skills update`) discoverable.

**Why a lock file instead of scanning**: `remove` must undo exactly what `install` did. Scanning `<agent>/skills/` at remove time would either over-delete (user-authored skills) or under-delete (agents removed from the detection list). The lock is the only safe source of truth.

**Why symlinks from agent dirs to `.ask/skills/` instead of copies**: copies triple/quadruple bytes across agent dirs and drift if the vendored copy is refreshed. A relative symlink from `.claude/skills/foo` → `../../.ask/skills/<key>/foo` stays in sync automatically and is safe to commit-ignore at the agent level (via the vendored-skills marker block).

**Why `.ask/skills/<spec-key>/<skill-name>/` not `.ask/skills/<skill-name>/`**: multiple libraries can ship skills with the same name. Namespacing by spec avoids collisions and makes `remove` a single `rm -rf` of the spec subdir.

**`<spec-key>` encoding**: replace `/`, `@`, `:` with `__` — reversible, grep-friendly, filesystem-safe on every platform. Examples: `npm__next__14.2.3`, `github__vercel__ai__v5.0.0`.

## Architecture Diagram

```
            ensureCheckout (existing)
                    |
                    v
    +----------------------------------+
    | ~/.ask/github/.../<ref>/         |
    +----------------------------------+
                    |
         findSkillLikePaths (new)
                    |
     +---list---+   +----install----+
     | stdout   |   |               |
     +----------+   v               v
              vendor(copy)    agent-detect + select
                    |               |
                    v               v
          .ask/skills/<key>/    symlinks in .claude/skills/ etc
                    \              /
                     \            /
                      v          v
                 .ask/skills-lock.json
                 (updated atomically)
```

## Tasks

- [x] T001 [P] Add `findSkillLikePaths` walker in `packages/cli/src/commands/find-skill-paths.ts` plus tests in `packages/cli/test/commands/find-skill-paths.test.ts` (file: packages/cli/src/commands/find-skill-paths.ts). Mirrors `findDocLikePaths` with regex `/skill/i`; same MAX_DEPTH=4 and SKIP_DIRS. Acceptance: returns root + all `/skill/i` subdirs; empty array on missing root.
- [ ] T002 [P] Add spec-key encoder `encodeSpecKey` in `packages/cli/src/skills/spec-key.ts` + tests (file: packages/cli/src/skills/spec-key.ts). Converts resolved `(ecosystem, name, version)` to `{ecosystem}__{name}__{version}` (with `/` → `__`). Acceptance: round-trips via `decodeSpecKey` for at least npm, github, scoped-npm, monorepo-tag cases.
- [ ] T003 [P] Add `.ask/skills-lock.json` schema + IO helpers in `packages/cli/src/skills/lock.ts` + tests (file: packages/cli/src/skills/lock.ts). Functions: `readLock`, `upsertEntry`, `removeEntry`, `writeLockAtomic` (tmp-file + rename). Lock shape: `{ version: 1, entries: { [specKey]: { spec, specKey, skills: [{ name, agents: ["claude", ...] }], installedAt } } }`.
- [ ] T004 [P] Add agent detector in `packages/cli/src/skills/agent-detect.ts` + tests (file: packages/cli/src/skills/agent-detect.ts). Function `detectAgents(projectDir)` returns `{ name, label, skillsDir }[]` for every agent marker present: `.claude/` → `.claude/skills`, `.cursor/` → `.cursor/skills`, `.opencode/` → `.opencode/skills`, `.codex/` → `.codex/skills`. `AGENTS.md` alone does not enable any target.
- [ ] T005 [P] Implement `ask skills list` in `packages/cli/src/commands/skills/list.ts` (file: packages/cli/src/commands/skills/list.ts) (depends on T001). Mirrors `runDocs`: calls `ensureCheckout`, walks `node_modules/<npmPackageName>/` if set, walks the checkout, prints paths via `log()`. Honors `--no-fetch`. Includes unit tests with mocked `ensureCheckout`.
- [ ] T006 Implement vendor step `vendorSkills(projectDir, specKey, sourcePaths)` in `packages/cli/src/skills/vendor.ts` + tests (file: packages/cli/src/skills/vendor.ts) (depends on T002). Atomic: copy to `.ask/skills/<specKey>/<basename(sourcePath)>/` via staging dir + rename on success. Refresh-safe: replaces any prior version of the same vendored key.
- [ ] T007 Implement symlink utilities `linkSkill`, `verifyLink`, `unlinkIfOwned` in `packages/cli/src/skills/symlinks.ts` + tests (file: packages/cli/src/skills/symlinks.ts). Uses relative POSIX symlinks. `unlinkIfOwned` only unlinks when `fs.readlinkSync` resolves to the expected vendored target; never deletes real directories.
- [ ] T008 Extend `ignore-files.ts` to also vendor `.ask/skills/` and `.ask/skills-lock.json` (file: packages/cli/src/ignore-files.ts). Update `ROOT_PATCHES` payloads for `.gitignore`, `.prettierignore`, `sonar-project.properties`, `.markdownlintignore`. Add a test that `manageIgnoreFiles('install')` produces the new marker block content.
- [ ] T009 Implement `ask skills install` in `packages/cli/src/commands/skills/install.ts` (file: packages/cli/src/commands/skills/install.ts) (depends on T002, T003, T004, T005, T006, T007, T008). Orchestrates: resolve via `ensureCheckout` → walk → vendor → detect → multiselect (if >1) via `consola.prompt` → symlink → update lock → `manageIgnoreFiles('install')`. Flags: `--force`, `--no-fetch`, `--agent <name>[,<name>...]` (opt-in explicit override of detection). Emits `consola.info` summary of what was installed.
- [ ] T010 Implement `ask skills remove` in `packages/cli/src/commands/skills/remove.ts` (file: packages/cli/src/commands/skills/remove.ts) (depends on T003, T007). Reads lock, iterates recorded symlinks, `unlinkIfOwned` each, deletes `.ask/skills/<specKey>/`, purges lock entry. Errors if lock entry missing (unless `--ignore-missing`).
- [ ] T011 Wire `skillsCmd` into `packages/cli/src/index.ts` (file: packages/cli/src/index.ts) (depends on T005, T009, T010). Default run (no subcommand) dispatches to `list`. Update `cli/commands.test.ts` / `src-docs-registration.test.ts` style test to assert `skills`, `skills list`, `skills install`, `skills remove` are all registered.
- [ ] T012 End-to-end integration test in `packages/cli/test/commands/skills.integration.test.ts` (file: packages/cli/test/commands/skills.integration.test.ts) (depends on T009, T010, T011). Happy path: install into a fixture with `.claude/` + `.cursor/`, verify vendored files, verify symlinks, verify lock; re-install is no-op; remove deletes everything.
- [ ] T013 Documentation update in root `README.md` and `packages/cli/README.md` (file: README.md) (depends on T011). Add `ask skills` section under CLI usage; mention v1 platform limits (Linux/macOS only).

## Dependencies

```
T001 ---\
T002 ---+--> T005 ---\
T003 ---|            +--> T009 --> T011 --> T012 --> T013
T004 ---|            |            ^
T006 ---|            |            |
T007 ---+------------+            |
T008 ---+-------------------------+
T010 ---(depends on T003, T007)---+
```

T001–T004 and T008 are [P] (parallel). T005 depends only on T001. T006–T007 are leaf utilities runnable after T002/T003 land. T009 is the integration point; it blocks T010–T013.

## Key Files

- **Reuse**: `packages/cli/src/commands/ensure-checkout.ts`, `packages/cli/src/commands/find-doc-paths.ts` (pattern reference)
- **Reuse**: `packages/cli/src/ignore-files.ts` (extend `ROOT_PATCHES` + `NESTED_CONFIGS`)
- **Reuse**: `packages/cli/src/markers.ts` (wrap/inject/remove)
- **Reference (unchanged)**: `packages/cli/src/skill.ts` (consumer-side `*-docs` SKILL.md — must NOT be touched)
- **New**: `packages/cli/src/skills/` (vendor, symlinks, lock, agent-detect, spec-key)
- **New**: `packages/cli/src/commands/skills/` (list, install, remove) + `packages/cli/src/commands/find-skill-paths.ts`
- **Modified**: `packages/cli/src/index.ts` (register `skillsCmd`)
- **Modified**: `README.md`, `packages/cli/README.md`

## Verification

- `bun run --cwd packages/cli lint` — zero errors.
- `bun run --cwd packages/cli test` — all new unit + integration tests pass.
- Manual smoke:
  1. `cd /tmp/ask-smoke && mkdir -p .claude .cursor && npm init -y && node <ask-cli>/dist/index.js skills install github:pleaseai/some-repo@v1`
  2. Confirm `.ask/skills/github__pleaseai__some-repo__v1/` populated, symlinks present in `.claude/skills/` and `.cursor/skills/`, `.gitignore` patched.
  3. Repeat same command — no error, no duplication.
  4. `skills remove ...` — all symlinks and vendored dir gone; lock entry purged.
- AC-1 through AC-7 from spec each covered by at least one automated test.

## Progress

- [ ] Phase 1 (T001–T004, T008): foundation utilities
- [ ] Phase 2 (T005–T007): list command + vendor/symlink primitives
- [ ] Phase 3 (T009–T011): install/remove orchestration + wiring
- [ ] Phase 4 (T012–T013): integration test + docs

## Decision Log

- 2026-04-14: chose symlink-based model over copy-per-agent after user guidance (중복 설치 방지).
- 2026-04-14: `<spec-key>` encoding uses `__` separator for grep-friendliness; alternative (URL encoding) rejected as harder to eyeball.
- 2026-04-14: Windows junction fallback deferred to a follow-up track; v1 assumes POSIX symlink support.

## Surprises & Discoveries

- (Filled in during implementation)
