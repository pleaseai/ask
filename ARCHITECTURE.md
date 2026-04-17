# ARCHITECTURE.md

> Bird's-eye view of the ASK (Agent Skills Kit) monorepo.
> Last updated: 2026-04-17

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
├── commands/
│   ├── add.ts        # runAdd() — add-time docs-path prompt + --docs-paths/--clear-docs-paths flags
│   ├── docs.ts       # runDocs() — prints candidate doc paths; honors persisted docsPaths override
│   ├── src.ts        # runSrc() — prints absolute path to cached source tree
│   ├── ensure-checkout.ts  # Shared spec resolution helper for add/docs/src
│   └── find-doc-paths.ts   # findDocLikePaths() — walks a tree for /doc/i subdirs
├── sources/
│   ├── index.ts      # DocSource interface, SourceConfig union, getSource() factory
│   ├── npm.ts        # NpmSource — local-first node_modules read, npm tarball fallback
│   ├── github.ts     # GithubSource — downloads GitHub repo archives
│   └── web.ts        # WebSource — crawls HTML, converts to Markdown
├── lockfiles/
│   └── index.ts      # npmEcosystemReader — resolves version from bun/npm/pnpm/yarn lockfile
├── discovery/
│   ├── local-intent.ts  # Checks if package ships TanStack Intent skills (intent-skills path)
│   └── candidates.ts    # gatherDocsCandidates() — offline-first probe for ask add prompt
├── storage.ts        # Saves docs to .ask/docs/<name>@<version>/, creates INDEX.md
├── io.ts             # Read/write ask.json + .ask/resolved.json; contentHash; findEntry
├── skill.ts          # Generates .claude/skills/<name>-docs/SKILL.md
└── agents.ts         # Generates/updates AGENTS.md + references in CLAUDE.md
```

**Data flow for `ask add <spec>`:**

1. **Parse + validate** — `spec.ts` parses the spec string; `commands/add.ts:normalizeAddSpec` rejects ambiguous input
2. **Probe candidates (offline-first)** — `discovery/candidates.ts:gatherDocsCandidates` walks `node_modules/<pkg>/` and calls `ensureCheckout({ noFetch: true })` to pick up any cached git checkout. `NoCacheError` is a silent skip — `ask add` never triggers a fresh clone
3. **Prompt (optional)** — when more than one candidate exists and stdout is a TTY, `consola.prompt({ type: 'multiselect' })` asks which paths to keep. `--docs-paths` / `--clear-docs-paths` flags short-circuit the prompt
4. **Persist** — `entryFromSpec(spec, docsPaths?)` canonicalizes to a bare string when there is no override, or a `{ spec, docsPaths }` object when there is; `writeAskJson` rewrites the file
5. **Install** — dispatches to `runInstall({ onlySpecs: [spec] })` below

**Data flow for `ask install`:**

1. **Resolve version** — `lockfiles/index.ts` reads the project lockfile to pin the exact version for `npm:` entries (inline `@ref` for `github:`)
2. **Skill** — `skill.ts` generates `.claude/skills/<name>-docs/SKILL.md` with lazy `ask src` / `ask docs` references
3. **Agents** — `agents.ts` updates `AGENTS.md` with the resolved library list

`ask install` is lazy — no source fetch, no tarball download, no on-disk `.ask/docs/` materialization. Documentation is fetched on demand by `ask src` / `ask docs` (both share `ensureCheckout`).

**Data flow for `ask docs <spec>`:**

1. **Resolve checkout** — `ensureCheckout` fetches-on-miss and returns the cached `checkoutDir` plus optional `npmPackageName`
2. **Consult override** — `io.ts:findEntry` matches the spec against `ask.json`; if the entry has a `docsPaths` override, only those paths (resolved against `node_modules/<pkg>` first, `checkoutDir` second) are emitted. Zero-survivor case prints a stderr warning and falls through to the default walk
3. **Walk** — `commands/find-doc-paths.ts:findDocLikePaths` surfaces every `/doc/i` subdir from each root

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

## Global Store (`~/.ask/`)

ASK maintains a per-machine docs store at `ASK_HOME` (default `~/.ask/`) so identical entries are fetched once and reused across projects. All four source kinds follow the PM-style `<kind>/<identity>@<version>/` mental model:

```
~/.ask/                                          # ASK_HOME
├── STORE_VERSION                                # always "2"
├── npm/
│   └── next@16.2.3/                             # immutable entry
├── github/
│   └── github.com/                              # host (reserved — gitlab/bitbucket later)
│       └── vercel/next.js/v16.2.3/              # per-tag shallow clone, .git/ stripped
├── web/
│   └── <sha256>/                                # crawled snapshots
├── llms-txt/
│   └── <sha256>@<version>/
└── .quarantine/                                 # corrupted entries (verifyEntry fail)
    └── <ts>-<uuid>/
