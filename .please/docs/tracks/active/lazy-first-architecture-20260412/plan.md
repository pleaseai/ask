# Plan: Lazy-First Architecture

> Track: lazy-first-architecture-20260412
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: lazy-first-architecture-20260412
- **Issue**: #69
- **Created**: 2026-04-12
- **Approach**: Clean Architecture

## Purpose

After this change, developers will run `ask add npm:next` to register a library and `ask install` to generate AGENTS.md/SKILL.md — with zero network fetches or disk writes beyond those files. AI agents will use `ask src`/`ask docs` for on-demand documentation access. They can verify it works by checking that `ask install` completes instantly and SKILL.md references `ask src`/`ask docs` commands.

## Context

The current ASK CLI requires an eager download pipeline: `ask add` and `ask install` fetch documentation from npm/GitHub, write to `.ask/docs/`, generate resolved.json caches, and produce AGENTS.md/SKILL.md pointing at those vendored paths. This creates friction: slow installs, large `.ask/docs/` directories in projects, stale docs, and complex code paths (in-place discovery, intent-skills, store-hit guards, content hashing).

The lazy commands `ask src` and `ask docs` (shipped in #63) already provide on-demand documentation access via `ensureCheckout()`. The global store (`~/.ask/`) caches entries across projects. This refactoring makes lazy the default and demotes eager download to `--fetch`.

The `ask.json` schema currently uses `LibraryEntry[]` with `ref`, `docsPath`, `storeMode` fields plus top-level `emitSkill`/`storeMode`/`inPlace` config. Since lazy mode resolves versions from lockfiles and metadata from the registry, these fields are unnecessary. The schema simplifies to `{ libraries: string[] }`. For github entries, the ref is encoded in the spec string: `github:owner/repo@v1.2.3` — already parsed by `splitExplicitVersion` in `ensure-checkout.ts`.

This is a breaking change (major version bump). No backward compatibility with old ask.json format is required.

## Architecture Decision

The install pipeline splits into two modes sharing the same entry point (`runInstall`):

1. **Default (lazy)**: Read ask.json → resolve versions from lockfile → generate lazy SKILL.md (referencing `ask src`/`ask docs`) → generate lazy AGENTS.md → done. No network, no `.ask/docs/`, no resolved.json.

2. **`--fetch` (eager)**: The existing pipeline preserved behind a flag. Downloads docs, writes `.ask/docs/`, stamps resolved.json, generates SKILL.md/AGENTS.md with static paths.

The lazy SKILL.md template uses shell substitution patterns (`ask src <pkg>`, `ask docs <pkg>`) so agents can access docs on-demand. Version warnings remain to alert agents about training data drift.

The schema package (`packages/schema/src/ask-json.ts`) drops `LibraryEntry`, `PmDrivenLibraryEntry`, `StandaloneGithubLibrary` types and replaces them with a simple `z.array(z.string())` for the `libraries` field.

## Architecture Diagram

```
ask add npm:next
  │
  ├─ write ask.json: ["npm:next"]
  └─ ask install (implicit)
       │
       ├─ resolve version from lockfile → 16.2.3
       ├─ generate SKILL.md (lazy refs)
       ├─ generate AGENTS.md (lazy refs)
       └─ done (no network)

Agent needs docs:
  │
  └─ ask src next
       │
       ├─ cache hit? → return path
       └─ cache miss? → fetch → cache → return path
```

## Tasks

- [ ] T001 Simplify ask.json schema to string array (file: packages/schema/src/ask-json.ts)
- [ ] T002 Update io.ts for new ask.json format (file: packages/cli/src/io.ts, depends on T001)
- [ ] T003 Create lazy SKILL.md generator (file: packages/cli/src/skill.ts, depends on T002)
- [ ] T004 Create lazy AGENTS.md generator (file: packages/cli/src/agents.ts, depends on T002)
- [ ] T005 Refactor install.ts to lazy-first with --fetch gate (file: packages/cli/src/install.ts, depends on T003, T004)
- [ ] T006 Update CLI commands: add/remove/install/list (file: packages/cli/src/index.ts, depends on T005)
- [ ] T007 [P] Update ignore-files.ts for simplified ask.json (file: packages/cli/src/ignore-files.ts, depends on T002)
- [ ] T008 [P] Update storage.ts listDocs for new format (file: packages/cli/src/storage.ts, depends on T002)
- [ ] T009 Update tests for new architecture (depends on T005, T006, T007, T008)

## Key Files

### Modify

- `packages/schema/src/ask-json.ts` — Simplify schema: `LibraryEntry[]` → `string[]`, remove `StoreMode`, config fields
- `packages/cli/src/io.ts` — Update `readAskJson`/`writeAskJson` for new schema, gate `resolvedJson` behind fetch mode
- `packages/cli/src/skill.ts` — New lazy `generateSkill` template with `ask src`/`ask docs` references
- `packages/cli/src/agents.ts` — New lazy `generateAgentsMd` with lazy command references
- `packages/cli/src/install.ts` — Split `runInstall` into lazy default + `--fetch` eager branch
- `packages/cli/src/index.ts` — Add `--fetch` flag to install/add commands, simplify add command
- `packages/cli/src/ignore-files.ts` — Adapt to simplified ask.json (no LibraryEntry access)
- `packages/cli/src/storage.ts` — Adapt `listDocs` to read from simplified ask.json

### Reuse (unchanged)

- `packages/cli/src/commands/ensure-checkout.ts` — Lazy resolution helper (core of lazy path)
- `packages/cli/src/commands/src.ts` — `ask src` command (unchanged)
- `packages/cli/src/commands/docs.ts` — `ask docs` command (unchanged)
- `packages/cli/src/lockfiles/index.ts` — Lockfile version resolution (reused by lazy install)
- `packages/cli/src/spec.ts` — Spec parsing (unchanged)
- `packages/cli/src/store/` — Global store infrastructure (unchanged)

## Verification

### Automated Tests

- [ ] `ask add npm:next` writes `{ "libraries": ["npm:next"] }` to ask.json (no download)
- [ ] `ask install` with ask.json generates AGENTS.md with `ask src`/`ask docs` references
- [ ] `ask install` with ask.json generates SKILL.md with lazy command references
- [ ] `ask install --fetch` downloads docs and creates `.ask/docs/` (eager behavior preserved)
- [ ] `ask remove next` removes from ask.json and regenerates AGENTS.md/SKILL.md
- [ ] Generated SKILL.md contains `ask src <pkg>` and `ask docs <pkg>` commands
- [ ] Generated AGENTS.md contains version warnings and lazy command references
- [ ] ask.json schema rejects non-string entries

### Observable Outcomes

- Running `ask add npm:zod` completes instantly (< 1s) with no network calls
- Running `ask install` produces AGENTS.md referencing `ask src`/`ask docs`
- SKILL.md files contain shell substitution examples
- `.ask/docs/` directory is NOT created during default install

## Decision Log

- Decision: Encode github ref in spec string (`github:owner/repo@v1.2.3`) instead of separate field
  Rationale: `splitExplicitVersion` already parses this format; eliminates need for discriminated union schema
  Date/Author: 2026-04-12 / Claude

- Decision: Breaking change (major version) rather than migration path
  Rationale: User confirmed no backward compatibility needed; simplifies implementation significantly
  Date/Author: 2026-04-12 / Minsu Lee
