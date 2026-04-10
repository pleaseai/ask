# ARCHITECTURE.md

> Bird's-eye view of the ASK (Agent Skills Kit) monorepo.
> Last updated: 2026-04-10

## Overview

ASK is a CLI tool + web registry that downloads version-specific library documentation and generates `AGENTS.md` + Claude Code skills so AI coding agents reference accurate docs instead of hallucinating from stale training data.

The system has two components: a **CLI** (`packages/cli/`) that developers run locally, and a **Registry** (`apps/registry/`) that serves community-curated library configs via a Nuxt web app on Cloudflare Pages.

```
Developer runs:  ask add npm:next
                       │
                       ▼
              ┌─────────────────┐
              │   CLI (citty)   │
              │  packages/cli/  │
              └────────┬────────┘
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
      ┌──────────┐ ┌────────┐ ┌──────┐
      │ Registry │ │ Source │ │Output│
      │  Lookup  │ │Adapter │ │ Pipe │
      └──────────┘ └────────┘ └──────┘
            │          │          │
            ▼          ▼          ▼
      Config from   Download   .ask/docs/
      API or flags  docs       AGENTS.md
                               .claude/skills/
```

## Entry Points

| Entry Point | Purpose | When to read |
|---|---|---|
| `packages/cli/src/index.ts` | CLI commands (`ask install/add/remove/list`) | Understanding command flow |
| `packages/cli/src/sources/index.ts` | `DocSource` interface + `getSource()` factory | Adding a new source adapter |
| `packages/cli/src/registry.ts` | Registry API client + ecosystem detection | Changing auto-detection logic |
| `apps/registry/app/pages/index.vue` | Registry home page (search + grid) | Modifying the registry UI |
| `apps/registry/content.config.ts` | Content collection schema (Zod) | Changing registry entry format |

## Module Structure

### `packages/cli/` — CLI (`@pleaseai/ask`)

```
src/
├── index.ts          # Command definitions (citty defineCommand): install/add/remove/list
├── install.ts        # runInstall() orchestrator — drives the full output pipeline
├── spec.ts           # parseSpec() — canonical spec string → discriminated union
├── registry.ts       # Registry API lookup + ecosystem auto-detection
├── sources/
│   ├── index.ts      # DocSource interface, SourceConfig union, getSource() factory
│   ├── npm.ts        # NpmSource — local-first node_modules read, npm tarball fallback
│   ├── github.ts     # GithubSource — downloads GitHub repo archives
│   └── web.ts        # WebSource — crawls HTML, converts to Markdown
├── lockfiles/
│   └── index.ts      # npmEcosystemReader — resolves version from bun/npm/pnpm/yarn lockfile
├── discovery/
│   └── local-intent.ts  # Checks if package ships TanStack Intent skills (intent-skills path)
├── storage.ts        # Saves docs to .ask/docs/<name>@<version>/, creates INDEX.md
├── io.ts             # Read/write ask.json + .ask/resolved.json; contentHash
├── skill.ts          # Generates .claude/skills/<name>-docs/SKILL.md
└── agents.ts         # Generates/updates AGENTS.md + references in CLAUDE.md
```

**Data flow for `ask add <spec>` / `ask install`:**

1. **Parse** — `spec.ts` parses spec string (`npm:zod` → kind, name; `github:owner/repo` → kind, owner, repo)
2. **Resolve version** — `lockfiles/index.ts` reads the project lockfile to pin the exact version for `npm:` entries
3. **Discover** — `discovery/local-intent.ts` checks if the package is a TanStack Intent package (short-circuits to intent path if so)
4. **Registry** — `registry.ts` fetches strategy from Registry API to find best docs source (omitted when `--source` is set)
5. **Fetch** — `sources/*.ts` downloads docs via the appropriate adapter
6. **Store** — `storage.ts` writes files to `.ask/docs/<name>@<version>/`
7. **Cache** — `io.ts` upserts version/hash into `.ask/resolved.json` for drift detection
8. **Skill** — `skill.ts` generates `.claude/skills/<name>-docs/SKILL.md`
9. **Agents** — `agents.ts` updates `AGENTS.md` with all downloaded doc references

### `apps/registry/` — Registry Browser (`@pleaseai/ask-registry`)

