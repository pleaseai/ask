---
adr: 0001
title: Registry entry schema — Entry → Package → Source hierarchy
status: Accepted
date: 2026-04-09
---

# ADR-0001: Registry entry schema — Entry → Package → Source hierarchy

## Status

Accepted (implemented 2026-04-09)

## Context

The ASK Registry (`apps/registry/content/registry/<owner>/<repo>.md`) is the
source of truth that tells the `@pleaseai/ask` CLI where and how to download
documentation for a library. Each entry is a single Markdown file with YAML
frontmatter, validated by `apps/registry/content.config.ts` against a schema
defined in `packages/schema/src/`.

The current schema places a single `strategies` list at the top level of the
entry, alongside top-level `aliases`, `docsPath`, and `repo`:

```yaml
repo: mastra-ai/mastra
docsPath: docs
aliases:
  - { ecosystem: npm, name: "@mastra/core" }
  - { ecosystem: npm, name: "@mastra/memory" }
strategies:
  - { source: npm, package: "@mastra/core",   docsPath: dist/docs }
  - { source: npm, package: "@mastra/memory", docsPath: dist/docs }
  - { source: github, repo: mastra-ai/mastra, docsPath: docs }
```

As monorepo libraries like `mastra-ai/mastra` and `vercel/ai` entered the
registry, `strategies` started carrying two semantically distinct concerns in
the same list:

1. **Dispatch** — "the user asked for `@mastra/core`, give them that package's
   docs, not `@mastra/memory`'s." This is a routing concern keyed by alias.
2. **Fallback chain** — "try the npm tarball first; if the curated docs
   directory is missing, fall back to the GitHub archive." This is the classic
   Strategy Pattern usage.

The server compensates at runtime with two pieces of implicit logic in
`apps/registry/server/api/registry/[...slug].get.ts`:

- `disambiguateStrategies(all, requestedPackage)` reorders the list by
  matching on a strategy's `package` field.
- `npmStrategyCount > 1` is used as a heuristic to detect monorepo entries,
  which then triggers `slugifyPackageName(second)` to produce a per-package
  `resolvedName` so different scoped packages land in distinct
  `.ask/docs/<slug>@<ver>` directories on the CLI side.

The top-level `aliases` list has the same problem in reverse: aliases belong
to a specific package inside a monorepo, but the schema places them at the
entry level with no way to express that binding. The server infers the
binding by matching `alias.name` against `strategy.package` at request time.

Consequences of the current shape:

- The name `strategies` misleads contributors — it is read as "fallback
  alternatives" but is being used as a dispatch table.
- Monorepo support is a runtime heuristic (npm-count ≥ 2), not an explicit
  schema state. A single-package entry that happens to list two npm
  strategies for different docs paths would be misclassified.
- The top-level `docsPath` and the per-strategy `docsPath` compete, and the
  top-level one is only meaningful for the auto-generated github fallback.
- Package-level metadata (a package-specific `description`, `deprecated`
  flag, `since`/`until` version bounds) has no natural home.
- The CLI, server, and docs use inconsistent vocabulary: "strategy",
  "package", "source", "alias", "resolvedName" all appear without a clear
  hierarchy.

The project is in early development (pre-1.0, few entries), so migration
cost is not a constraint for this decision. The goal is to pick the shape
we want to live with as the registry grows.

## Decision

Restructure the registry entry schema around an explicit three-level
hierarchy: **Entry → Package → Source.**

- **Entry** — one Markdown file per GitHub repository. Holds repo-level
  metadata (`name`, `description`, `repo`, `homepage`, `license`, `tags`).
- **Package** — a documentation target. Single-package libraries have one;
  monorepos have N. Each package owns its `aliases` and its `sources`.
  A package also carries its own `name`, which the server slugifies into
  the CLI's `resolvedName`.
- **Source** — a way to fetch one package's docs. Multiple sources form a
  fallback chain in declaration order ("the first one that works wins").
  Each source declares a `type` (`npm` | `github` | `web` | `llms-txt`)
  and type-specific fields.

Canonical shape:

```yaml
---
name: Mastra
description: TypeScript framework for AI agents, workflows, and RAG
repo: mastra-ai/mastra
homepage: https://mastra.ai
license: Apache-2.0
tags: [ai, agents, framework, typescript, rag]

packages:
  - name: "@mastra/core"
    aliases:
      - { ecosystem: npm, name: "@mastra/core" }
    sources:
      - type: npm
        package: "@mastra/core"
        path: dist/docs

  - name: "@mastra/memory"
    aliases:
      - { ecosystem: npm, name: "@mastra/memory" }
    sources:
      - type: npm
        package: "@mastra/memory"
        path: dist/docs
---
```

Single-package entries collapse to `packages` of length 1:

```yaml
packages:
  - name: zod
    aliases:
      - { ecosystem: npm, name: zod }
    sources:
      - type: github
        repo: colinhacks/zod
        path: docs
```

Entries with a fallback chain express it inside one package's `sources`:

```yaml
packages:
  - name: ai
    aliases:
      - { ecosystem: npm, name: ai }
    sources:
      - type: npm      # 1st choice
        package: ai
        path: dist/docs
      - type: github   # fallback
        repo: vercel/ai
        path: content/docs
```

