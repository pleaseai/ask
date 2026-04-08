---
name: project-structure
description: Key structural conventions for the ASK monorepo docs; notably .ask/ vs .please/ migration and AGENTS.md marker format
type: project
---

## Storage paths

The CLI generates user-project files under `.ask/` (not `.please/`). A migration from `.please/` to `.ask/` happened in April 2026, handled by `packages/cli/src/migrate-legacy.ts`.

**Why:** `.please/` was the original workspace directory. After April 2026 the CLI moved all generated artifacts to `.ask/` to avoid conflating CLI-generated docs with workspace planning artifacts.

**How to apply:** When reading or editing docs that reference where the CLI stores generated files, always use `.ask/config.json`, `.ask/ask.lock`, `.ask/docs/` — not `.please/`.

## AGENTS.md marker comments

The actual marker comments used by `packages/cli/src/agents.ts`:

```
<!-- BEGIN:ask-docs-auto-generated -->
<!-- END:ask-docs-auto-generated -->
```

Not `<!-- ASK:BEGIN -->` / `<!-- ASK:END -->` (which appeared incorrectly in ARCHITECTURE.md before being corrected on 2026-04-08).

## Registry content directory structure

Registry entries live under `apps/registry/content/registry/<github-owner>/<repo-name>.md`.
Directories are named after the GitHub **owner** (e.g. `vercel/`, `facebook/`, `colinhacks/`),
**not** by ecosystem. The actual schema (validated by `content.config.ts`) requires:
- `name` (display name, e.g. "Next.js")
- `description`
- `repo` (required, "owner/name" form)
- `docsPath` (optional)
- `homepage`, `license` (optional)
- `aliases` (optional array of `{ ecosystem, name }` for CLI lookup)
- `strategies` (optional; auto-derived from `repo` if omitted)

There is no top-level `ecosystem:` field. Ecosystem is encoded inside `aliases[].ecosystem`.

## Output pipeline step order

The actual pipeline in `packages/cli/src/index.ts`:
1. storage.ts — save docs to .ask/docs/
2. config.ts — update .ask/config.json
3. io.ts upsertLockEntry — update .ask/ask.lock
4. skill.ts — generate .claude/skills/<name>-docs/SKILL.md
5. agents.ts — update AGENTS.md
