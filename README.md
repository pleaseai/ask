# ASK (Agent Skills Kit)

Download version-specific library documentation for AI coding agents.

Inspired by [Next.js evals](https://nextjs.org/evals) showing that providing `AGENTS.md` with bundled docs dramatically improves AI agent performance (Claude Opus 4.6: 71% → 100%), ASK generalizes this pattern to any library.

## How It Works

```
ask docs add next@canary -s npm --docs-path dist/docs
```

This single command:

1. Downloads the library's documentation from the specified source
2. Saves it to `.please/docs/<library>@<version>/`
3. Creates a Claude Code skill in `.claude/skills/<library>-docs/SKILL.md`
4. Generates/updates `AGENTS.md` with instructions for AI agents
5. Creates `CLAUDE.md` referencing `@AGENTS.md`

## Installation

```bash
npm install
npm run build
```

## Usage

### Add documentation

```bash
# From npm package (e.g., Next.js canary ships docs in dist/docs/)
ask docs add next@canary -s npm --docs-path dist/docs

# From GitHub repository
ask docs add zod@3 -s github --repo colinhacks/zod --tag v3.24.4 --docs-path docs

# From a documentation website
ask docs add tailwindcss@4 -s web --url https://tailwindcss.com/docs
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

## Source Adapters

### npm

Extracts documentation from npm package tarballs. Best for libraries that ship docs inside their package (like `next@canary` at `dist/docs/`).

```bash
ask docs add <name>@<version> -s npm [--docs-path <path>]
```

- `--docs-path` — Path to docs within the package. Auto-detected from `docs/`, `doc/`, `dist/docs/` if omitted.

### GitHub

Downloads documentation from a GitHub repository at a specific tag or branch.

```bash
ask docs add <name>@<version> -s github --repo <owner/repo> [--tag <tag>] [--branch <branch>] [--docs-path <path>]
```

- `--repo` — GitHub repository (required), e.g. `facebook/react`
- `--tag` — Git tag, e.g. `v19.0.0`
- `--branch` — Git branch (default: `main`)
- `--docs-path` — Path to docs directory within the repo

### Web

Crawls documentation websites and converts HTML to Markdown.

```bash
ask docs add <name>@<version> -s web --url <url> [--max-depth <n>] [--path-prefix <prefix>]
```

- `--url` — Starting URL(s) to crawl (required)
- `--max-depth` — How many levels of links to follow (default: `1`)
- `--path-prefix` — Only follow links under this URL path

## Generated Files

```
project/
├── AGENTS.md                              # Agent instructions (auto-generated)
├── CLAUDE.md                              # References @AGENTS.md
├── .please/
│   ├── config.json                        # Library configuration
│   └── docs/
│       └── next@16.2.1-canary.17/         # Downloaded docs
│           ├── INDEX.md
│           ├── 01-app/
│           └── ...
└── .claude/
    └── skills/
        └── next-docs/
            └── SKILL.md                   # Claude Code skill
```

### AGENTS.md

Follows the [Next.js evals pattern](https://github.com/vercel/next-evals-oss). Warns AI agents that library APIs may differ from training data and points them to the downloaded documentation.

### SKILL.md

A Claude Code skill that triggers when the agent writes or modifies code using the library. Instructs the agent to read the relevant docs first.

### .please/config.json

Stores the configuration for all downloaded libraries. Use `ask docs sync` to re-download everything.

```json
{
  "docs": [
    {
      "name": "next",
      "version": "16.2.1-canary.17",
      "source": "npm",
      "docsPath": "dist/docs"
    }
  ]
}
```

## Background

The [Next.js evals](https://nextjs.org/evals) benchmark showed that AI agents perform significantly better when given access to version-specific documentation via `AGENTS.md`:

| Agent | Without docs | With AGENTS.md |
|-------|-------------|----------------|
| Claude Opus 4.6 | 71% | **100%** |
| Gemini 3.1 Pro | 76% | **100%** |
| GPT 5.3 Codex | 86% | **100%** |

ASK makes it easy to apply this pattern to any library in any project.

## License

MIT
