# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is ASK

ASK (Agent Skills Kit) downloads version-specific library documentation and generates `AGENTS.md` + Claude Code skills so AI agents can reference accurate docs instead of relying on training data.

## Monorepo Structure

- `packages/cli/` — `@pleaseai/ask` CLI (npm publishable)
- `apps/registry/` — Nuxt + Nuxt Content v3 + Nuxt UI registry browser (Cloudflare Pages)

## Commands

```bash
# Root (turbo)
bun install               # Install all workspace dependencies
bun run build             # Build all packages
bun run dev               # Dev mode for all packages
bun run lint              # Lint all packages

# CLI (packages/cli/)
bun run --cwd packages/cli build
bun run --cwd packages/cli lint

# Registry (apps/registry/)
bun run --cwd apps/registry dev
bun run --cwd apps/registry build

# Running CLI directly
node packages/cli/dist/index.js docs add <spec> -s <source> [options]
```

## Package Manager

**bun** — npm/pnpm이 아닌 bun을 사용한다. `npx` 대신 `bunx`, `pnpm dlx` 대신 `bunx`.

## CLI Architecture (packages/cli/)

**CLI framework**: citty (unjs) with consola for structured logging. Commands defined via `defineCommand` in `src/index.ts`.

**Command structure**: `ask docs {add|sync|list|remove}` — all subcommands defined inline in `src/index.ts`.

**Source adapter pattern** (`src/sources/`):
- `index.ts` — defines `DocSource` interface, `SourceConfig` union type, and `getSource()` factory
- `npm.ts` — downloads npm tarballs, extracts doc files from package
- `github.ts` — downloads GitHub repo archives via tar.gz, extracts docs directory
- `web.ts` — crawls documentation websites, converts HTML to Markdown via `node-html-markdown`

All three sources implement `DocSource.fetch(options) -> Promise<FetchResult>` returning `{ files: DocFile[], resolvedVersion: string }`.

**Output pipeline** (executed in sequence by `add` command):
1. `storage.ts` — saves doc files to `.please/docs/<name>@<version>/`, creates `INDEX.md`
2. `config.ts` — persists source config to `.please/config.json` for `sync` re-download
3. `skill.ts` — generates `.claude/skills/<name>-docs/SKILL.md` with trigger metadata
4. `agents.ts` — generates/updates `AGENTS.md` with auto-generated block between marker comments

## Registry Architecture (apps/registry/)

Nuxt + Nuxt Content v3 + Nuxt UI. 레지스트리 데이터는 `content/registry/<ecosystem>/<name>.md` YAML frontmatter로 관리.

## Key Conventions

- Pure ESM (`"type": "module"`) — all imports use `.js` extensions (CLI)
- ESLint config: `@pleaseai/eslint-config` (based on `@antfu/eslint-config`) — 2-space indent, single quotes, no semicolons
- Use `consola` for all user-facing output, never raw `console.log`
- Regex patterns used in loops must be defined at module scope (`e18e/prefer-static-regex`)
- Import `process` from `node:process` explicitly (`node/prefer-global/process`)
