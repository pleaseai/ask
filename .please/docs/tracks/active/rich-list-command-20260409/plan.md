# Plan: Rich `ask docs list` Output

> Track: rich-list-command-20260409
> Spec: ./spec.md
> Depends on: convention-based-discovery-20260409 (must be merged first)

## Architecture

Three-layer split inside `packages/cli/src/list/`:

1. **Model** (`list/model.ts`) — pure types + Zod schema for the JSON
   contract. Single source of truth for both renderer and JSON branch.
2. **Aggregator** (`list/aggregate.ts`) — reads `.ask/ask.lock` via
   existing `readLock` + calls convention-based-discovery's
   `runLocalDiscovery` in read-only mode. Produces `ListModel`. No I/O
   to stdout. Fully unit-testable with fixture lockfiles.
3. **Renderer** (`list/render.ts`) — consumes `ListModel`, emits text
   via `consola`. Uses display helpers from `display/table.ts` +
   `display/tree.ts`.

Display helpers live under `packages/cli/src/display/` because they
are generic enough to be reused by `add`/`sync` progress output later.

`listCmd` in `index.ts:643` becomes a thin dispatcher:

```ts
run({ args }) {
  const model = buildListModel(projectDir)
  if (args.json) {
    consola.log(JSON.stringify(ListModelSchema.parse(model), null, 2))
    return
  }
  renderList(model)
}
```

## Tasks

### T-1: Dependency gate

Verify `convention-based-discovery-20260409` has merged. If not, halt
and surface the blocker. Specifically, check that:

- `NpmLockEntry.format` field exists in `packages/schema/src/lock.ts`.
- `packages/cli/src/discovery/index.ts` exists and exports
  `runLocalDiscovery`.

If either check fails, abort the track and leave a note in
`metadata.json.status = "blocked"`.

### T-2: Inspect Intent display exports

Check `vendor/intent/packages/intent/package.json.exports` (and the
pinned `@tanstack/intent` package in `node_modules` once installed) to
determine whether `display.ts` helpers (`printTable`, `printSkillTree`,
`computeSkillNameWidth`) are exported. Document the finding in an
ADR-style note inside the track directory (`decision.md`). Branches:

- **Exported** → thin wrappers in `display/table.ts`, `display/tree.ts`
  that swap `console.log` for `consola.log`.
- **Not exported** → port the implementations (TDD below covers this
  branch). License check: Intent is MIT, same as ASK, so direct port
  is fine with attribution in file header.

### T-3: Port or wrap display helpers (TDD)

Given T-2's decision, create `packages/cli/src/display/table.ts` and
`packages/cli/src/display/tree.ts`.

- **RED**: Unit tests asserting table alignment (widest cell per
  column, padding), tree indentation (two-space per level), and
  consola-compatible output (capture via `consola.mockTypes` in tests).
- **GREEN**: Implement by wrapping or porting.
- **REFACTOR**: Extract `alignColumns`, `measureColumns` helpers if
  duplicated.

Assertions include: empty table prints header only; table with one
column does not crash; skill tree with a single leaf renders without
trailing blank lines.

### T-4: Model + Zod schema

Create `packages/cli/src/list/model.ts` defining:

```ts
export const ListEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  format: z.enum(['docs', 'intent-skills']),
  source: z.enum(['tarball', 'installPath', 'github', 'web']),
  location: z.string(),
  itemCount: z.number().optional(),
  skills: z.array(SkillSchema).optional(),
})
export const ListModelSchema = z.object({ ... })
```

- **RED**: Round-trip test — a hand-written fixture object parses,
  serializes, re-parses, deep-equals.
- **GREEN**: Define schema.
- **REFACTOR**: Move `SkillSchema` to a shared place if Intent
  discovery already has one; import instead.

### T-5: `listDocs` return-shape extension

Update `packages/cli/src/storage.ts` `listDocs(projectDir)` to include
`format`, `source`, `location` per entry, sourced from the lockfile
rather than the filesystem (filesystem count is still needed for
`itemCount`).

- **RED**: Update existing `listDocs` tests (snapshot or property) to
  expect the new fields. Add a test for an entry with
  `format: 'intent-skills'` that has zero files on disk (in-place
  install) — it must still appear, with `itemCount === skills.length`.
- **GREEN**: Read `format` / `source` from lock entry; compute
  `location` from `source`:
  - `tarball` → `.ask/docs/<name>@<version>`
  - `installPath` → `node_modules/<pkg>`
  - `github` → `.ask/docs/<name>@<version>`
  - `web` → `.ask/docs/<name>@<version>`
- **REFACTOR**: Extract `resolveLocation(entry)` helper if logic grows.