```
app/
├── app.vue                          # Root component
├── pages/
│   ├── index.vue                    # Home — search + library grid
│   └── registry/[...slug].vue      # Detail — /registry/npm/zod
└── assets/css/main.css

content/registry/                    # Community-curated library configs
├── vercel/                          # github owner
│   └── next.js.md
├── colinhacks/                      # github owner
│   └── zod.md
└── fastapi/                         # github owner
    └── fastapi.md
```

**Registry entry format** (YAML frontmatter in `.md` files):

```yaml
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
```

**Content API**: Nuxt Content v3 exposes registry entries as JSON via `/api/registry/{owner}/{name}`. The CLI fetches this during `ask add` / `ask install` when `--source` is omitted, passing either `{ecosystem}/{name}` (for ecosystem-prefixed specs) or `{owner}/{repo}` (for github shorthand specs).

## Key Types

```typescript
// Source adapter interface — all sources implement this
interface DocSource {
  fetch(options: SourceConfig): Promise<FetchResult>
}

// Union of all source configurations
type SourceConfig = NpmSourceOptions | GithubSourceOptions | WebSourceOptions | LlmsTxtSourceOptions

// Common result from any source
interface FetchResult {
  files: DocFile[]         // { path: string, content: string }
  resolvedVersion: string
}

// Registry entry from the API
interface RegistryEntry {
  name: string
  description: string
  repo: string             // GitHub owner/repo (e.g. "colinhacks/zod")
  docsPath?: string
  homepage?: string
  license?: string
  aliases?: { ecosystem: string, name: string }[]
  strategies: RegistryStrategy[]
  tags?: string[]
}
```

## Architecture Invariants

These constraints must be maintained across all changes:

1. **Source adapters are stateless** — each `DocSource.fetch()` call is independent. No shared state between fetches.
2. **Output pipeline is sequential** — storage → resolved-cache → skill → agents. Each step depends on the previous.
3. **Registry is read-only for CLI** — the CLI only fetches from the registry API, never writes to it.
4. **Pure ESM everywhere** — all imports use `.js` extensions. No CommonJS.
5. **CLI output via consola only** — never use raw `console.log`. Use `consola.info/success/warn/error`.
6. **Ecosystem detection is file-based** — `package.json` → npm, `pyproject.toml` → pypi, etc. No network calls for detection.
7. **Generated files have markers** — `AGENTS.md` uses comment markers (`<!-- BEGIN:ask-docs-auto-generated -->` / `<!-- END:ask-docs-auto-generated -->`) for the auto-generated block. Other content outside markers is preserved.

## Files Generated in User Projects

When a developer runs `ask add` or `ask install`, these files are created/updated:

```
project-root/
├── ask.json                           # Declarative library list (checked in)
├── .ask/
│   ├── resolved.json                  # Cache: resolved versions/hashes (gitignored)
│   └── docs/
│       └── <name>@<version>/
│           ├── INDEX.md               # Auto-generated file listing
│           └── *.md                   # Documentation files
├── .claude/
│   └── skills/
│       └── <name>-docs/
│           └── SKILL.md               # Claude Code skill with trigger metadata
├── AGENTS.md                          # Summary referencing all downloaded docs
└── CLAUDE.md                          # Updated to reference AGENTS.md
```

## Cross-Cutting Concerns

### Error Handling

- Network errors (registry unreachable, npm/GitHub down) → `consola.warn` with fallback suggestion
- Missing docs in package → `consola.warn` listing searched paths
- Invalid spec format → `consola.error` with usage example

### Ecosystem Detection

The CLI auto-detects the project ecosystem from marker files:

| File | Ecosystem |
|---|---|
| `package.json` | npm |
| `pubspec.yaml` | pub |
| `pyproject.toml` / `requirements.txt` | pypi |
| `go.mod` | go |
| `Cargo.toml` | crates |
| `mix.exs` | hex |
| `pom.xml` / `build.gradle` / `build.gradle.kts` | maven |
| (default) | npm |

### Build & Development

```bash
bun install               # Install all workspace dependencies
bun run build             # Build all packages (Turborepo)
bun run dev               # Watch mode for all packages
bun run lint              # ESLint across all packages
```

| Package | Build | Dev |
|---|---|---|
| CLI | `tsc` → `dist/` | `tsc --watch` |
| Registry | `nuxt build` → `.output/` | `nuxt dev` |

### Deployment

- **CLI**: Published to npm as `@pleaseai/ask`
- **Registry**: Deployed to Cloudflare Pages (SQLite locally, D1 in production for Nuxt Content)
