# Plan: Interactive Add

> Track: interactive-add-20260412
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: interactive-add-20260412
- **Issue**: #71
- **Created**: 2026-04-12
- **Approach**: Pragmatic

## Purpose

After this change, developers will be able to run `ask add` without arguments to interactively discover and add libraries from their project dependencies. They can verify it works by running `ask add` in an npm project and seeing a multi-select prompt of unregistered dependencies.

## Context

Currently `ask add <spec>` requires a positional argument specifying the library. Users must already know the exact spec format (e.g. `npm:next`, `github:owner/repo@ref`). This creates friction for discovery — developers need to manually check which of their project dependencies have ASK registry entries and type each spec individually.

The interactive mode bridges this gap by scanning project dependencies, checking registry availability, and presenting a multi-select prompt. The implementation leverages existing infrastructure: `detectEcosystem()` for project type detection, `fetchRegistryEntry()` for registry lookups, and `consola.prompt()` for terminal interaction.

Non-goals: non-npm ecosystem dependency scanning (npm-first strategy), Registry search/filter UI, version selection UI.

## Architecture Decision

The interactive flow lives in a new `src/interactive.ts` module, keeping `addCmd` in `index.ts` lean. When `addCmd` receives no `spec` argument, it delegates to `runInteractiveAdd()` which orchestrates the full flow: detect ecosystem → scan dependencies → check registry → prompt user → batch add.

`detectEcosystem()` is currently private in `registry.ts` — we export it rather than duplicating the logic. For registry batch-checking, since no batch API exists, we use `Promise.allSettled()` with individual `fetchRegistryEntry()` calls (already has 10s timeout). The consola `prompt()` API (v3.4.2) provides `multiselect` and `text` types natively.

Alternative considered: embedding all logic directly in the `addCmd` handler. Rejected because the interactive flow is substantial (~100 LOC) and deserves its own module for testability.

## Architecture Diagram

```
 ask add (no args)           ask add npm:next
      │                            │
      ▼                            ▼
  isTTY? ── no ─▶ error         existing flow
      │ yes                    (unchanged)
      ▼
 detectEcosystem()
      │
      ▼
 readProjectDeps()  ◄─ package.json deps+devDeps
      │
      ▼
 filter out ask.json entries
      │
      ▼
 checkRegistry()  ◄─ fetchRegistryEntry() x N
      │
      ▼
 consola.prompt({ multiselect })
  ┌─────┼─────┐
  ▼         ▼
 [selected]  [manual text input]
      │         │
      └───┬─────┘
          ▼
   add to ask.json
          ▼
   runInstall({ onlySpecs })
```

## Tasks

- [ ] T001 Export `detectEcosystem()` from registry.ts (file: packages/cli/src/registry.ts)
- [ ] T002 Create `readProjectDeps()` for npm ecosystem (file: packages/cli/src/interactive.ts) (depends on T001)
- [ ] T003 Create `checkRegistryBatch()` to check multiple deps against registry (file: packages/cli/src/interactive.ts) (depends on T002)
- [ ] T004 Implement `runInteractiveAdd()` with consola prompts (file: packages/cli/src/interactive.ts) (depends on T003)
- [ ] T005 Wire interactive mode into addCmd when spec is absent (file: packages/cli/src/index.ts) (depends on T004)
- [ ] T006 [P] Add non-TTY guard and error handling (file: packages/cli/src/interactive.ts)

## Key Files

### Create

- `packages/cli/src/interactive.ts` — interactive add module: `readProjectDeps()`, `checkRegistryBatch()`, `runInteractiveAdd()`

### Modify

- `packages/cli/src/index.ts` — change `addCmd.args.spec.required` to `false`, branch to interactive when no spec
- `packages/cli/src/registry.ts` — export `detectEcosystem()`

### Reuse

- `packages/cli/src/registry.ts:fetchRegistryEntry()` — individual registry lookups
- `packages/cli/src/io.ts:readAskJson()` / `writeAskJson()` — ask.json read/write
- `packages/cli/src/install.ts:runInstall()` — batch install after selection
- `packages/cli/src/spec.ts:parseSpec()` / `normalizeAddSpec()` — spec validation for manual input

## Verification

### Automated Tests

- [ ] `readProjectDeps()` returns dep names from a fixture package.json, excluding already-registered entries
- [ ] `checkRegistryBatch()` separates deps into registered/unregistered groups
- [ ] `runInteractiveAdd()` adds selected specs to ask.json (mock consola.prompt)
- [ ] Non-TTY detection triggers error exit

### Observable Outcomes

- Running `ask add` in an npm project shows a multi-select prompt listing unregistered dependencies
- Selecting libraries and confirming adds them to ask.json and runs install
- Running `ask add npm:next` behaves identically to before

### Manual Testing

- [ ] In a real npm project, run `ask add` and verify dependency recommendations appear
- [ ] Select multiple libraries and confirm they are all installed
- [ ] Enter a manual spec via text input and verify it works
- [ ] Pipe `ask add` to `/dev/null` and verify non-TTY error

### Acceptance Criteria Check

- [ ] AC-1: `ask add` (no args) shows interactive prompt
- [ ] AC-2: `ask add npm:next` (with args) works unchanged
- [ ] AC-3: npm project deps not in ask.json appear as recommendations
- [ ] AC-4: Multi-select + confirm adds to ask.json and runs install
- [ ] AC-5: non-TTY `ask add` (no args) exits with error

## Decision Log

- Decision: New `interactive.ts` module rather than inline in index.ts
  Rationale: ~100 LOC interactive flow deserves own module for testability and separation of concerns
  Date/Author: 2026-04-12 / Claude

- Decision: Use `Promise.allSettled` for parallel registry checks rather than sequential
  Rationale: N individual fetches with 10s timeout each; parallel keeps total time bounded by slowest single call
  Date/Author: 2026-04-12 / Claude
