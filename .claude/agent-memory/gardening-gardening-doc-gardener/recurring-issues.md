---
name: recurring-issues
description: Recurring documentation drift patterns discovered in the ASK repo
type: project
---

## Full scan 2026-04-08 (commit 89c7eb6)

### Fixed issues

1. **ARCHITECTURE.md** — `RegistryEntry` type was stale: had wrong `ecosystem: string` field, missing `repo` (required), `docsPath`, `homepage`, `license`, `aliases`. Fixed to match `packages/cli/src/registry.ts`.
2. **ARCHITECTURE.md** — `SourceConfig` union omitted `LlmsTxtSourceOptions`. Fixed.
3. **ARCHITECTURE.md** — Registry `content/registry/` shown as ecosystem-keyed (`npm/`, `pypi/`) but actual structure is owner-keyed (`vercel/`, `colinhacks/`). Fixed both the directory tree and the example entry format (removed `ecosystem:` top-level field).
4. **ARCHITECTURE.md** — Content API path doc said `{ecosystem}/{name}` but CLI passes `{first}/{second}` which can be either pattern. Clarified.
5. **ARCHITECTURE.md** — Ecosystem detection table missing `maven` (pom.xml, build.gradle). Added.
6. **ARCHITECTURE.md** — `Last updated` date was 2026-04-03. Updated to 2026-04-08.
7. **README.md** — Registry directory structure shown as `npm/`, `pypi/` — fixed to `owner/` structure.
8. **README.md** — Registry entry format example used `ecosystem: npm` as top-level field. Fixed to use `repo:` + `aliases:` fields.
9. **README.md** — Contributing section said `<ecosystem>/` path. Fixed to `<github-owner>/`.
10. **skills/add-docs/SKILL.md** — Ecosystem detection table missing `maven`. Added.
11. **skills/setup-docs/SKILL.md** — Ecosystem/manifest table missing `maven`. Added.
12. **.claude/skills/ask-registry/SKILL.md** — Entry location said `<ecosystem>/<name>.md`. Fixed to `<github-owner>/<repo-name>.md`. All example entries updated to use `repo:` + `aliases:` instead of `ecosystem:` top-level field. Schema reference table updated.

### Reported (not auto-fixed)

- `evals/next-canary/README.md` not linked from root README.md — orphan. Intentional: next-canary eval suite is independent.
- `.please/docs/knowledge/*.md` files are orphaned — accessed via the `please` plugin's CLAUDE.md @import mechanism, not standard markdown links.
- Registry content files (`apps/registry/content/registry/**/*.md`) are orphaned by markdown links — loaded by Nuxt Content at runtime.
- Eval PROMPT.md files are orphaned — accessed by the eval runner.
- `skills/*.md` are orphaned — accessed by the Claude Code plugin mechanism.

## Full scan 2026-04-08 (commit c0f0e80)

### Fixed issues

1. **ARCHITECTURE.md** — "Files Generated" section used `.please/` tree instead of `.ask/` tree. Fixed to `.ask/`.
2. **ARCHITECTURE.md** — Invariant #7 cited wrong AGENTS.md marker comments (`<!-- ASK:BEGIN -->` instead of `<!-- BEGIN:ask-docs-auto-generated -->`). Fixed.
3. **ARCHITECTURE.md** — Data flow missing the `ask.lock` step between Configure and Skill. Added step 6 (Lock).
4. **ARCHITECTURE.md** — Invariant #2 pipeline description omitted `lock` step. Fixed to `storage → config → lock → skill → agents`.
5. **CLAUDE.md** — Output pipeline steps 1–2 used `.please/` paths. Fixed to `.ask/`. Added step 3 for `ask.lock`.

### Reported (not auto-fixed)

- `evals/next-canary/README.md` not linked from root README.md — orphan. Intentional: next-canary eval suite is independent.
- `.please/docs/knowledge/*.md` files are orphaned (not linked from INDEX.md) — these are workspace knowledge docs accessed via the `please` plugin's CLAUDE.md @import mechanism, not standard markdown links.
- Registry content files (`apps/registry/content/registry/**/*.md`) are orphaned by markdown links — they are loaded by Nuxt Content at runtime, not via doc links.
- Eval PROMPT.md files are orphaned — accessed by the eval runner, not via doc links.
- `skills/*.md` are orphaned — accessed by the Claude Code plugin mechanism, not markdown links.
