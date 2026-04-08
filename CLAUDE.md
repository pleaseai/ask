# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is ASK

ASK (Agent Skills Kit) downloads version-specific library documentation and generates `AGENTS.md` + Claude Code skills so AI agents can reference accurate docs instead of relying on training data.

## Key Documents

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Bird's-eye view of the codebase (module structure, data flow, invariants)
- [`.please/`](.please/INDEX.md) — Workspace index (tracks, product specs, decisions, knowledge docs)

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

**bun** — Always use bun, not npm or pnpm. Use `bunx` instead of `npx` or `pnpm dlx`.

## Gotchas

- bun workspace uses `.bun/` symlink structure — native Node modules (e.g. better-sqlite3) may fail to load. Prefer native alternatives (e.g. `node:sqlite`)
- Docus (Nuxt docs theme) is incompatible with bun workspace (nuxt-content/docus#1279)
- Nuxt Content v3 requires SQLite at build time even when deploying to D1. Use `experimental.sqliteConnector: 'native'` (requires Node 22.5+)
- In `content.config.ts`, import `z` from `@nuxt/content` — do not install zod separately
- `getSource(type)` (`packages/cli/src/sources/index.ts:54`) returns a `DocSource`; pass config to `DocSource.fetch(options)`, not to `getSource`. It is a single-arg factory.
- `packages/cli/src/index.ts:76` defines a private `parseSpec(spec) -> { name, version }`. Any new export named `parseSpec` from `registry.ts` will collide — rename one before introducing.
- In Nuxt Content v3 server routes, `queryCollection` is auto-imported — do NOT use `import { queryCollection } from '#content/server'` (that alias does not exist and breaks Cloudflare Pages build). Use the bare function or `import { queryCollection } from '@nuxt/content/server'`.
- `ask docs add` rejects bare-name specs (`ask docs add next`) at the command layer via Gate A in `packages/cli/src/index.ts:checkBareNameGate`. Users MUST pass `npm:next` (ecosystem prefix) or `vercel/next.js` (GitHub shorthand). The parser (`parseDocSpec`) still returns `kind: 'name'` for bare names — the rejection is a command-layer policy, not a parser change.
- When a version is omitted (`ask docs add npm:next`), the CLI auto-reads the project lockfile (bun.lock → package-lock.json → pnpm-lock.yaml → yarn.lock → package.json range). Disable with `--no-manifest`; require it with `--from-manifest` (errors if no lockfile entry). See `packages/cli/src/manifest/`.
- A PreToolUse Bash hook blocks shell commands when the current commit has no recorded review. Run `/review:code-review` (or `/review:run-cubic` / `/review:run-gemini`) and let it call `save-review-state.sh` before further bash.
- `apps/registry/` uses `vercel.ts` (programmatic config via `@vercel/config` devDep), not `vercel.json`. Use `git.deploymentEnabled` (not deprecated `github.enabled`) to control auto-deploy.
- Track artifacts live under `.please/docs/tracks/active/{slug}-{YYYYMMDD}/` with `spec.md`, `plan.md`, `metadata.json`. Append a JSON line to `.please/docs/tracks.jsonl` when creating a track.
- In git worktrees, `bun install` must be run before tests — dependencies are not shared across worktrees.
- `style/quote-props` ESLint rule: if any property in an interface requires quotes (e.g. `'dist-tags'`), all properties must be quoted for consistency.
- Release is managed by release-please with TWO packages: `packages/cli` (npm `@pleaseai/ask`, independent) and `.` root (`ask-plugin`, `simple` type). Root bumps when non-CLI paths change (`.claude-plugin/`, `skills/`, `commands/`, root docs) and syncs `.claude-plugin/plugin.json` via `extra-files`. See `release-please-config.json`.
- `.claude/agent-memory/` IS committed to git (not ignored) — it persists agent learnings across sessions.
- When pinning GitHub Actions by SHA, verify via `gh api repos/<owner>/<action>/git/refs/tags/<tag> -q .object.sha` — bogus SHAs with correct-looking prefixes have slipped in before (e.g. `actions/setup-node@v4.4.0` real SHA is `49933ea5288caeca8642d1e84afbd3f7d6820020`).

## CLI Architecture (packages/cli/)

**CLI framework**: citty (unjs) with consola for structured logging. Commands defined via `defineCommand` in `src/index.ts`.

**Command structure**: `ask docs {add|sync|list|remove}` — all subcommands defined inline in `src/index.ts`.

**Registry auto-detection** (`src/registry.ts`): When `--source` is omitted, the CLI fetches library config from the ASK Registry API. Supports ecosystem prefixes (`npm:next`, `pypi:fastapi`), auto-detects ecosystem from project files (package.json→npm, pom.xml/build.gradle→maven, etc.), and enriches `owner/repo` fast-path with registry `docsPath` when available.

**Source adapter pattern** (`src/sources/`):
- `index.ts` — defines `DocSource` interface, `SourceConfig` union type, and `getSource()` factory
- `npm.ts` — downloads npm tarballs, extracts doc files from package (deprecated — use resolver + github source)
- `github.ts` — downloads GitHub repo archives via tar.gz, extracts docs directory
- `web.ts` — crawls documentation websites, converts HTML to Markdown via `node-html-markdown`

All three sources implement `DocSource.fetch(options) -> Promise<FetchResult>` returning `{ files: DocFile[], resolvedVersion: string }`.

**Ecosystem resolver pattern** (`src/resolvers/`):
- `index.ts` — defines `EcosystemResolver` interface, `ResolveResult` type, and `getResolver()` factory
- `npm.ts` / `pypi.ts` / `pub.ts` — fetch package metadata APIs, extract GitHub `owner/repo`, delegate to github source
- `utils.ts` — `parseRepoUrl(url)` normalizes varied GitHub URL formats to `owner/repo`

Resolvers are orthogonal to sources — they only perform metadata lookups and hand off `repo` + `ref` to the github source. The `add` command tries the registry first; resolvers activate on registry miss for ecosystem-prefixed specs.

**Output pipeline** (executed in sequence by `add` command):
1. `storage.ts` — saves doc files to `.ask/docs/<name>@<version>/`, creates `INDEX.md`
2. `config.ts` — persists source config to `.ask/config.json` for `sync` re-download
3. `io.ts` — upserts entry into `.ask/ask.lock` for drift detection
4. `skill.ts` — generates `.claude/skills/<name>-docs/SKILL.md` with trigger metadata
5. `agents.ts` — generates/updates `AGENTS.md` with auto-generated block between marker comments

## Registry Architecture (apps/registry/)

Nuxt + Nuxt Content v3 + Nuxt UI. Registry entries are GitHub repo-based: `content/registry/<owner>/<repo>.md`. Each entry requires `repo` (owner/repo) and optional `aliases` for ecosystem lookups (e.g. `npm:react` → `facebook/react`). When `strategies` is empty, `expandStrategies()` auto-generates a github strategy from `repo` + `docsPath`. Supported ecosystems: npm, pypi, pub, go, crates, hex, nuget, maven. API: `GET /api/registry/<owner>/<repo>` (direct) or `<ecosystem>/<name>` (alias fallback). Database: D1 for production (Cloudflare), native `node:sqlite` for local build. Requires Node 22.5+ (see `.nvmrc`).

## Key Conventions

- All written artifacts (commit messages, PR titles/bodies, code comments, and documentation including CLAUDE.md, `.claude/rules/**/*.md`, spec/plan files) must be written in English
- Pure ESM (`"type": "module"`) — all imports use `.js` extensions (CLI)
- ESLint config: `@pleaseai/eslint-config` (based on `@antfu/eslint-config`) — 2-space indent, single quotes, no semicolons
- Use `consola` for all user-facing output, never raw `console.log`
- Regex patterns used in loops must be defined at module scope (`e18e/prefer-static-regex`)
- Import `process` from `node:process` explicitly (`node/prefer-global/process`)
