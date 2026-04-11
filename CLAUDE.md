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
- `vendor/intent/` — git submodule: [TanStack/intent](https://github.com/TanStack/intent) (reference only)
- `vendor/opensrc/` — git submodule: [vercel-labs/opensrc](https://github.com/vercel-labs/opensrc) (reference only)

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
bun run --cwd apps/registry test                                 # unit only (e2e skipped without host)
REGISTRY_E2E_HOST=http://localhost:3000 bun run --cwd apps/registry test  # e2e against a separately started dev server

# Running CLI directly
node packages/cli/dist/index.js docs add <spec> -s <source> [options]
```

## Package Manager

**bun** — Always use bun, not npm or pnpm. Use `bunx` instead of `npx` or `pnpm dlx`.

## Gotchas

- Always use `bun run test` (not `bun test`) to run tests — `bun test` may be blocked by hooks or workspace configuration.
- bun workspace uses `.bun/` symlink structure — native Node modules (e.g. better-sqlite3) may fail to load. Prefer native alternatives (e.g. `node:sqlite`)
- Docus (Nuxt docs theme) is incompatible with bun workspace (nuxt-content/docus#1279)
- Nuxt Content v3 requires SQLite at build time even when deploying to D1. Use `experimental.sqliteConnector: 'native'` (requires Node 22.5+)
- In `content.config.ts`, import `z` from `@nuxt/content` — do not install zod separately
- `getSource(type)` (`packages/cli/src/sources/index.ts:54`) returns a `DocSource`; pass config to `DocSource.fetch(options)`, not to `getSource`. It is a single-arg factory.
- `parseSpec` lives in `packages/cli/src/spec.ts` and returns a discriminated union (`npm` / `github` / `unknown`). It is the single source of truth for translating an `ask.json` spec string into a library slug — do not reintroduce the legacy private `parseSpec(spec) -> { name, version }` from the old `index.ts`.
- In Nuxt Content v3 server routes, `queryCollection` is auto-imported — do NOT use `import { queryCollection } from '#content/server'` (that alias does not exist and breaks Cloudflare Pages build). Use the bare function or `import { queryCollection } from '@nuxt/content/server'`.
- The new top-level commands are `ask install | add | remove | list`. The legacy `ask docs add | sync | list | remove` namespace is gone — there is no deprecated wrapper. `ask install` is `postinstall`-friendly: per-entry failures emit a warning and exit code is always 0 (FR-10).
- PM-driven entries (`{ "spec": "npm:<pkg>" }`) get their version from the project's lockfile in priority order: `bun.lock → package-lock.json → pnpm-lock.yaml → yarn.lock → package.json` (range fallback). The chain lives in `packages/cli/src/lockfiles/index.ts:npmEcosystemReader`. Standalone github entries (`{ "spec": "github:owner/repo", "ref": "v1.2.3" }`) require an explicit `ref` enforced at the schema layer — there is no implicit default branch.
- A PreToolUse Bash hook blocks shell commands when the current commit has no recorded review. Run `/review:code-review` (or `/review:run-cubic` / `/review:run-gemini`) and let it call `save-review-state.sh` before further bash.
- `apps/registry/` uses `vercel.ts` (programmatic config via `@vercel/config` devDep), not `vercel.json`. Use `git.deploymentEnabled` (not deprecated `github.enabled`) to control auto-deploy.
- Track artifacts live under `.please/docs/tracks/active/{slug}-{YYYYMMDD}/` with `spec.md`, `plan.md`, `metadata.json`. Append a JSON line to `.please/docs/tracks.jsonl` when creating a track.
- In git worktrees, `bun install` must be run before tests — dependencies are not shared across worktrees.
- `style/quote-props` ESLint rule: if any property in an interface requires quotes (e.g. `'dist-tags'`), all properties must be quoted for consistency.
- Release is managed by release-please with TWO packages: `packages/cli` (npm `@pleaseai/ask`, independent) and `.` root (`ask-plugin`, `simple` type). Root bumps when non-CLI paths change (`.claude-plugin/`, `skills/`, `commands/`, root docs) and syncs `.claude-plugin/plugin.json` via `extra-files`. See `release-please-config.json`.
- `.claude/agent-memory/` IS committed to git (not ignored) — it persists agent learnings across sessions.
- When pinning GitHub Actions by SHA, verify via `gh api repos/<owner>/<action>/git/refs/tags/<tag> -q .object.sha` — bogus SHAs with correct-looking prefixes have slipped in before (e.g. `actions/setup-node@v4.4.0` real SHA is `49933ea5288caeca8642d1e84afbd3f7d6820020`).
- `ask install|add|remove` auto-manages ignore files to mark `.ask/docs/` and `.ask/resolved.json` as vendored. Writes nested configs inside `.ask/docs/` (`.gitattributes`, `eslint.config.mjs`, `biome.json`, `.markdownlint-cli2.jsonc`) and patches root `.prettierignore`/`sonar-project.properties`/`.markdownlintignore`/`.gitignore` via a marker block (`# ask:start ... # ask:end`). The legacy `manageIgnores: false` opt-out from `.ask/config.json` is gone — `manageIgnoreFiles` runs whenever `ask.json` exists. Do not hand-edit inside the marker blocks — `install`/`remove` will overwrite them.
- Convention-based discovery (`packages/cli/src/discovery/`) runs BEFORE the central registry lookup for `npm:` ecosystem specs without `--source`/`--docs-path`. Adapter priority: `local-ask` (`package.json.ask.docsPath` opt-in) → `local-intent` (packages with `keywords: ['tanstack-intent']`, wrapped around `@tanstack/intent`'s `findSkillFiles`/`parseFrontmatter`) → `local-conventions` (`dist/docs` → `docs` → `README.md` fallback with warning). First non-null wins; adapters never override earlier ones. Registry is demoted to fallback. See spec + plan in `.please/docs/tracks/active/convention-based-discovery-20260409/`.
- Intent-format packages use a separate AGENTS.md block (`<!-- intent-skills:start --> ... <!-- intent-skills:end -->`) managed by `packages/cli/src/agents-intent.ts`. The writer preserves entries from foreign packages on upsert and strips the whole block when the last entry for the target package is removed. Operates on a byte range strictly disjoint from the existing `<!-- BEGIN:ask-docs-auto-generated -->` block in `agents.ts` — neither writer touches the other region.
- `ResolvedEntry` (in `packages/schema/src/resolved.ts`) carries an optional `format?: 'docs' | 'intent-skills'`. The install orchestrator runs the `localIntentAdapter` ahead of any tarball/repo fetch for `npm:` entries — if it returns an `intent-skills` result, the entry is materialized via `upsertIntentSkillsBlock` and the resolved-cache row is tagged `format: 'intent-skills'`. `ask remove` branches on the format and dispatches to `removeFromIntentSkillsBlock` or the normal docs/skill teardown.
- Registry strategy selection (`packages/cli/src/registry.ts:selectBestStrategy`) prefers a "curated npm" strategy (`source: 'npm'` with explicit `docsPath`) over github, even when github is listed first. Without `docsPath`, the static priority table (github > npm > web > llms-txt) wins. This is what makes `vercel/ai`'s `dist/docs` actually load from npm.
- `NpmSource.fetch` (`packages/cli/src/sources/npm.ts`) is local-first: it reads `node_modules/<pkg>/<docsPath>` directly when the installed `package.json` version satisfies the request, and only falls through to a tarball download on miss. The new install orchestrator passes the lockfile-resolved version through to `NpmSource`, so the local-first short-circuit fires whenever `bun install` is up to date.
- `@nuxt/test-utils` pulls `h3-next` (npm alias → `h3@2.0.1-rc.*`) which collides with the h3 v1 that nitro/nuxt-content use. Runtime symptom: `event.req.headers.entries is not a function` thrown from `@nuxt/content`'s `fetchContent`, surfacing as Registry API 500/hang. Mitigation: a `bun patch` strips `h3-next` from `@nuxt/test-utils/package.json` (`patches/@nuxt%2Ftest-utils@4.0.0.patch`) AND a root `postinstall` removes `node_modules/.bun/h3@2.0.1-rc.*`. Bun 1.3.11 `overrides` don't reliably apply to transitive deps, so the postinstall is load-bearing. Bump the version glob when @nuxt/test-utils upgrades.
- `@nuxt/test-utils/e2e` `setup({ rootDir })` self-boot crashes inside this bun-workspace layout with `TypeError: MagicString is not a constructor` (`@vitejs/plugin-vue` follows `.bun/` symlinks into a stale `magic-string`). Use `setup({ host })` against an externally started `bun run dev`, or skip `@nuxt/test-utils` entirely and hit the dev server with native `fetch`. `apps/registry/test/e2e/` takes the native-fetch path — gated on `REGISTRY_E2E_HOST` so `bun run test` stays green without a dev server.
- `apps/registry/nuxt.config.ts` picks the Content DB backend from build-time signals (`NITRO_PRESET=cloudflare*`, `CF_PAGES=1`, or explicit `NUXT_CONTENT_DATABASE_TYPE=d1`). Do NOT rely on only `NUXT_CONTENT_DATABASE_TYPE` — if that env var is missing in a Cloudflare build, the native sqlite branch will crash the Worker on cold start.
- Nitro's dev server strips the static `headers['cache-control']` from `routeRules` and only emits the `cache` object's `s-maxage` / `stale-while-revalidate` directives. The full `public, max-age=300, ...` header only appears in production. Assert the production value in a unit test against `app/route-rules.ts`; match only `s-maxage`/`swr` regex in dev-server e2e tests.
- `ask list` is the only list command — there is no `ask docs list` wrapper anymore. `listDocs` (in `packages/cli/src/storage.ts`) reads `ask.json` joined with `.ask/resolved.json`: declared-but-not-installed entries surface as `version: 'unresolved'` so users can spot drift. Callers that iterate "docs only" (e.g. `agents.ts`'s `generateAgentsMd`) must filter on `format === 'docs'`. When spawning the compiled CLI from a `bun:test` via child_process, scrub the environment to `PATH`/`HOME`/`NO_COLOR`/`FORCE_COLOR` — inherited `BUN_*` vars put consola into a silent mode on macOS where stdout writes vanish entirely.
- `packages/cli/src/registry.ts` wraps `fetch(url)` with `AbortSignal.timeout(10_000)` — the previous unbounded fetch hung the CLI indefinitely when `ask-registry.pages.dev` was unresponsive. Never reintroduce a bare `fetch` here.
- `github`-kind store entries live at `<askHome>/github/<host>/<owner>/<repo>/<tag>/` (PM-style nested layout, host hard-coded to `github.com` for MVP). Do NOT reintroduce `github/db/` or `github/checkouts/` — those are LEGACY and collapse five correctness defects structurally when removed. The shared bare-clone subsystem (`packages/cli/src/store/github-bare.ts`) is gone; each entry is an independent shallow clone via `git clone --depth 1 --branch <tag> --single-branch` with `.git/` stripped and commit SHA captured into `ResolvedEntry.commit` before the strip. Fallback chain in `cloneAtTag` (`packages/cli/src/sources/github.ts`): try ref as-is; if it does NOT start with `v`, also try `v<ref>`. Never emit `vv1.2.3`. See track `github-store-pm-unified-20260411`.
- `ask.json` ref validation is **strict by default**: `main`/`master`/`develop`/`trunk`/`HEAD`/`latest` and any single-word ref without `.` or digit are rejected at the CLI boundary (in `runInstall` via `validateAskJsonStrict`). Schema package exports both `AskJsonSchema` (strict) and `LaxAskJsonSchema` (no refinement). `readAskJson`/`writeAskJson` ALWAYS use lax so internal readers (`listDocs`, `generateAgentsMd`, `manageIgnoreFiles`, etc.) never need to know about `--allow-mutable-ref`. CI/test paths pass `--allow-mutable-ref` to skip the strict validation call; the schema parser still reads the lax variant underneath.
- `FetchResult.storeSubpath` (`packages/cli/src/sources/index.ts`) is populated by the github source from the entry's `docsPath`. Link/ref mode in `storage.ts:saveDocs` joins `path.join(storePath, storeSubpath ?? '')` so symlinks and AGENTS.md-rendered paths point at the docs subdirectory, not the repo root. npm/web/llms-txt leave `storeSubpath` undefined and the behaviour is unchanged.
- Store-hit short-circuits in both `packages/cli/src/install.ts:274` (npm) and `packages/cli/src/sources/github.ts` (github) run `verifyEntry(storeDir)` before trusting a cached entry. Failures move the entry to `<askHome>/.quarantine/<ts>-<uuid>/` via `quarantineEntry` (in `store/index.ts`) and fall through to a fresh fetch. Never reintroduce a bare `fs.existsSync(storeDir)` check without the guard.
- `<askHome>/STORE_VERSION` is written on every `ask install` start (`writeStoreVersion` in `store/index.ts`). Current value is `"2"`. A legacy `github/db` or `github/checkouts` directory triggers a one-line warning and points at `ask cache clean --legacy`. `cacheLs` walks BOTH layouts and tags legacy entries with `legacy: true` + a `(legacy) ` key prefix.

## CLI Architecture (packages/cli/)

**CLI framework**: citty (unjs) with consola for structured logging. Commands defined via `defineCommand` in `src/index.ts`.

**Command structure**: `ask {install|add|remove|list}` — flat top-level surface defined inline in `src/index.ts`. The orchestrator lives in `src/install.ts:runInstall`.

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

**Output pipeline** (executed by `runInstall` per entry):
1. `lockfiles/index.ts:npmEcosystemReader` — resolves the version for PM-driven entries
2. `discovery/local-intent.ts` — first-pass: if the package declares `tanstack-intent`, take the intent path
3. `sources/*.fetch()` — existing source adapters (npm/github), unchanged
4. `storage.ts:saveDocs` — writes `.ask/docs/<name>@<version>/` with `INDEX.md`
5. `skill.ts:generateSkill` — writes `.claude/skills/<name>-docs/SKILL.md`
6. `io.ts:upsertResolvedEntry` — records the resolution in `.ask/resolved.json` (gitignored cache)
7. `agents.ts:generateAgentsMd` — regenerates the `<!-- BEGIN:ask-docs-auto-generated -->` block

`ask.json` is the single declarative input; `.ask/resolved.json` is a pure cache that can be deleted at any time and is rebuilt on the next `ask install`.

## Registry Architecture (apps/registry/)

Nuxt + Nuxt Content v3 + Nuxt UI. Registry entries are GitHub repo-based: `content/registry/<owner>/<repo>.md`. Each entry requires `repo` (owner/repo) and optional `aliases` for ecosystem lookups (e.g. `npm:react` → `facebook/react`). When `strategies` is empty, `expandStrategies()` auto-generates a github strategy from `repo` + `docsPath`. Supported ecosystems: npm, pypi, pub, go, crates, hex, nuget, maven. API: `GET /api/registry/<owner>/<repo>` (direct) or `<ecosystem>/<name>` (alias fallback). Database: D1 for production (Cloudflare), native `node:sqlite` for local build. Requires Node 22.5+ (see `.nvmrc`).

## Key Conventions

- All written artifacts (commit messages, PR titles/bodies, code comments, and documentation including CLAUDE.md, `.claude/rules/**/*.md`, spec/plan files) must be written in English
- Pure ESM (`"type": "module"`) — all imports use `.js` extensions (CLI)
- ESLint config: `@pleaseai/eslint-config` (based on `@antfu/eslint-config`) — 2-space indent, single quotes, no semicolons
- Use `consola` for all user-facing output, never raw `console.log`
- Regex patterns used in loops must be defined at module scope (`e18e/prefer-static-regex`)
- Import `process` from `node:process` explicitly (`node/prefer-global/process`)

<!-- please:knowledge v1 -->
## Project Knowledge

Consult these files for project context before exploring the codebase.
For full file listing with workspace artifacts, use `Skill("please:project-knowledge")`.

### Project Documents
- `ARCHITECTURE.md` — Codebase structure, module boundaries, architectural invariants

### Domain Knowledge (.please/docs/knowledge/)
- `product.md` — Product vision, goals, target users
- `product-guidelines.md` — Branding, UX principles, design system
- `tech-stack.md` — Technology choices with rationale
- `workflow.md` — Task lifecycle, TDD, quality gates, dev commands
- `gotchas.md` — Known project pitfalls and workarounds

### Decision Records
- `.please/docs/decisions/` — Architecture Decision Records (ADR)
<!-- /please:knowledge -->