Check `index.ts:679` (`remaining.length`) and any other call sites —
all must keep compiling without code changes.

### T-6: Aggregator (`list/aggregate.ts`)

- **RED**: Fixture-driven tests for four scenarios:
  1. docs-only (three packages, no intent)
  2. intent-only (two packages, each with skills)
  3. mixed (one docs + one intent)
  4. conflict (same name at two versions across sources)
- **GREEN**: Implement `buildListModel(projectDir): ListModel`:
  - Call `listDocs` for docs entries.
  - Call `runLocalDiscovery` (or a new read-only variant like
    `enumerateIntentPackages`) from the discovery module.
  - Merge by `name`; flag conflicts with differing `version`.
  - Collect warnings from discovery into `model.warnings`.
- **REFACTOR**: Separate `detectConflicts(entries)` pure function for
  direct unit testing.

### T-7: Renderer (`list/render.ts`)

Snapshot tests over the four fixture scenarios from T-6.

- **RED**: Four `.snap` files under `tests/__snapshots__/list-render/`.
- **GREEN**: Implement `renderList(model)`:
  - Empty model → `"No docs downloaded yet..."` (current message,
    preserved to avoid breaking the only existing contract).
  - Non-empty → header summary, scan coverage, table, optional skill
    tree, optional conflicts section, warnings.
  - All output via `consola.log` / `consola.info` / `consola.warn`.
- **REFACTOR**: Factor out `renderHeader`, `renderTable`,
  `renderSkillTrees`, `renderConflicts`, `renderWarnings` subfunctions.

### T-8: Wire into `listCmd` + promote to top-level

Modify `packages/cli/src/index.ts`:

1. Rename the existing `listCmd` body to a shared `runList(args)`
   helper or keep `listCmd` as the canonical command and reference it
   from both mount points.
2. Add `args: { json: { type: 'boolean', description: 'Emit JSON' } }`.
3. Replace the inline loop with `buildListModel` + `renderList` or
   `JSON.stringify(ListModelSchema.parse(model), null, 2)`.
4. Mount `listCmd` at the top level on `main.subCommands.list` so
   `ask list` works.
5. Keep `docsCmd.subCommands.list` pointing at a thin wrapper that:
   - calls `consola.warn('`ask docs list` is deprecated, use `ask list`')`
   - then delegates to `listCmd.run({ args })`.

- **RED**: Integration tests spawning the CLI (`execa`) against a
  fixture project for three invocations:
  1. `ask list` → snapshot, no warning line.
  2. `ask docs list` → snapshot identical to (1) plus one warning on
     stderr/consola.warn channel.
  3. `ask list --json` → JSON parses against the Zod schema.
- **GREEN**: Wire up both mount points.
- **REFACTOR**: None expected — `listCmd` should shrink significantly.

### T-9: End-to-end snapshot for `--json` mode

One integration test that runs `ask docs list --json` in a seeded
fixture project and pipes stdout through `JSON.parse` →
`ListModelSchema.parse`. Any schema drift fails this test.

### T-10: Lint, build, docs update

- Run `bun run --cwd packages/cli lint` and `bun run build` at root.
- Update `packages/cli/README.md` (if it documents `list`) to show
  `ask list` as primary with `ask docs list` marked deprecated, and
  the `list` subcommand help string in `index.ts`.
- Add a gotcha to `CLAUDE.md` if any non-obvious behavior emerged
  (e.g. how conflicts are picked).

## Risks

- **T-2 branch divergence**: if Intent does not export display helpers,
  T-3 grows in scope. Mitigation: timebox the port — if it exceeds
  ~150 LOC, fall back to a minimal in-house implementation instead of
  mirroring Intent 1:1.
- **`listDocs` breaking change**: adding fields is source-compatible,
  but if downstream consumers destructure with exact-type expectations,
  TypeScript may flag it. Grep for `listDocs(` before T-5 to catch all
  call sites.
- **Snapshot brittleness**: table column widths depend on the longest
  cell. Fixtures must use deterministic inputs. Normalize ANSI color
  codes in snapshots (`consola` may inject them in TTY mode) by
  forcing `FORCE_COLOR=0` in test setup.
- **Discovery coupling**: if convention-based-discovery's
  `runLocalDiscovery` is expensive (it scans `node_modules`), `list`
  becomes slow on large projects. Mitigation: add a cheap
  `enumerateIntentPackages(projectDir)` read-only variant in that
  track's follow-up, or memoize per-project.

## Rollout

- Single PR with all tasks (small feature, tight cohesion).
- Changelog entry under `packages/cli` highlighting `--json` and the
  new table layout.
- No feature flag — output change is strictly additive for users who
  parse stdout with regex (they were already on shaky ground).
