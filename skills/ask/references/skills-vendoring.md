# Vendoring Producer Skills (`ask skills install` / `remove`)

Read this when the user wants a library's own skills (the ones the
library *publishes* for consumers) copied into this project and linked
into the agent's skills directory. The one-shot `ask skills list
<spec>` only prints paths; the commands here actually vendor and link.

## The Core Flow

`ask skills install <spec>` does five things:

1. Resolves and fetches the library the same way `ask src` does.
2. Collects each direct child of every `skills/` (or `skill/`) parent
   directory shipped by the library — matched case-insensitively
   against `^skills?$` exactly, so `my-skills/` / `skill-set/` are
   ignored.
3. Vendors those children into `.ask/skills/<specKey>/<skill-name>/`
   in the project. `specKey` is derived from ecosystem + name +
   resolved version (e.g. `npm__next__14.2.3`).
4. Symlinks each vendored skill into the detected agent skills
   directories (`.claude/skills/`, `.cursor/skills/`,
   `.opencode/skills/`, `.codex/skills/`).
5. Records the install in `.ask/skills-lock.json` and patches
   `.gitignore` via the `ask` marker block.

## `ask skills install <spec>`

```bash
ask skills install vercel/ai
ask skills install npm:@mastra/core
ask skills install github:owner/repo@v1.2.3 --no-fetch      # cache hits only
ask skills install vercel/ai --force                        # overwrite conflicts
ask skills install vercel/ai --agent claude,cursor          # explicit targets
```

| Flag              | Effect                                                           |
|-------------------|------------------------------------------------------------------|
| `--no-fetch`      | Return cache hit only — exit 1 on miss.                          |
| `--force`         | Overwrite a conflicting `.claude/skills/<name>` symlink.         |
| `--agent <csv>`   | Explicit targets: `claude,cursor,opencode,codex`. Skips detection. |

### Agent selection

Without `--agent`:

- 0 agents detected → error asking the user to pass `--agent <name>`.
- 1 agent detected → auto-use it.
- 2+ detected → interactive multiselect prompt.

Detection looks for the agent's directory (`.claude/`, `.cursor/`,
`.opencode/`, `.codex/`). If none exist, pass `--agent` to create the
target directory and force-install.

### Exit conditions

- No `skills/` (or `skill/`) dir found in the source → exit 1 with the
  message `no skills/ directories found for <spec>`.
- No agent selected → exit 1.
- Symlink collision without `--force` → exit from `linkSkill` with a
  descriptive error.

## `ask skills remove <spec>`

Reverses a prior install using `.ask/skills-lock.json` as the source
of truth. Only removes symlinks that point at the vendored copy — a
user-edited skill in `.claude/skills/<name>` that no longer points at
`.ask/skills/<specKey>/<name>/` is left alone.

```bash
ask skills remove vercel/ai
ask skills remove npm__vercel-ai__5.0.0       # spec-key also accepted
ask skills remove vercel/ai --ignore-missing  # exit 0 even if no lock entry
```

| Flag                | Effect                                                |
|---------------------|-------------------------------------------------------|
| `--ignore-missing`  | Exit 0 when the spec has no lock entry.               |

On success, the vendor dir `.ask/skills/<specKey>/` is deleted and the
lock entry removed.

## Directory Layout After Install

```
.ask/
├── skills/
│   └── <specKey>/
│       ├── <skill-name-1>/
│       │   └── SKILL.md
│       └── <skill-name-2>/
│           └── …
└── skills-lock.json

.claude/skills/
├── <skill-name-1> -> ../../.ask/skills/<specKey>/<skill-name-1>
└── <skill-name-2> -> ../../.ask/skills/<specKey>/<skill-name-2>
```

Each skill is symlinked individually — no wrapper directory — so the
agent discovers them like any other project skill.

## Docs vs. Intent-Format Distinction

This command only handles the "skills" channel. Libraries that
distribute docs (not skills) go through `ask install` instead. If the
library is a TanStack-intent package (keywords include
`tanstack-intent`), `ask install` takes the intent path and writes an
`<!-- intent-skills:start -->` block in `AGENTS.md`, independent of
the `ask skills install` flow described here.
