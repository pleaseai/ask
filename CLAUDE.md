# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is ASK

ASK (Agent Skills Kit) is a CLI tool that downloads version-specific library documentation and generates `AGENTS.md` + Claude Code skills so AI agents can reference accurate docs instead of relying on training data.

## Commands

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Watch mode (tsc --watch)
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm start              # Run compiled CLI (node dist/index.js)
node dist/index.js docs add <spec> -s <source> [options]  # Test CLI directly
```

## Architecture

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

## Key Conventions

- Pure ESM (`"type": "module"`) — all imports use `.js` extensions
- ESLint config: `@pleaseai/eslint-config` (based on `@antfu/eslint-config`) — 2-space indent, single quotes, no semicolons
- Use `consola` for all user-facing output, never raw `console.log`
- Regex patterns used in loops must be defined at module scope (`e18e/prefer-static-regex`)
- Import `process` from `node:process` explicitly (`node/prefer-global/process`)
