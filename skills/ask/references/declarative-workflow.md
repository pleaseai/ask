# Declarative Workflow (`ask.json` + `ask install`)

Read this when the user wants docs checked into the repo, wants
`AGENTS.md` auto-regenerated on every `bun install`, or wants a
versioned list of libraries the project's agents should reference. The
one-shot `ask docs` / `ask src` / `ask skills list` commands don't
persist anything; this flow does.

## Core Idea

- `ask.json` — the single declarative input. Lists the library specs
  the project wants docs / skills for. Checked into git.
- `.ask/resolved.json` — a pure cache recording how each entry
  resolved (version, commit SHA, format). Gitignored; safe to delete
  and rebuild with `ask install`.
- `.ask/docs/<name>@<version>/` — generated doc copies / symlinks.
- `.claude/skills/<name>-docs/SKILL.md` — generated Claude Code skill
  per library.
- `AGENTS.md` — has a block between
  `<!-- BEGIN:ask-docs-auto-generated -->` and `<!-- END:... -->` that
  `ask` maintains.

## `ask install`

Reads `ask.json`, resolves each entry, fetches to `<askHome>/`,
materializes files in the project, and rewrites `AGENTS.md`.

```bash
ask install
```

Pipeline per entry:

1. Lockfile read (npm ecosystem only) — priority `bun.lock →
   package-lock.json → pnpm-lock.yaml → yarn.lock → package.json`.
2. Source dispatch — `npm` / `github` / `web` / `llms-txt` adapter.
3. Convention-based discovery (npm only, no explicit `source`): tries
   `local-ask` (`package.json.ask.docsPath`), `local-intent`
   (TanStack-intent packages), `local-conventions` (`dist/docs`, `docs`,
   `README.md`) — first hit wins, registry is the fallback.
4. Write `.ask/docs/<name>@<version>/` and `INDEX.md`.
5. Generate `.claude/skills/<name>-docs/SKILL.md`.
6. Upsert `.ask/resolved.json`.
7. Regenerate the `AGENTS.md` auto block.

`postinstall`-friendly: per-entry failures emit a warning and the
overall exit code is always 0, so a missing registry entry doesn't
break `bun install` (FR-10).

## `ask add <spec>` / `ask add` (interactive)

Appends to `ask.json` and runs install for just that entry.

```bash
ask add npm:next
ask add npm:@mastra/client-js
ask add github:vercel/next.js@v14.2.3
ask add facebook/react           # bare owner/repo → github:facebook/react
ask add                          # interactive picker
```

Bare names without `:` or `/` (e.g. `ask add zod`) are rejected with a
hint showing the two valid forms. (The one-shot `ask docs zod` DOES
accept bare names — only `add` is strict.)

## `ask remove <name>`

Removes from `ask.json`, deletes the generated skill, re-runs install
to regenerate `AGENTS.md` cleanly.

```bash
ask remove next
ask remove @mastra/client-js
ask remove npm:next              # also accepts full spec
```

## `ask list [--json]`

Joins `ask.json` with `.ask/resolved.json`. Declared-but-not-installed
entries show `version: unresolved` so drift is visible.

```bash
ask list
ask list --json | jq '.libraries[] | select(.version == "unresolved")'
```

## `ask.json` Shape

```json
{
  "libraries": [
    "npm:next",
    "npm:@mastra/client-js",
    "github:vercel/next.js@v14.2.3",
    { "spec": "github:vercel/ai", "ref": "v5.0.0" },
    { "spec": "npm:zod", "docsPath": "docs" }
  ]
}
```

Either strings or objects. Object form keys:

| Key         | Purpose                                                   |
|-------------|-----------------------------------------------------------|
| `spec`      | Required. Same grammar as the CLI positional.             |
| `ref`       | Required for standalone `github:` entries. No default.    |
| `source`    | Optional. Force `npm` / `github` / `web` / `llms-txt`.    |
| `docsPath`  | Optional. Subpath within the source to treat as the doc root. |

## Ref Validation

Strict-by-default for `ask.json` — mutable refs are rejected to keep
generated docs reproducible:

- Rejected: `main`, `master`, `develop`, `trunk`, `HEAD`, `latest`,
  any single-word ref without `.` or a digit.
- Accepted: `v1.2.3`, `1.2.3`, `next-14.2.3-canary.1`, full SHAs.

To bypass (e.g. in CI that docs-against-HEAD):

```bash
ask install --allow-mutable-ref
ask add github:owner/repo@main --allow-mutable-ref
```

The one-shot reading commands (`docs` / `src` / `skills list`) skip
this check entirely — they're meant for exploration, not persistence.

## `.ask/resolved.json` Cache

Records the last successful resolution for each spec: resolved
version, commit SHA (for github entries), and `format` (`docs` or
`intent-skills`). Safe to delete; `ask install` rebuilds it. The file
is gitignored by default — `ask` auto-manages the relevant ignore
files via a marker block (`# ask:start … # ask:end`). Don't hand-edit
inside that block; `install` / `remove` will overwrite it.

## Intent-Format Packages

Packages shipping TanStack-intent skills (`keywords:
["tanstack-intent"]`) are materialized differently. They live in a
separate `AGENTS.md` block (`<!-- intent-skills:start -->…<!--
intent-skills:end -->`), disjoint from the regular docs block. `ask
remove` dispatches on the recorded `format` and tears down the right
block.
