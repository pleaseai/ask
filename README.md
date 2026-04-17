# ASK (Agent Skills Kit)

Download version-specific library documentation for AI coding agents.

Inspired by [Next.js evals](https://nextjs.org/evals) showing that providing `AGENTS.md` with bundled docs dramatically improves AI agent performance (Claude Opus 4.6: 71% → 100%), ASK generalizes this pattern to any library.

## How It Works

ASK uses a **lazy-first** architecture. You declare the libraries you
care about in a root-level `ask.json`, and `ask install` resolves
versions from your lockfile and generates `AGENTS.md` + `SKILL.md`
with lazy documentation references. AI agents then access docs
on-demand via `ask src` / `ask docs` commands.

```bash
ask add npm:next                              # Add to ask.json
ask add github:vercel/next.js@v14.2.3         # GitHub with inline ref
ask install                                   # Resolve versions + generate AGENTS.md/SKILL.md
```

After `ask add`, your `ask.json` looks like:

```json
{
  "libraries": [
    "npm:next",
    "github:vercel/next.js@v14.2.3"
  ]
}
```

Entries can also be written as `{ "spec": "...", "docsPaths": [...] }` objects when you want to scope `ask docs` to a subset of discovered directories — see [Add a library](#add-a-library) below.

Each successful install:

1. Resolves the version (lockfile for `npm:`, inline `@ref` for `github:`)
2. Generates a Claude Code skill in `.claude/skills/<library>-docs/SKILL.md`
   with `ask src` / `ask docs` references
3. Generates/updates `AGENTS.md` with version warnings and lazy command references

No documentation is downloaded during install — agents access docs
on-demand via `ask src` / `ask docs`, which fetch and cache on first use.

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

# GitHub entry with inline ref
ask add github:vercel/next.js@v14.2.3
ask add vercel/next.js@v14.2.3              # github: prefix is implied for owner/repo
```

`ask add` appends a spec string to `ask.json` and immediately runs
install for that single entry.

#### Selecting docs paths at add time

When a library exposes multiple candidate documentation directories
(e.g. both `docs/` and `dist/docs/`), `ask add` probes the local
`node_modules/<pkg>/` and any already-cached git checkout, and — if
more than one candidate is found and stdout is a TTY — shows a
multiselect prompt so you can pin the entry to a specific subset.
The selection is saved back to `ask.json` as an object entry:

```json
{
  "libraries": [
    "npm:zod",
    { "spec": "npm:next", "docsPaths": ["docs"] }
  ]
}
```

Downstream `ask docs <spec>` calls then emit only the selected paths
instead of every candidate. Flags:

```bash
ask add npm:next --docs-paths docs,dist/docs     # non-interactive — same effect as the prompt
ask add npm:next --clear-docs-paths              # drop the override, restore default discovery
```

Discovery is **offline-first**: `ask add` never triggers a fresh clone
on your behalf. If a spec has never been cached, the prompt is silently
skipped and the bare spec string is recorded. Run `ask docs <spec>`
once to warm the cache, then re-run `ask add <spec>` to pick paths.

### Install all declared libraries

```bash
ask install            # Resolve versions + generate AGENTS.md/SKILL.md
```

`ask install` reads `ask.json`, resolves each entry's version
(lockfile for `npm:`, inline `@ref` for `github:`), and generates `AGENTS.md` and `.claude/skills/<name>-docs/SKILL.md`
with lazy references (`ask src` / `ask docs`). No documentation is
downloaded — agents fetch docs on-demand.

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
ask list           # Tabular view of ask.json + resolved versions
ask list --json    # Same data as ListModelSchema-conformant JSON
```

### Remove a library

```bash
ask remove next
ask remove @mastra/client-js
ask remove github:vercel/next.js
```

`ask remove` deletes the matching spec from `ask.json`, removes the
skill file, and regenerates the `AGENTS.md` block.

### Lazy commands (primary docs access)

`ask src` and `ask docs` are the **primary way agents access
documentation**. They print absolute paths to cached source trees,
fetching on cache miss:

```bash
ask src <spec>     # Print the absolute path to a cached library source tree
ask docs <spec>    # Print all candidate documentation paths from node_modules + the cached source
```

Both commands fetch on cache miss (first run) and short-circuit on cache
hit. They share the same `~/.ask/github/github.com/<owner>/<repo>/<tag>/`
store.

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
go straight to upstream package metadata.

`ask docs` walks `node_modules/<pkg>/` only for npm-ecosystem specs (not
for `github:`/`pypi:`/etc.), and surfaces every subdirectory whose name
matches `/doc/i` up to depth 4, skipping `node_modules`, `.git`, `.next`,
`.nuxt`, `dist`, `build`, `coverage`, and dotdirs. The source root is
always emitted as the first line so the agent can fall back to it when no
`docs/` directory exists.

If the spec has a persisted `docsPaths` override in `ask.json` (see
[Selecting docs paths at add time](#selecting-docs-paths-at-add-time)),
`ask docs` emits only those paths. Stale entries (paths that no longer
exist on disk — e.g. after a major version bump) are dropped; when every
stored path is stale, a warning is written to stderr and the command
falls back to the unfiltered walk.

### `ask skills` — producer-side skill bundles

`ask skills` is a sibling namespace to `ask docs` that surfaces and
installs **producer-side skills** shipped by libraries under a top-level
`skills/` directory (convention inherited from tanstack-intent).

```bash
# List all candidate skill paths for a library (read-only, one per line)
ask skills <spec>              # shorthand for `skills list`
ask skills list <spec>

# Vendor skills into .ask/skills/ and symlink into each selected agent dir
ask skills install <spec>
ask skills install <spec> --agent claude,cursor
ask skills install <spec> --force      # overwrite conflicting entries

# Reverse a prior install using the lock file
ask skills remove <spec>
ask skills remove <spec> --ignore-missing
```

Skills are vendored once into `.ask/skills/<spec-key>/<skill-name>/`
(gitignored) and **symlinked** into each selected agent directory
(`.claude/skills/`, `.cursor/skills/`, `.opencode/skills/`,
`.codex/skills/`). `install` auto-detects which agents the project uses;
if more than one is present it prompts you to pick. A lock file at
`.ask/skills-lock.json` tracks what was installed so `remove` can reverse
the operation deterministically without touching user-authored skills.

v1 platform support is POSIX only (macOS/Linux) — Windows junction
fallback is on the roadmap.

## Registry

The ASK Registry (`apps/registry/`) is a community-maintained catalog of library documentation configs. Each entry is a JSON file keyed by `<github-owner>/<repo>.json`:

```
apps/registry/content/registry/
├── vercel/           # github owner
│   ├── next.js.json
│   └── ai.json
├── colinhacks/       # github owner
│   └── zod.json
├── tailwindlabs/     # github owner
│   └── tailwindcss.json
└── ...               # one directory per github owner
```

### Entry → Package → Source hierarchy

Each entry describes one GitHub repository and declares one or more **packages**. A package is a documentation target (a single library has one, a monorepo has many). Each package declares ordered **sources** the CLI tries head-first with fallback on failure. See [`ADR-0001`](.please/docs/decisions/0001-registry-entry-schema-entry-package-source.md) for the rationale.

### Single-package entry

```json
{
  "name": "Next.js",
  "description": "The React framework by Vercel",
  "repo": "vercel/next.js",
  "homepage": "https://nextjs.org",
  "license": "MIT",
  "tags": ["react", "framework", "ssr", "vercel"],
  "packages": [
    {
      "name": "next",
      "aliases": [
        { "ecosystem": "npm", "name": "next" }
      ],
      "sources": [
        { "type": "npm", "package": "next", "path": "dist/docs" },
        { "type": "github", "repo": "vercel/next.js", "path": "docs" }
      ]
    }
  ]
}
```

### Monorepo entry

One package per documentation target; each owns its own aliases and source chain.

```json
{
  "name": "Mastra",
  "description": "TypeScript framework for building AI agents, workflows, and RAG pipelines",
  "repo": "mastra-ai/mastra",
  "packages": [
    {
      "name": "@mastra/core",
      "aliases": [{ "ecosystem": "npm", "name": "@mastra/core" }],
      "sources": [
        { "type": "npm", "package": "@mastra/core", "path": "dist/docs" },
        { "type": "github", "repo": "mastra-ai/mastra", "path": "docs" }
      ]
    },
    {
      "name": "@mastra/memory",
      "aliases": [{ "ecosystem": "npm", "name": "@mastra/memory" }],
      "sources": [
        { "type": "npm", "package": "@mastra/memory", "path": "dist/docs" },
        { "type": "github", "repo": "mastra-ai/mastra", "path": "docs" }
      ]
    }
  ]
}
```

### Source types

| `type` | Required fields | Optional |
|---|---|---|
| `npm` | `package` | `path` (path inside the tarball, e.g. `dist/docs`) |
| `github` | `repo` (`owner/name`) | `branch` or `tag` (mutually exclusive), `path` |
| `web` | `urls` (array, non-empty) | `maxDepth`, `allowedPathPrefix` |
| `llms-txt` | `url` | — |

Supported alias ecosystems: `npm`, `pypi`, `pub`, `go`, `crates`, `hex`, `nuget`, `maven`.

### Contributing

Add a new `.json` file under `apps/registry/content/registry/<github-owner>/` and submit a PR. The file is validated against the `registryEntrySchema` in [`packages/schema/src/registry.ts`](packages/schema/src/registry.ts) at build time — duplicate aliases, duplicate package names, and slug collisions across packages are all rejected.

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
├── STORE_VERSION                           # always "2"
├── npm/
│   └── next@16.2.3/                        # immutable doc entry
├── github/
│   └── github.com/                         # host (reserved — gitlab/bitbucket later)
│       └── vercel/next.js/v16.2.3/         # per-tag shallow clone, .git/ stripped
├── web/
│   └── <sha256>/                           # crawled snapshots
└── llms-txt/
    └── <sha256>@<version>/
```

### Legacy layout migration

If you upgraded from an older ASK, you may have a legacy
`~/.ask/github/{db,checkouts}/` tree left behind. Running `ask install`
prints a one-line warning on first touch pointing at the cleanup
command:

```bash
ask cache clean --legacy
```

The command is idempotent and safe to run on a clean tree.

### `ASK_HOME`

Override the store location: `ASK_HOME=/path/to/store ask install`

### Cache management

```bash
ask cache ls                   # list store entries with sizes
ask cache ls --kind npm        # filter by kind
ask cache gc --dry-run         # preview what would be removed
ask cache gc                   # remove unreferenced entries
```

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
