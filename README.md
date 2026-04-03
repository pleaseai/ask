# ASK (Agent Skills Kit)

Download version-specific library documentation for AI coding agents.

Inspired by [Next.js evals](https://nextjs.org/evals) showing that providing `AGENTS.md` with bundled docs dramatically improves AI agent performance (Claude Opus 4.6: 71% → 100%), ASK generalizes this pattern to any library.

## How It Works

```bash
ask docs add next@canary          # Auto-detect from registry
ask docs add npm:zod@3.22         # Explicit ecosystem
ask docs add pypi:fastapi@0.115   # Python libraries too
```

This single command:

1. Looks up the library in the [ASK Registry](https://ask-registry.pages.dev) for optimal source config
2. Downloads the library's documentation from the resolved source
3. Saves it to `.please/docs/<library>@<version>/`
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
# Auto-detect from registry (recommended)
ask docs add next@canary

# With explicit ecosystem prefix
ask docs add npm:next@canary
ask docs add pypi:fastapi@0.115

# Manual source specification (when not in registry)
ask docs add mylib@1.0 -s npm --docs-path dist/docs
ask docs add mylib@1.0 -s github --repo owner/repo --tag v1.0 --docs-path docs
ask docs add mylib@1.0 -s web --url https://mylib.dev/docs
```

### Sync all configured docs

```bash
ask docs sync
```

Re-downloads all libraries listed in `.please/config.json`.

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
├── npm/
│   ├── next.md
│   ├── zod.md
│   └── tailwindcss.md
├── pypi/
│   └── fastapi.md
├── pub/         # Dart
├── go/          # Go
├── crates/      # Rust
└── ...
```

### Registry entry format

```markdown
---
name: next
ecosystem: npm
description: Vercel's React framework
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

Add a new `.md` file under `apps/registry/content/registry/<ecosystem>/` and submit a PR.

## Source Adapters

### npm

Extracts documentation from npm package tarballs.

### GitHub

Downloads documentation from a GitHub repository at a specific tag or branch.

### Web

Crawls documentation websites and converts HTML to Markdown.

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
