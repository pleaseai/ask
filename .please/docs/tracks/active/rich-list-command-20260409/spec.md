# Rich `ask docs list` Output

> Track: rich-list-command-20260409
> Type: feature
> Depends on: convention-based-discovery-20260409

## Overview

The current `ask docs list` (`packages/cli/src/index.ts:643`) prints only
`<name>@<version> (N files)` per entry. This track also promotes the
command to a top-level `ask list`, matching `bunx @tanstack/intent list`
and dropping the unnecessary `docs` namespace (currently the only
namespace under `ask`). `ask docs list` is kept as a deprecated alias
that prints a one-line warning and forwards to `ask list`. Once
`convention-based-discovery-20260409` lands, a single project can host
two kinds of entries (classic `format: 'docs'` and
`format: 'intent-skills'` with per-package skill trees), plus
in-place-installed packages that reference `node_modules/<pkg>/`
directly. The minimal output hides all of that — users cannot see which
skills each package contributes, where the files actually live, or why
two versions of the same package coexist.

TanStack Intent's `list` command (`vendor/intent/packages/intent/src/commands/list.ts`)
solves the same shape of problem for Intent-format packages. We adopt
its presentation (summary line, scan coverage, table, skill tree,
version conflicts, `--json`) and extend it so a single invocation shows
both ASK docs entries and Intent-shaped entries in one coherent view.

## Scope

### In scope

**New output layout** (human-readable, default)

1. Header summary: `N packages, M skills/docs files (<package-manager>)`
2. Scan coverage line: `Scanned: .ask/docs/, node_modules/ (local packages take precedence)`
3. Table: `PACKAGE | VERSION | FORMAT | LOCATION | ITEMS`
   - `FORMAT`: `docs` | `intent-skills`
   - `LOCATION`: `.ask/docs/...` for tarball installs, `node_modules/<pkg>/...` for in-place, `skills/` for intent entries
   - `ITEMS`: file count for `docs`, skill count for `intent-skills`
4. Skill tree (intent entries only): hierarchical print reusing
   `printSkillTree` / `computeSkillNameWidth` from Intent's `display.ts`
   ported or wrapped.
5. Version conflicts section: when the same `name` appears with two
   versions (e.g. one in `.ask/docs/<name>@1.0.0` and one resolved
   in-place at a different version), print a block showing chosen vs.
   also-found variants.
6. Warnings section at the bottom (drift detected, missing `installPath`,
   stale lock entry).

**`--json` flag**

Emits a stable schema:

```json
{
  "packageManager": "bun",
  "scanCoverage": { "ask": true, "nodeModules": true },
  "packages": [
    {
      "name": "zod",
      "version": "3.22.4",
      "format": "docs",
      "source": "tarball",
      "location": ".ask/docs/zod@3.22.4",
      "itemCount": 42
    },
    {
      "name": "@tanstack/router",
      "version": "1.0.0",
      "format": "intent-skills",
      "source": "installPath",
      "location": "node_modules/@tanstack/router",
      "skills": [{ "name": "usage", "path": "skills/usage/SKILL.md", "type": "reference" }]
    }
  ],
  "conflicts": [
    {
      "name": "zod",
      "chosen": { "version": "3.22.4", "location": ".ask/docs/zod@3.22.4" },
      "variants": [{ "version": "3.20.0", "location": "node_modules/zod" }]
    }
  ],
  "warnings": []
}
```

No field may be removed in future releases — additive changes only.

**Data aggregation layer** (`packages/cli/src/list/`)

A small module that turns `.ask/ask.lock` + `.ask/docs/` filesystem
state into the rendered/JSON model. Two sources:

1. `listDocs(projectDir)` (existing) — enriched to read `format` and
   `source` from each lock entry.
2. Intent scan — when convention-based-discovery's Intent adapter is
   present, call `runLocalDiscovery` in "read-only list mode" to surface
   Intent packages that were registered via `intent-skills:start/end`
   in `AGENTS.md`.

Conflict detection compares `name` across both sources and groups by
name → pick the entry whose `format === 'docs'` or whose lock
`createdAt` is newest (tie-break).

**Display helpers**

Either port Intent's `printTable`, `printSkillTree`,
`computeSkillNameWidth` helpers into `packages/cli/src/display/` or
wrap `@tanstack/intent`'s public display exports if they are exported.
Prefer reuse to avoid drift. (An early task checks which helpers are
actually exported by the pinned Intent version.)