```

Each github entry is an **independent shallow clone** (`git clone --depth 1 --branch <tag> --single-branch`) into a nested path — there is no shared bare repo, no `FETCH_HEAD` race, and no `owner__repo` flattening. The commit SHA is captured via `git rev-parse HEAD` before the clone strip and persisted on `ResolvedEntry.commit`.

**Integrity**: every entry is stamped by `stampEntry` on write and checked by `verifyEntry` on every store-hit short-circuit (both npm and github). A corrupt entry is moved to `<askHome>/.quarantine/<ts>-<uuid>/` and replaced by a fresh fetch on the next install.

**Store-mode materialization** (`storage.ts:saveDocs`):

| Mode   | Behavior                                                            |
|--------|---------------------------------------------------------------------|
| `copy` | Default. Full copy into `.ask/docs/<pkg>@<v>/`.                     |
| `link` | Symlink → `path.join(storePath, storeSubpath ?? '')` (copy fallback on EPERM). |
| `ref`  | No project files; AGENTS.md points at the store path directly.      |

`FetchResult.storeSubpath` carries the docs subdirectory (e.g. `docs`) from the github source through to the link/ref materialization so symlinks target the docs tree, not the repo root.

**Ref validation**: `ask.json` github entries must use tag-like refs (40-char SHA, `v?<semver>`, or strings containing a `.` or digit). `main`/`master`/`HEAD`/`latest` and bare single-word refs are rejected by `validateAskJsonStrict` at the CLI boundary. The escape hatch is `--allow-mutable-ref` on `ask install`/`ask add`, which skips the strict validation call for CI and test fixtures. See `packages/schema/src/ask-json.ts` for the schema pair (`AskJsonSchema` strict, `LaxAskJsonSchema`).

**Legacy cleanup**: pre-v2 layouts (`github/db/` + `github/checkouts/`) are detected on install start and surface a one-line warning pointing at `ask cache clean --legacy`. The legacy paths are listed by `cacheLs` with a `(legacy)` tag alongside new entries.

## Key Types

```typescript
// ask.json library entry — union of bare spec string and override object.
// The object form is emitted ONLY when the user has selected a docs-path
// subset at `ask add` time; otherwise the entry is a plain string so
// existing ask.json files stay diff-clean. Helpers specFromEntry,
// docsPathsFromEntry, and entryFromSpec live next to the schema.
type LibraryEntry = string | { spec: string, docsPaths: [string, ...string[]] }

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

// Offline-first candidate probe used by `ask add` to populate the prompt
interface CandidateGroup {
  root: string             // node_modules/<pkg> OR <checkoutDir> — docsPaths are stored relative to this
  paths: string[]          // absolute paths from findDocLikePaths; falls back to [root] when nothing matches
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
├── ask.json                           # Declarative library list (checked in).
│                                      # Entries are bare spec strings by
│                                      # default, or { spec, docsPaths } objects
│                                      # when the user pinned a docs subset at
│                                      # `ask add` time.
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
