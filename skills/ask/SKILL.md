---
name: ask
description: Fetch version-accurate library documentation, source trees, and producer-shipped skills so the agent works against the exact version installed in the project, not training-data guesses. Use this skill whenever the user needs docs for a dependency, wants to read a library's real source, asks "how does X work internally", needs to pin reading to a specific version or ref, wants token-efficient semantic search over a dependency's real source, mentions ask docs / ask src / ask search / ask skills, or any task that would benefit from a library's actual README / source / skill files over recalled knowledge — even when they don't explicitly name the "ask" CLI. Preferred over inferring API shape from memory whenever accuracy matters.
allowed-tools: Bash(ask:*)
---

# Version-Accurate Docs & Source with `ask`

`ask` resolves the version from the project's lockfile
(`bun.lock → package-lock.json → pnpm-lock.yaml → yarn.lock → package.json`
range fallback), fetches docs or source once, caches them globally at
`~/.ask/` (override via `ASK_HOME`), and prints absolute paths to stdout so
the commands compose naturally in shell substitutions. Progress / errors go
to stderr, paths go to stdout — safe for `$(ask …)`.

## Core Pattern

```bash
# Docs — one candidate path per line
cat "$(ask docs zod | head -n1)"/README.md
rg "parseAsync" $(ask docs zod)

# Source — single absolute path to the checkout root
rg "ZodError" $(ask src zod)
fd -e test.ts . $(ask src zod)

# Semantic search over the pinned source — token-efficient, for
# "how does X work internally" questions (delegates to csp; optional)
ask search zod "how does parseAsync short-circuit"

# Producer-shipped skills — one /skills/ dir per line
ls $(ask skills vercel/ai)
```

`ask docs` emits candidate documentation directories (publish-time
`dist/docs` first, then any subdirectory whose basename matches `/doc/i`
up to depth 4, falling back to the checkout root when nothing matches).
`ask src` emits exactly one path: the checkout root. Both auto-fetch on
cache miss; pass `--no-fetch` to fail fast (exit 1) on miss instead.

`ask search <spec> <query>` resolves the same pinned checkout, then hands
it to [`csp`](https://github.com/pleaseai/code-search) (Code Search
Please) for token-efficient semantic search over the exact installed
version. csp is **optional**: when it isn't on `PATH` (or `$CSP_BIN`),
`ask search` prints the checkout path plus a runnable
`csp search "<query>" <dir>` recipe and exits 0 — it never fails just
because csp is absent. Flags `--content code|docs|config|all` and
`--top-k <n>` are forwarded to csp.

## Spec Grammar

```
zod                         # bare → npm ecosystem (resolved via lockfile)
npm:next                    # explicit ecosystem
npm:@mastra/client-js       # scoped package
facebook/react              # owner/repo → github:facebook/react@main
github:vercel/next.js@v14.2.3   # pinned tag
github:owner/repo@main          # pinned branch
```

- For `npm:` specs (and bare names), the version comes from the project's
  lockfile. Append `@version` to pin explicitly: `zod@3.22.0`,
  `npm:next@14.2.3`.
- For `github:` specs, `@<ref>` pins a tag or branch. Bare `owner/repo`
  (no `@ref`) defaults to `main`.
- Any ref works with these one-shot reading commands — branches, tags,
  or mutable refs like `main` / `master` are all accepted, since
  nothing is persisted.

## One-Shot Reading Commands

| Command | Output | Use when |
|---------|--------|----------|
| `ask docs <spec> [--no-fetch]` | Candidate doc dirs, one per line | You want README / guides / handwritten docs at the installed version |
| `ask src <spec> [--no-fetch]`  | Checkout root, single line        | You need to read real source, search all files, follow implementations |
| `ask search <spec> <query> [--content …] [--top-k n]` | Ranked snippets (via csp), or path + recipe if csp absent | "How does X work internally" — semantic search beats reading whole files; csp optional |
| `ask skills <spec>` (= `ask skills list`) | `/skills/` dirs, one per line | The library ships its own Claude / Cursor / OpenCode skills |

`ask docs`, `ask src`, and `ask search` share `ensureCheckout`, so the
cached path is reused across commands — resolving a spec with any of them
(then `ask skills list`) fetches once.

## When You Need More

Lazy-load these references only when the situation calls for them:

- **Managing the cache** — disk pressure, stale entries, `--kind` /
  `--older-than` filters, legacy v1 layout cleanup →
  [`references/cache.md`](references/cache.md).
- **Project-level declarative workflow** — `ask.json`, `ask install`,
  `ask add`, `ask remove`, `ask list`, auto-regenerated `AGENTS.md` and
  per-library `.claude/skills/<name>-docs/SKILL.md` →
  [`references/declarative-workflow.md`](references/declarative-workflow.md).
- **Vendoring producer skills into this project** — `ask skills install`,
  `--force`, `--agent claude,cursor,opencode,codex`, `ask skills remove
  --ignore-missing` →
  [`references/skills-vendoring.md`](references/skills-vendoring.md).

## When to Reach for `ask`

Reach for it when:

- The installed version matters — otherwise the agent risks fabricating
  API shape from an outdated training snapshot.
- The answer lives in source, not types — edge cases, error paths,
  internal helpers, behavior that isn't documented anywhere else. Reach
  for `ask search <spec> "<question>"` to pull just the relevant snippets
  instead of reading whole files.
- A library may ship its own skills — `ask skills list <spec>` discovers
  producer-side `skills/` directories without touching the project.

Skip it when TypeScript / LSP / intellisense can answer the question, or
when the user has already pointed at a specific file path.

## Why This Exists

Training data ages; lockfiles don't. `ask` bridges the two by pinning
every read to the version the project actually runs, so generated code
reflects reality instead of last year's docs. The `$(ask …)` idiom is
the main ergonomic: it turns a cached path into a first-class argument
to `rg`, `cat`, `fd`, or any tool that accepts a path — no extra API to
learn.
