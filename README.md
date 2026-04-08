# ASK (Agent Skills Kit)

Download version-specific library documentation for AI coding agents.

Inspired by [Next.js evals](https://nextjs.org/evals) showing that providing `AGENTS.md` with bundled docs dramatically improves AI agent performance (Claude Opus 4.6: 71% → 100%), ASK generalizes this pattern to any library.

## How It Works

```bash
ask docs add npm:next                # Auto-detects version from your project lockfile
ask docs add npm:zod@3.22            # Explicit ecosystem + version
ask docs add pypi:fastapi@0.115      # Python libraries too
ask docs add vercel/next.js          # GitHub shorthand (no registry needed)
ask docs add vercel/next.js@v15.0.0  # …pinned to a tag or branch
```

> Bare names (`ask docs add next`) are rejected — use an `<ecosystem>:<name>`
> prefix or the `<owner>/<repo>` shorthand so the CLI knows how to resolve
> the library.

This single command:

1. Looks up the library in the [ASK Registry](https://ask-registry.pages.dev) for optimal source config
2. Downloads the library's documentation from the resolved source
3. Saves it to `.ask/docs/<library>@<version>/`
4. Creates a Claude Code skill in `.claude/skills/<library>-docs/SKILL.md`
5. Generates/updates `AGENTS.md` with instructions for AI agents

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

### Add documentation

```bash
# Ecosystem prefix with no version — CLI reads the project lockfile
# (bun.lock → package-lock.json → pnpm-lock.yaml → yarn.lock → package.json)
# and uses the installed version automatically.
ask docs add npm:next
ask docs add pypi:fastapi

# Ecosystem prefix with an explicit version
ask docs add npm:next@canary
ask docs add pypi:fastapi@0.115

# Skip the manifest lookup and fetch the ecosystem `latest` tag instead
ask docs add --no-manifest npm:next

# Require the manifest — error out if no lockfile entry exists for the name
ask docs add --from-manifest npm:next

# GitHub shorthand — owner/repo[@ref] skips the registry entirely
ask docs add vercel/next.js                # latest default branch
ask docs add vercel/next.js@v15.0.0        # pinned to a tag
ask docs add vercel/next.js@canary         # …or a branch (ref is opaque)

# Manual source specification (when not in registry)
ask docs add mylib@1.0 -s npm --docs-path dist/docs
ask docs add mylib@1.0 -s github --repo owner/repo --tag v1.0 --docs-path docs
ask docs add mylib@1.0 -s web --url https://mylib.dev/docs
```

### Identifier syntax

`ask docs add <spec>` accepts three identifier shapes, disambiguated by punctuation:

| Shape | Example | Behavior |
|---|---|---|
| `owner/repo[@ref]` | `vercel/next.js@canary` | GitHub fast-path. Skips the registry; passes the ref straight to the github source (tag or branch — opaque). |
| `ecosystem:name[@version]` | `npm:next@^15` | Registry lookup with an explicit ecosystem prefix. When the version is omitted, the CLI auto-resolves it from the project manifest/lockfile. |
| `name[@version]` | `next` | **Rejected.** Bare names are ambiguous — use `npm:next` or `vercel/next.js` instead. |

The github shorthand is strict — exactly one slash, no colon. `a/b/c` and `org:team/repo` produce a parse error with actionable guidance.

### Sync all configured docs

```bash
ask docs sync
```

Re-downloads all libraries listed in `.ask/config.json` and updates `.ask/ask.lock`.
Entries whose content has not changed since the last fetch are skipped.

### List downloaded docs

```bash
ask docs list
```

### Remove documentation

```bash
ask docs remove next@canary   # specific version
ask docs remove next           # all versions
```

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
ask docs add npm:lodash       # Looks up registry.npmjs.org → lodash/lodash
ask docs add pypi:fastapi     # Looks up pypi.org → fastapi/fastapi
ask docs add pub:riverpod     # Looks up pub.dev → rrousselGit/riverpod
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

## Eval Results

We run our own eval suite ([`evals/nuxt-ui/`](evals/nuxt-ui/)) comparing 4 documentation strategies on 6 Nuxt UI v4 tasks — including 3 breaking-change evals with negative assertions that catch deprecated v2/v3 API usage.

### Pass Rate (claude-sonnet-4-6, 2026-04-07)

| Doc source | Pass rate | Est. cost | Retries needed |
|---|---|---|---|
| **ASK github-docs** | **100%** (6/6) | **$1.67** | 0 |
| No docs (baseline) | 86% (6/7) | $1.82 | 1 |
| llms-full.txt (~200KB) | 46% (6/13) | $2.93 | 7 |
| llms.txt (~5KB) | 40% (6/15) | $4.83 | 9 |

**Key findings:**

- **ASK-style docs outperform all alternatives** — 100% pass rate at the lowest cost. Structured docs with version warnings let the agent find correct v4 APIs without excessive exploration.
- **llms.txt / llms-full.txt hurt more than they help** — Both scored below baseline. The agent spends tokens searching through unstructured docs but still uses deprecated patterns.
- **Cost scales inversely with quality** — The worst performer (llms.txt) costs 2.9x more than the best (ASK github-docs), driven by retry loops and exploratory tool calls.

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