Field renames from the current schema:

| Old | New | Reason |
|---|---|---|
| `strategies` (top-level) | `packages[].sources` | Name reflects actual semantics (fallback chain, not dispatch) |
| `source: npm` | `type: npm` | `sources` containing `source:` fields was redundant |
| `docsPath` (any level) | `path` (on source) | Parent context already implies "docs" |
| `aliases` (top-level) | `packages[].aliases` | Aliases belong to a package, not an entry |
| `docsPath` (top-level, entry) | removed | No longer needed; each source carries its own `path` |

The CLI lock file's `resolvedName` remains the slugified package name; the
server produces it from `packages[i].name` instead of the current
`slugifyPackageName(second)` heuristic on the requested alias.

## Consequences

### Positive

- Server logic becomes declarative. `disambiguateStrategies` and the
  `npmStrategyCount > 1` monorepo heuristic are deleted. Looking up an
  alias is: "find the `package` whose `aliases` include this request,
  return its `sources`."
- Monorepo support is a first-class schema state (`packages.length > 1`),
  not an inferred property. Intent lives in the data.
- `sources` carries only one meaning — fallback alternatives — so it
  aligns with the Strategy Pattern usage readers expect.
- Package-level metadata has an obvious home for future additions
  (per-package `description`, `deprecated`, `since`, custom `resolvedName`
  overrides, etc.) without re-nesting.
- The vocabulary Entry / Package / Source becomes the ubiquitous language
  for the registry across CLI code, server code, content files, and docs.
- Alias conflicts (two packages claiming the same alias) surface at build
  time via schema validation, not as undefined runtime behavior.
- Direct `owner/repo` lookups for monorepo entries can now return a
  well-defined error ("multiple packages; specify which one") instead of
  the current behavior of silently picking a head strategy via
  `selectBestStrategy`.

### Negative

- Schema is nominally deeper (3 levels vs. 2), which slightly increases the
  minimum verbosity of a single-package entry. Mitigated by the fact that
  single-package entries are still only ~8 lines and read top-to-bottom.
- All existing registry entries must be rewritten. Acceptable given the
  stated "ignore migration cost" framing, but means the change is not a
  drop-in schema patch — it touches content files, `content.config.ts`,
  `packages/schema/src/`, `apps/registry/server/api/registry/[...slug].get.ts`,
  and `packages/cli/src/registry.ts` in one coordinated change.
- The CLI's `selectBestStrategy` rule "curated npm wins outright"
  (`packages/cli/src/registry.ts:236-241`) must move into the entry
  author's hands: whoever writes the entry decides the `sources` order,
  and the CLI honors it literally. Loses an implicit guarantee, gains
  transparency.

### Neutral

- The registry stays file-per-repo; only the internal structure of each
  file changes.
- Ecosystem aliasing (npm, pypi, pub, go, crates, hex, nuget, maven)
  continues to work the same way — it just attaches one level deeper.
- The public CLI surface (`ask docs add npm:@mastra/core`) is unchanged.
- `llms-txt` source type remains behind `content.config.ts` schema
  enablement, same as today.

## Alternatives Considered

- **Rename only, keep flat shape (`strategies` → `targets` or `sources`).**
  Lowest-effort option. Removes the "Strategy Pattern" connotation but
  preserves the dual meaning (dispatch + fallback) in one list. Server's
  `disambiguateStrategies` and monorepo heuristic stay. Rejected because
  it paints over the naming symptom without fixing the structural cause.

- **Two parallel top-level fields: `packages` + `fallbacks`.** Split
  dispatch (`packages`) from fallback (`fallbacks`), but make `fallbacks`
  an entry-level shared list that applies to all packages. Simpler for
  monorepos where every package shares the same GitHub fallback. Rejected
  because it couples per-package fallback choices — a package without a
  useful GitHub fallback (e.g. docs only on npm) cannot opt out, and
  per-package `path` variations in the fallback are hard to express.

- **Split into multiple files per package** (e.g. `mastra-ai/mastra-core.md`,
  `mastra-ai/mastra-memory.md`). Considered in an earlier conversation.
  Rejected because (a) it breaks the `<owner>/<repo>.md` file-path
  convention the content collection relies on, (b) it duplicates
  entry-level metadata (`repo`, `license`, `homepage`) across files, and
  (c) it fragments the reader's view of a single library's documentation
  surface.

- **Keep current schema, document the dual meaning.** Adding extensive
  comments to `content.config.ts` and the README to warn contributors
  about the two meanings of `strategies`. Rejected because documentation
  debt compounds; every future reader has to learn the same quirk.

## Links

- Current schema: `packages/schema/src/` (`RegistryEntry`, `RegistryStrategy`,
  `RegistryAlias`, `expandStrategies`)
- Current server: `apps/registry/server/api/registry/[...slug].get.ts`
  (`disambiguateStrategies`, `slugifyPackageName`, monorepo heuristic)
- Current CLI strategy selection: `packages/cli/src/registry.ts`
  (`selectBestStrategy`, `resolveFromRegistry`)
- Existing monorepo entry: `apps/registry/content/registry/mastra-ai/mastra.md`
- Existing single-package with fallback: `apps/registry/content/registry/vercel/ai.md`
