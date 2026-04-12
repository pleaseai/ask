# Lazy-First Architecture

> Track: lazy-first-architecture-20260412

## Overview

Refactor the ASK CLI from an eager-download-first architecture to a lazy-first architecture. Currently `ask install` and `ask add` download documentation, materialize `.ask/docs/`, generate skills, and update AGENTS.md — all eagerly. This refactoring simplifies `ask.json` to a plain spec string array, makes `ask install` generate AGENTS.md/SKILL.md with lazy references (`ask src`/`ask docs` commands) without downloading, and demotes eager download to an opt-in `--fetch` flag.

## Scope

### In Scope

1. **ask.json simplification** — Reduce `LibraryEntry[]` (with `ref`, `docsPath`, `storeMode`, `emitSkill`, `inPlace` fields) to a plain `string[]` of spec strings (e.g. `["npm:next", "npm:zod", "github:vercel/ai"]`). Remove top-level config fields (`emitSkill`, `storeMode`, `inPlace`).

2. **Lazy-first install** — `ask install` reads ask.json, resolves versions from lockfiles, and generates AGENTS.md + SKILL.md with lazy references (`ask src`/`ask docs` shell commands) instead of pre-downloaded file paths. No docs download by default.

3. **Lazy-first add** — `ask add npm:next` only registers the spec in ask.json and regenerates AGENTS.md/SKILL.md. No download triggered.

4. **Eager download opt-in** — Add `--fetch` flag to `ask install` and `ask add` that restores the old eager download behavior for users who want pre-downloaded docs.

5. **Dead code removal** — Remove or simplify code paths that become unnecessary:
   - `saveDocs` (storage.ts) — only needed in `--fetch` mode
   - `.ask/resolved.json` — only needed in `--fetch` mode
   - `contentHash`, `upsertResolvedEntry` — only needed in `--fetch` mode
   - In-place discovery pipeline — only needed in `--fetch` mode
   - Intent-skills adapter — evaluate if still needed
   - Complex `installOne` logic — simplify to lazy-first with `--fetch` branch

6. **SKILL.md template change** — Skills reference `ask src`/`ask docs` commands instead of static `.ask/docs/` paths.

7. **AGENTS.md template change** — Library sections reference lazy commands instead of vendored doc paths.

## Success Criteria

- [ ] SC-1: `ask add npm:next` only writes to ask.json and regenerates AGENTS.md/SKILL.md (no network fetch, no `.ask/docs/` creation)
- [ ] SC-2: `ask install` resolves versions from lockfiles and generates AGENTS.md/SKILL.md with `ask src`/`ask docs` references (no download)
- [ ] SC-3: `ask install --fetch` restores full eager download behavior (`.ask/docs/`, resolved.json, store materialization)
- [ ] SC-4: ask.json schema is `{ libraries: string[] }` — plain spec strings only
- [ ] SC-5: Generated SKILL.md contains `ask src`/`ask docs` commands instead of static file paths
- [ ] SC-6: Generated AGENTS.md references lazy commands with version warnings
- [ ] SC-7: `ask src` and `ask docs` commands remain unchanged
- [ ] SC-8: `ask remove` cleans up ask.json entry and regenerates AGENTS.md/SKILL.md
- [ ] SC-9: All existing tests updated or replaced to reflect new architecture
- [ ] SC-10: Dead eager-only code paths are gated behind `--fetch` or removed

## Constraints

- Breaking change — this is a major version bump. No backward compatibility with old ask.json format required.
- `ask src` and `ask docs` lazy commands remain unchanged.
- The global store (`~/.ask/`) and its integrity checks remain unchanged.

## Out of Scope

- Registry app changes (apps/registry/)
- New CLI commands beyond existing surface
- Changes to the global store layout
- opensrc integration or Rust rewrite
