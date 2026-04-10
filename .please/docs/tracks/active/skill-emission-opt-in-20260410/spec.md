# Default-off Claude Code skill emission in `ask install`

> Track: skill-emission-opt-in-20260410
> Type: refactor

## Overview

`ask install` currently emits two documentation delivery artifacts per library:

1. A block inside `AGENTS.md` pointing the agent at `.ask/docs/<pkg>@<v>/` or the in-place `node_modules/<pkg>/<subpath>`.
2. A Claude Code skill file at `.claude/skills/<pkg>-docs/SKILL.md`.

Our own eval suite (`evals/nuxt-ui/`, 2026-04-10) just reproduced Vercel's public benchmark ["AGENTS.md outperforms skills in our agent evals"](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals): with identical docs payload, identical model (`claude-sonnet-4-6`), identical sandbox, and only the delivery format as the variable:

- `with-github-docs` (AGENTS.md pointer): **100% first-try pass rate (6/6)**
- `with-skill` (SKILL.md): **50% first-try pass rate (3/6)** — all three failures clustered on the v4 breaking-change evals (001 chat-message, 003 theme, 005 nullable) where reading docs actually matters.

Additionally, `.claude/skills/` is Claude Code-specific — `codex`, `cursor`, Amp, and other agents ignore it entirely. For every consumer, the skill file is either ineffective (Claude Code users get AGENTS.md anyway) or dead weight (non-Claude-Code agents never read it). Since AGENTS.md is strictly better on the evidence we have and universally readable, skill emission should stop being the default.

This track flips the default to **off** while preserving a no-config path for anyone depending on the old behavior. The skill generation helper (`packages/cli/src/skill.ts`) stays intact; only the install orchestrator's default call is guarded behind a new option.

## Scope

- **Schema** — `packages/schema/src/ask-json.ts`: add optional `emitSkill?: boolean` at the top level of `AskJsonSchema` (default `false`).
- **CLI** — `packages/cli/src/index.ts`: add `--emit-skill` boolean flag on `installCmd` (and `addCmd` where it shares the install pipeline). Flag overrides the `ask.json` value when present.
- **Install orchestrator** — `packages/cli/src/install.ts:runInstall`: after successful source fetch and `saveDocs`, call `generateSkill()` only when the resolved `emitSkill` value is `true`.
- **Remove path** — `packages/cli/src/index.ts:runRemove` (and wherever `removeSkill` is called): keep calling `removeSkill` unconditionally — it's already idempotent (checks `fs.existsSync(skillDir)`), so pre-existing skills from older ASK versions or from `--emit-skill` runs are still cleaned up on uninstall.
- **Tests** — unit and integration coverage for:
  1. Schema accepts `emitSkill: true | false | undefined`.
  2. Default `ask install` (no flag, no ask.json setting) does NOT create `.claude/skills/<name>-docs/`.
  3. `ask install --emit-skill` writes the skill file.
  4. `ask install` with `{ "emitSkill": true }` in `ask.json` writes the skill file.
  5. CLI `--emit-skill` overrides/matches the ask.json value (explicit win).
  6. `ask remove` cleans up an existing skill file regardless of the current `emitSkill` setting.
- **Docs** — CHANGELOG entry under the unreleased `@pleaseai/ask` section documenting the default change and the opt-in escape hatch. (README + evals READMEs already document the rationale in the previous commit.)

## Success Criteria

- [ ] SC-1: Running `ask install` on a fresh project (no prior `.claude/skills/`, no `emitSkill` in `ask.json`, no CLI flag) produces `.ask/docs/`, `AGENTS.md`, and `CLAUDE.md` but does NOT create `.claude/skills/`.
- [ ] SC-2: Running `ask install --emit-skill` on the same fresh project additionally creates `.claude/skills/<name>-docs/SKILL.md` with content identical to today's output for each installed library.
- [ ] SC-3: Running `ask install` with `{ "emitSkill": true, "libraries": [...] }` in `ask.json` (no CLI flag) produces the same skill files as SC-2.
- [ ] SC-4: Running `ask remove` on a library whose skill file exists (e.g. left over from a previous `--emit-skill` run or from ASK ≤ 0.3.x) removes both `.ask/docs/<name>@<v>/` and `.claude/skills/<name>-docs/`.
- [ ] SC-5: All existing unit/integration tests continue to pass, and new tests cover SC-1 through SC-4.
- [ ] SC-6: CHANGELOG entry is present under the `@pleaseai/ask` unreleased section explaining the default change and the `--emit-skill` / `emitSkill: true` opt-in path.

## Constraints

- **No removal of skill code path** — `packages/cli/src/skill.ts` (`generateSkill`, `removeSkill`, `getSkillDir`) stays intact. This keeps the door open to re-enabling the default if Claude Code improves skill auto-trigger behavior and future evals show parity with AGENTS.md.
- **No change to AGENTS.md generation** — the `<!-- BEGIN:ask-docs-auto-generated -->` block and its content stay byte-identical. `packages/cli/src/agents.ts` is not touched.
- **No change to `.ask/docs/` layout** — the vendored docs tree and `saveDocs` behavior remain untouched. Convention-based discovery, intent-skills block, and in-place `node_modules` resolution are all out of scope.
- **No change to `ignore-files.ts`** — `manageIgnoreFiles` still patches root ignores and writes nested configs exactly as today.
- **Idempotent remove** — `ask remove` must still tear down pre-existing skill directories left over from older ASK versions or from `--emit-skill` runs. No "only remove if we wrote it" tracking — `fs.existsSync` check is sufficient.
- **Opt-in resolution precedence** — CLI `--emit-skill` flag (explicit) beats `ask.json` `emitSkill` field, which beats the default `false`. If the CLI flag is absent, `ask.json` wins; if both are absent, default off.

## Out of Scope

- Removing the `packages/cli/src/skill.ts` module or the `getSkillDir` / `generateSkill` / `removeSkill` API surface.
- Deprecation warning when `emitSkill: true` is set (users who explicitly opt in should not be nagged).
- Changes to the AGENTS.md content/format or the `ignore-files.ts` root-ignore patches.
- Adding a `--no-emit-skill` flag. The default is already off; an explicit disable flag is redundant.
- Migrating existing users' `.claude/skills/` directories en masse. Cleanup only happens via `ask remove` per library, as today.
- Any change to `evals/*` experiments. The `with-skill` variants introduced in the previous commit continue to manually inject SKILL.md for benchmarking purposes and are independent of `ask install` behavior.
- Runtime conversion of the old behavior into a migration prompt. The eval results justify a silent default flip; users who want the old behavior still have a one-flag / one-field escape hatch.