**Exit codes**

Unchanged: `0` on success, `1` on fatal errors. Warnings do not alter
exit code.

### Out of scope

- Adding `ask docs list --verbose` / `--quiet` flags beyond `--json`.
- Filtering (`--format=intent-skills` etc.) — can follow in a future
  track if users ask.
- Modifying the lock schema itself (handled by convention-based-discovery).
- Changing `list` output for the registry browser (`apps/registry`).
- Runtime fetching of registry metadata to enrich list output.

## Success Criteria

- [ ] **SC-1**: `ask docs list` in a project with only `format: 'docs'`
      entries prints a summary line, table, and no skill tree section.
      No "intent" wording appears when zero intent entries exist.
- [ ] **SC-2**: `ask docs list` in a project with only intent entries
      prints header + scan coverage + skill tree, matching the visual
      shape of `bunx @tanstack/intent list` (minor differences allowed
      for header wording).
- [ ] **SC-3**: `ask docs list` in a mixed project prints both sections
      in the table with correct `FORMAT` column values and correct
      `LOCATION` paths. Adding a second version of the same package
      (one in `.ask/docs/`, one via `installPath`) surfaces in the
      Version conflicts section.
- [ ] **SC-4**: `ask docs list --json` output validates against a
      Zod schema committed in the same track; snapshot tests lock
      the schema so future changes must update the schema file.
- [ ] **SC-5**: Existing tests for `listDocs(projectDir)` pass unchanged;
      no regression in `ask docs add`/`sync`/`remove` behavior.
- [ ] **SC-7**: `ask list` and `ask docs list` produce identical stdout
      modulo a single deprecation warning line emitted only by the
      latter. Both accept `--json` and produce byte-identical JSON.
- [ ] **SC-6**: `packages/cli` builds and lints clean; root
      `bun run build` pipeline is unchanged.

## Constraints

- **Depends on convention-based-discovery-20260409**. Cannot start
  until that track's `format` field and Intent discovery adapters are
  merged, because the aggregation layer reads both. The plan's first
  task is a dependency check that halts early if not met.
- **Additive JSON schema only** — no field removals or renames after
  first release.
- **No new runtime dependencies** beyond what convention-based-discovery
  already pins (`@tanstack/intent`).
- **CLI interface**: promotes `list` to top-level (`ask list`) and adds
  `--json` flag. `ask docs list` is preserved as a deprecated alias
  emitting a `consola.warn` line ("`ask docs list` is deprecated, use
  `ask list`") then delegating. No other subcommand renames.
- **Respect `consola`**: all human output goes through `consola`, never
  raw `console.log`, to match project convention (CLAUDE.md). This is
  a notable divergence from Intent's direct `console.log` usage —
  helper ports must swap the output sink.

## Technical Notes

- **Reference implementation**: `vendor/intent/packages/intent/src/commands/list.ts`
  (formatScanCoverage, printVersionConflicts, JSON branch, skill tree).
- **Helpers to port or wrap**: `vendor/intent/packages/intent/src/display.ts`
  (`printTable`, `printSkillTree`, `computeSkillNameWidth`). Confirm
  whether `@tanstack/intent` exports these via `package.json.exports`
  before committing to "port" — if exported, wrap instead.
- **New files**:
  - `packages/cli/src/list/model.ts` — `ListModel`, `ListEntry`,
    `ListConflict` types; schema (Zod).
  - `packages/cli/src/list/aggregate.ts` — builds `ListModel` from lock
    + Intent scan.
  - `packages/cli/src/list/render.ts` — text renderer (table, tree,
    conflicts, warnings).
  - `packages/cli/src/display/table.ts`, `tree.ts` — ported or wrapped
    Intent display helpers (consola-aware).
- **Modifications**:
  - `packages/cli/src/index.ts:643` — `listCmd` gains `args: { json: ... }`,
    delegates to `buildListModel` + `renderList` / JSON stringify.
  - `packages/cli/src/storage.ts` — `listDocs` returns `format`,
    `source`, `location` fields instead of just `{ name, version, fileCount }`.
    Downstream call sites (currently only `removeCmd` using
    `remaining.length`) use `.length` so the change is
    source-compatible.
- **Tests**:
  - Unit: aggregator with fixture lockfiles (docs-only, intent-only,
    mixed, conflicting).
  - Snapshot: text render for each of the four fixture shapes.
  - Schema: JSON mode validated against the Zod schema; snapshot test
    prevents silent schema drift.
