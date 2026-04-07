# Track Spec — ASK Workspace Migration to `.ask/` + Lockfile + Type-safe Config

## Context

Three new agent skills (`add-docs`, `setup-docs`, `sync-docs`) were merged in
`feat/add-docs-skills` and now live under `skills/`. They specify a workspace layout
that the CLI does not yet implement:

- Storage path: `.ask/docs/<name>@<version>/` (CLI currently writes `.please/docs/`)
- Config file: `.ask/config.json` (CLI currently writes `.please/config.json`)
- New lockfile: `.ask/ask.lock` recording resolved version, source metadata, content
  hash, and (for github) commit sha — does not exist in the CLI yet
- Type-safe schemas: `config.json` and `ask.lock` validated by Zod with discriminated
  unions, deterministic serialization (sorted keys, sorted `docs[]` by name, 2-space
  indent + trailing newline)

Without this track, the skills and the CLI describe two different worlds — anyone
running both will end up with split state.

## Goals

1. CLI uses `.ask/` instead of `.please/` for ASK-managed artifacts.
2. Single source of truth for `config.json` and `ask.lock` schemas: a `schemas.ts`
   module exporting Zod schemas + inferred TS types + reader/writer helpers.
3. CLI writes `ask.lock` on every fetch (`add`, `sync`) and reads it back for drift
   detection.
4. Migration path for existing users: detect `.please/docs/` + `.please/config.json`,
   move them to `.ask/`, log a one-time deprecation warning, never silently lose data.
5. All file I/O for config/lock goes through the helpers — no hand-rolled
   `JSON.stringify` in command code.

## Non-goals

- Plugin packaging (`plugin.json`, marketplace publish) — separate track.
- `PostToolUse` hook auto-triggering `sync-docs` — separate track.
- Schema versioning beyond v1 — first release pins `schemaVersion: 1` and
  `lockfileVersion: 1`; migration framework can come later.
- Any change to the registry API or to source adapters' fetch behavior.

## Functional requirements

**FR-1 — Workspace path**
- All read/write paths in `storage.ts`, `config.ts`, `agents.ts` must use `.ask/`.
- The marker block in `AGENTS.md` must reference `.ask/docs/...`.

**FR-2 — Type-safe config**
- New module `packages/cli/src/schemas.ts` exports `ConfigSchema`, `LockSchema`,
  `SourceConfigSchema`, `LockEntrySchema`, all as Zod discriminated unions on
  `source`. Inferred types `Config`, `Lock`, `SourceConfig`, `LockEntry` exported.
- Helpers: `readConfig(dir)`, `writeConfig(dir, c)`, `readLock(dir)`, `writeLock(dir, l)`.
  Each `read*` parses with Zod and throws on invalid input. Each `write*` validates,
  sorts deterministically, and writes 2-space indent + trailing newline.
- `docs[]` is always sorted by `name` ascending before write.

**FR-3 — Lockfile recording**
- After every successful `add` (and per-entry inside `sync`), the CLI must upsert an
  entry in `.ask/ask.lock` containing: `version`, `source`, source-specific fields
  (`repo`/`ref`/`commit` for github; `tarball`/`integrity` for npm; `url`/`urls` for
  web/llms-txt), `fetchedAt` (ISO-8601), `fileCount`, and `contentHash`
  (`sha256-<hex>` of files concatenated as `<relpath>\0<bytes>\0` in path-sorted
  order).
- For github sources, capture the resolved commit sha by following the redirect
  on the archive URL or via `GET /repos/<repo>/commits/<ref>`. If unavailable,
  omit the field rather than guess.
- For npm sources, capture `dist.integrity` from the same `npm view` call already
  used to resolve the tarball.

**FR-4 — Drift detection input**
- A new `sync` subcommand (or extension to the existing one if present) reads
  `.ask/ask.lock` first and uses `entries.<name>.version`/`commit` as the
  comparison baseline against the current resolved version from the project
  manifest/lockfile.
- If `ask.lock` has no entry for a tracked name, treat it as drifted (forces
  re-fetch to populate).

**FR-5 — Migration from legacy `.please/`**
- On any CLI invocation, if `.please/docs/` or `.please/config.json` exists and
  `.ask/` does not, perform a one-shot migration: move directories, parse the old
  config through Zod, write the new `.ask/config.json`, generate `.ask/ask.lock`
  by computing content hashes from the moved files (commit sha unknown for github
  entries — leave undefined; sync will fill it on next run).
- Print a single deprecation notice via `consola.warn` and never re-run the
  migration on subsequent invocations.

**FR-6 — Determinism**
- Re-running `ask docs add` with no actual changes must produce a byte-identical
  `config.json` and `ask.lock` (modulo `fetchedAt`/`generatedAt` timestamps, which
  only update when content actually changed).

## Success criteria

- **SC-1**: A fresh project running `ask docs add zod` produces `.ask/docs/zod@<v>/`,
  `.ask/config.json`, `.ask/ask.lock`, and `AGENTS.md` referencing `.ask/docs/...`.
  No `.please/docs/` is created.
- **SC-2**: An existing project with `.please/docs/` is migrated on the next CLI run:
  files moved, deprecation warning printed once, second run prints nothing about
  migration.
- **SC-3**: `Zod` rejects malformed `config.json` (e.g. `source: "github"` without
  `repo`) with a clear error pointing at the offending path.
- **SC-4**: Re-running `ask docs add zod@<exact-version>` twice in a row leaves
  `config.json` byte-identical and `ask.lock.entries.zod` byte-identical except for
  `generatedAt` only updating when `contentHash` actually changed.
- **SC-5**: `ask docs sync` after a `bun update zod` re-fetches only zod, deletes the
  old `.ask/docs/zod@<old>/` after the new fetch succeeds, and updates the lock.

## Risks

- Migration timing: running migration on every invocation is annoying if it logs noisily;
  use a sentinel file or check `.ask/` existence to ensure exactly-once.
- Hash computation cost on large doc trees — should still be sub-second but worth a
  smoke test on a directory with thousands of files.
- npm `dist.integrity` format varies between registries — validate the regex is
  permissive enough.

## Out of scope

- Changing the registry resolution priority order (already shipped: github > npm > web > llms-txt).
- Refactoring source adapters internal logic.
- Schema migration framework — punt to first version bump.
