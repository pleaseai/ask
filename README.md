# ASK (Agent Skills Kit)

Download version-specific library documentation for AI coding agents.

Inspired by [Next.js evals](https://nextjs.org/evals) showing that providing `AGENTS.md` with bundled docs dramatically improves AI agent performance (Claude Opus 4.6: 71% → 100%), ASK generalizes this pattern to any library.

## How It Works

ASK is a downstream tool of your project's package manager. You declare
the libraries you care about in a root-level `ask.json`, and `ask
install` resolves each entry against the right source of truth — your
PM lockfile for `npm:` entries, an explicit `ref` for standalone
GitHub entries.

```bash
ask add npm:next                              # PM-driven (version comes from bun.lock / package-lock / etc.)
ask add github:vercel/next.js --ref v14.2.3   # Standalone github entry with an explicit ref
ask install                                   # (Re)materialize everything declared in ask.json
```

After `ask add`, your `ask.json` looks like:

```json
{
  "libraries": [
    { "spec": "npm:next" },
    { "spec": "github:vercel/next.js", "ref": "v14.2.3", "docsPath": "docs" }
  ]
}
```

Each successful install:

1. Resolves the version (lockfile for `npm:`, `ref` for `github:`)
2. Looks up the library in the [ASK Registry](https://ask-registry.pages.dev) when applicable
3. Downloads the library's documentation from the resolved source
4. Saves it to `.ask/docs/<library>@<version>/` — or references `node_modules/<pkg>/<subdir>/` in place when the package ships its own docs (see [In-place npm docs](#in-place-npm-docs))
5. Creates a Claude Code skill in `.claude/skills/<library>-docs/SKILL.md` (opt-in via `--emit-skill`)
6. Generates/updates `AGENTS.md` with instructions for AI agents
7. Records the resolution in `.ask/resolved.json` (gitignored cache for fast re-runs)

`ask install` is `postinstall`-friendly: failures on individual entries
emit a warning and the command still exits 0.

## Installation

```bash
bun install
bun run build
```

## Monorepo Structure

```
packages/cli/       @pleaseai/ask CLI (npm publishable)
apps/registry/      ASK Registry browser (Nuxt + Nuxt Content v3, Cloudflare Pages)
```

## Usage

### Add a library

```bash
# PM-driven npm entry — version comes from your lockfile at install time
ask add npm:next
ask add npm:@mastra/client-js

# Standalone github entry — version is pinned via --ref
ask add github:vercel/next.js --ref v14.2.3 --docs-path docs
ask add vercel/next.js --ref main             # github: prefix is implied for owner/repo
```

`ask add` appends an entry to `ask.json` and immediately runs install
for that single entry. The flat command surface replaces the old `ask
docs add | sync | list | remove` namespace — no `ask sync` alias is
provided; use `ask install`.

### Install all declared libraries

```bash
ask install            # Materialize every entry in ask.json
ask install --force    # Re-fetch even when .ask/resolved.json says nothing changed
```

`ask install` reads `ask.json`, resolves each entry, fetches docs via
the existing source adapters, and writes `.ask/docs/`, `AGENTS.md`,
and `.claude/skills/<name>-docs/`. Successful entries are persisted
even when others fail; the exit code is always 0 so the command is
safe to wire up as a `postinstall` script:

```jsonc
// package.json
{
  "scripts": {
    "postinstall": "ask install"
  }
}
```

### List declared libraries

```bash
ask list           # Tabular view of ask.json + .ask/resolved.json
ask list --json    # Same data as ListModelSchema-conformant JSON
```

### Remove a library

```bash
ask remove next
ask remove @mastra/client-js
ask remove github:vercel/next.js
```

`ask remove` deletes the matching entry from `ask.json`, removes the
materialized files under `.ask/docs/<name>@*/`, removes the skill
file, and updates the `AGENTS.md` block.

### Lazy commands for ad-hoc exploration

`ask install` is the eager, declarative path: every library you care about
goes in `ask.json` and gets materialized into `.ask/docs/`. For libraries
that are **not** declared — a transitive dependency you bumped into mid-task,
an upstream you want to grep, a framework you're exploring — use the lazy
commands:

```bash
ask src <spec>     # Print the absolute path to a cached library source tree
ask docs <spec>    # Print all candidate documentation paths from node_modules + the cached source
```

Both commands fetch on cache miss (first run) and short-circuit on cache
hit. They share the same `~/.ask/github/checkouts/` store that `ask install`
writes to — so a library you have already installed via the eager path is
instantly available via the lazy path with zero duplication.

```bash
# Print the absolute path to React's source tree (fetches on first run)
ask src react

# Grep across the full React source via shell substitution
rg "useState" $(ask src react)

# Print all docs candidates for vue — one path per line, agent picks
ask docs vue

# Search across every monorepo docs/ directory at once
rg "defineComponent" $(ask docs vue)

# CI guard: exit 1 if the cache is empty
ask src react --no-fetch
```

**Spec syntax** — same `npm:`/`github:`/ecosystem-prefixed format as
`ask add`, plus an optional trailing `@version`:

```bash
ask src react                              # latest from npm registry
ask src react@18.2.0                       # explicit version
ask src @vercel/ai@5.0.0                   # scoped npm name + version
ask src github:facebook/react              # github default branch
ask src github:facebook/react@v18.2.0      # github tag
ask src pypi:requests                      # cross-ecosystem
```

**Version resolution priority** for npm specs without an explicit
`@version`: project lockfile → resolver "latest". Explicit `@version`
always wins.

**Registry-free** — neither command consults the curated ASK Registry; both
go straight to upstream package metadata. This is a deliberate departure
from `ask install`/`ask add`: eager mode trusts curation, lazy mode trusts
convention plus agent intelligence.

`ask docs` walks `node_modules/<pkg>/` only for npm-ecosystem specs (not
for `github:`/`pypi:`/etc.), and surfaces every subdirectory whose name
matches `/doc/i` up to depth 4, skipping `node_modules`, `.git`, `.next`,
`.nuxt`, `dist`, `build`, `coverage`, and dotdirs. The source root is
always emitted as the first line so the agent can fall back to it when no
`docs/` directory exists.

## In-place npm docs

When ASK's convention-based discovery finds documentation shipped inside an npm
package (e.g. `node_modules/next/dist/docs/`), it **references the files in
place** rather than copying them into `.ask/docs/`. This means:

- **Zero disk duplication** — the same bytes are not stored twice.
- **Automatic freshness** — `bun install` bumps the version, and the next
  `ask install` picks up the new path immediately.
- **AGENTS.md differentiates** — in-place entries say "shipped by the package —
  `bun install` keeps them in sync" so agents know the lifecycle owner.

To opt out and force the old copy behavior:

```bash
ask install --no-in-place       # Per-invocation CLI flag
```

or add to `ask.json`:

```json
{ "inPlace": false, "libraries": [...] }
```

Precedence: CLI flag > `ask.json` > default `true`.

## Registry

The ASK Registry (`apps/registry/`) is a community-maintained catalog of library documentation configs. Each entry is a Markdown file with YAML frontmatter:

```
apps/registry/content/registry/
├── vercel/           # github owner
│   └── next.js.md
├── colinhacks/       # github owner
│   └── zod.md
├── tailwindlabs/     # github owner
│   └── tailwindcss.md
└── ...               # one directory per github owner
```

### Registry entry format

```markdown
---
name: Next.js
description: The React framework by Vercel
repo: vercel/next.js
docsPath: docs
homepage: https://nextjs.org
license: MIT
aliases:
  - ecosystem: npm
    name: next
strategies:
  - source: npm
    package: next
    docsPath: dist/docs
  - source: github
    repo: vercel/next.js
    docsPath: docs
tags: [react, framework, ssr]
---

Description and version notes here...
```

### Contributing

Add a new `.md` file under `apps/registry/content/registry/<github-owner>/` and submit a PR.

## Ecosystem Resolvers

When a library isn't in the registry, ASK can **automatically resolve** its GitHub repository from ecosystem package metadata. This works for any ecosystem-prefixed spec:

```bash
ask add npm:lodash       # Looks up registry.npmjs.org → lodash/lodash
ask add pypi:fastapi     # Looks up pypi.org → fastapi/fastapi
ask add pub:riverpod     # Looks up pub.dev → rrousselGit/riverpod
```

**Supported ecosystems:**

| Ecosystem | API | Metadata field |
|---|---|---|
| `npm` | `registry.npmjs.org/<name>` | `repository.url` |
| `pypi` | `pypi.org/pypi/<name>/json` | `info.project_urls.Source` |
| `pub` | `pub.dev/api/packages/<name>` | `latest.pubspec.repository` |

The resolver extracts the GitHub `owner/repo` from the package metadata and delegates to the GitHub source for download. The registry is always checked first — resolvers only activate on a registry miss.

## Source Adapters

### npm

Extracts documentation from npm package tarballs.

### GitHub

Downloads documentation from a GitHub repository at a specific tag or branch.

### Web

Crawls documentation websites and converts HTML to Markdown.

## Global Store

ASK maintains a global docs store at `~/.ask/` so identical `<pkg>@<version>` entries are fetched once per machine and reused across projects.

```
~/.ask/                                     # ASK_HOME
├── npm/
│   └── next@16.2.3/                        # immutable doc entry
├── github/
│   ├── db/
│   │   └── vercel__next.js.git/            # shared bare clone
│   └── checkouts/
│       └── vercel__next.js/v16.2.3/        # per-ref extraction
├── web/
│   └── <sha256>/                           # crawled snapshots
└── llms-txt/
    └── <sha256>@<version>/
```

### `ASK_HOME`

Override the store location: `ASK_HOME=/path/to/store ask install`

### `storeMode`

Configure how store entries are materialized into each project (CLI flag `--store-mode` or `ask.json` field):

| Mode   | Behavior                                            | Best for                |
| ------ | --------------------------------------------------- | ----------------------- |
| `copy` | (default) Full copy into `.ask/docs/<pkg>@<v>/`     | CI, Docker, Windows     |
| `link` | Symlink → store (falls back to copy on `EPERM`/`EACCES`) | Local dev, disk savings |
| `ref`  | No project files; AGENTS.md points at store directly | Max dedup, local only   |

### Cache management

```bash
ask cache ls                   # list store entries with sizes
ask cache ls --kind npm        # filter by kind
ask cache gc --dry-run         # preview what would be removed
ask cache gc                   # remove unreferenced entries
```

> **Windows note:** `link` mode requires Developer Mode or admin privileges for symlinks. When unavailable, ASK falls back to `copy` automatically.

## Eval Results

We run our own eval suite ([`evals/nuxt-ui/`](evals/nuxt-ui/)) comparing documentation strategies on 6 Nuxt UI v4 tasks — including 3 breaking-change evals with negative assertions that catch deprecated v2/v3 API usage.

### Doc source comparison (claude-sonnet-4-6, 2026-04-07)

| Doc source | Pass rate | Est. cost | Retries needed |
|---|---|---|---|
| **ASK github-docs (AGENTS.md)** | **100%** (6/6) | **$1.67** | 0 |
| No docs (baseline) | 86% (6/7) | $1.82 | 1 |
| llms-full.txt (~200KB) | 46% (6/13) | $2.93 | 7 |
| llms.txt (~5KB) | 40% (6/15) | $4.83 | 9 |

**Key findings:**

- **ASK-style docs outperform all alternatives** — 100% pass rate at the lowest cost. Structured docs with version warnings let the agent find correct v4 APIs without excessive exploration.
- **llms.txt / llms-full.txt hurt more than they help** — Both scored below baseline. The agent spends tokens searching through unstructured docs but still uses deprecated patterns.
- **Cost scales inversely with quality** — The worst performer (llms.txt) costs 2.9x more than the best (ASK github-docs), driven by retry loops and exploratory tool calls.

### Delivery format comparison: AGENTS.md vs Claude Code skill (2026-04-10)

Same docs payload, same model, same sandbox — only the delivery format changes:

| Delivery format | First-try pass rate | Notes |
|---|---|---|
| **AGENTS.md pointer** | **100%** (6/6) | Baseline ASK behavior |
| `.claude/skills/<pkg>-docs/SKILL.md` | 50% (3/6) | Failed first-try on 3 breaking-change evals (001, 003, 005); only recovered on retry |

This reproduces [Vercel's public finding](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)
("AGENTS.md outperforms skills in our agent evals") inside ASK's own suite.
The Claude Code skill format's auto-trigger heuristics do not reliably fire
on v4 rename/API-shift cases where reading the docs actually matters. A
follow-up track will make skill emission opt-in via a flag, with AGENTS.md
remaining the default delivery format.

See [`evals/nuxt-ui/README.md`](evals/nuxt-ui/README.md) for full methodology and detailed results.

## Background

The [Next.js evals](https://nextjs.org/evals) benchmark ([source code](https://github.com/vercel/next-evals-oss)) showed that AI agents perform significantly better when given access to version-specific documentation via `AGENTS.md`:

| Agent | Without docs | With AGENTS.md |
|-------|-------------|----------------|
| Claude Opus 4.6 | 71% | **100%** |
| Gemini 3.1 Pro | 76% | **100%** |
| GPT 5.3 Codex | 86% | **100%** |

ASK makes it easy to apply this pattern to any library in any project.

## Related Projects

- [next-evals-oss](https://github.com/vercel/next-evals-oss) — Vercel's open-source Next.js agent evals showing AGENTS.md impact
- [skills-npm](https://github.com/antfu/skills-npm) — Convention for shipping agent skills inside npm packages (maintainer-side)
- [TanStack Intent](https://github.com/TanStack/intent) — CLI for generating, validating, and shipping Agent Skills with npm packages
- [Skilld](https://github.com/skilld-dev/skilld) — Generates agent skills from npm dependencies using docs, release notes, and GitHub discussions
- [mdream](https://github.com/harlan-zw/mdream) — High-performance HTML to Markdown converter optimized for LLM applications

## License

MIT
