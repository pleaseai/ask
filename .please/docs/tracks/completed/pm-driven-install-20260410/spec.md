---
product_spec_domain: cli/install-flow
---

# PM-driven install flow with `ask.json`

> Track: pm-driven-install-20260410

## Overview

Introduce a new install flow where the project's package manager lockfile is the single source of truth for dependency versions, and a new root-level `ask.json` declares which libraries the project wants documentation for. A new `ask install` command resolves each entry against the relevant lockfile (or against an explicit ref for standalone github entries) and synchronizes `.ask/docs/`.

This structurally eliminates a class of drift bugs where ASK lockfile and the real PM lockfile disagree, repositions ASK as a downstream tool of the project's package manager (the same relationship TypeScript and Prisma have to npm), and makes `ask install` trivially integratable as a `postinstall` hook.

First phase covers npm and github ecosystems. Other ecosystems (pypi, pub, cargo, go) are explicitly out of scope and will be added in follow-up tracks.

## Requirements

### Functional Requirements

- [ ] FR-1: A root-level `ask.json` file declares an ordered list of library entries under `libraries`. Two entry shapes are supported: (A) PM-driven entries identified by ecosystem-prefixed spec like `npm:next` whose version is resolved from the project's lockfile, and (B) standalone entries like `github:vercel/next.js` carrying an explicit `ref` field whose version is fixed locally and never read from any lockfile.
- [ ] FR-2: A new `ask install` command reads `ask.json`, resolves the version of every entry, fetches docs via existing source adapters, and writes `.ask/docs/<name>@<version>/`, `AGENTS.md` block, and `.claude/skills/<name>-docs/SKILL.md`.
- [ ] FR-3: For PM-driven npm entries, `ask install` reads the project's lockfile in priority order: `bun.lock` -> `package-lock.json` -> `pnpm-lock.yaml` -> `yarn.lock` (classic). The first lockfile found supplies the resolved version. The npm source continues to use its existing local-first behavior, reading from `node_modules/<pkg>` when the installed version satisfies the lockfile entry.
- [ ] FR-4: For standalone github entries, `ask install` uses the entry's `ref` field directly and continues to use the existing tarball-based github source adapter. (Replacing tarball with git+sparse is deferred to a follow-up track and explicitly out of scope here.)
- [x] FR-5: A new `ask add <spec>` command appends a new entry to `ask.json` and triggers `ask install` for that entry. For ecosystem-prefixed specs (`npm:next`) it creates a PM-driven entry; for github specs (`github:owner/repo` or `owner/repo`) it creates a standalone entry and **requires** an explicit `--ref` value (no default — silently picking `main` was rejected during implementation because users could not reliably tell which version they ended up pinned to).
- [ ] FR-6: A new `ask remove <name>` command removes the matching entry from `ask.json`, deletes its materialized files under `.ask/docs/<name>@*/`, removes its skill file under `.claude/skills/<name>-docs/`, and updates the `AGENTS.md` auto-generated block.
- [ ] FR-7: A new `ask list` command displays current `ask.json` entries together with their currently resolved versions (from lockfile for PM-driven, from `ref` for standalone) and materialization status. The existing rich `ask list` (introduced by `rich-list-command-20260409`) is the surface to evolve; the deprecated `ask docs list` wrapper is removed.
- [ ] FR-8: When `ask install` is run in a project with no `ask.json` file, ASK creates an empty `ask.json` (`{"libraries": []}`) automatically and prints guidance suggesting `ask add` as the next step. The command exits 0.
- [ ] FR-9: When a PM-driven entry references a package that is not present in any lockfile, `ask install` emits a warning naming the entry, skips it, and continues with remaining entries.
- [ ] FR-10: When fetching, parsing, or writing for an individual entry fails (network error, registry miss, source adapter failure), `ask install` emits a warning naming the entry and the cause, skips it, and continues with remaining entries. Successful entries are persisted normally. Exit code is 0 even when some entries failed (postinstall-hook friendly).
- [ ] FR-11: A `.ask/resolved.json` file (gitignored, ephemeral) caches the most recent successful resolution per entry, including resolved version and a content hash, to support fast incremental re-runs of `ask install`. The file is rebuilt from scratch any time it is missing or invalid.
- [ ] FR-12: The existing `ask docs add | sync | list | remove` subcommand layer is removed entirely (including the deprecated `ask docs list` wrapper). The flat command surface (`install`, `add`, `remove`, `list`) replaces it. The `ask sync` alias is not provided.
- [ ] FR-13: The legacy files `.ask/config.json` and `.ask/ask.lock` are removed from the codebase, sample fixtures, and any internal references. The project is in development with no users to migrate, so deletion is unconditional. Code paths that currently read `ask.lock` (e.g. `listDocs` in `packages/cli/src/storage.ts`) are rewritten to read `ask.json` + `.ask/resolved.json`.
- [ ] FR-14: `ask.json` is parsed and validated via Zod (consistent with existing `packages/registry-schema`). Invalid `ask.json` causes `ask install` to fail with a clear schema error pointing at the offending field.

### Non-functional Requirements

- [ ] NFR-1: `ask install` on a project where every entry is already up to date (according to `.ask/resolved.json`) completes without re-fetching any source.
- [ ] NFR-2: Output uses `consola` for all user-facing messages, consistent with existing CLI conventions. No raw `console.log`.
- [ ] NFR-3: All new commands work in projects of any ecosystem (the only first-phase restriction is which entry types resolve successfully), so a Python or Dart project that only uses standalone github entries is fully supported.
- [ ] NFR-4: `ask.json` schema is designed to forward-extend cleanly: adding pypi/pub/cargo/go entry types in follow-up tracks must not require breaking the v1 shape.

## Acceptance Criteria

- [ ] AC-1: A new ASK user can run `ask add npm:next`, then `ask install`, and end up with `.ask/docs/next@<version-from-bun.lock>/`, an updated `AGENTS.md` block, and a SKILL.md file, with no manual editing of any config.
- [ ] AC-2: A user can declare a standalone github entry like `{ "spec": "github:vercel/next.js", "ref": "v14.2.3", "docsPath": "docs" }` in `ask.json`, run `ask install`, and end up with `.ask/docs/next.js@v14.2.3/` populated from the repo's `docs/` directory (which is NOT shipped in the npm tarball).
- [ ] AC-3: After `bun add react@19.0.1`, a subsequent `ask install` (with no other changes) produces docs at `.ask/docs/react@19.0.1/` even though the user did not touch `ask.json`. The version in the lockfile drives the docs version.
- [ ] AC-4: With one PM-driven entry pointing at a removed dependency and one healthy entry, `ask install` warns about the removed one, installs the healthy one, and exits 0.
- [ ] AC-5: With one entry whose source fetch errors out, `ask install` warns about it, processes other entries normally, and exits 0.
- [ ] AC-6: Running `ask install` in a fresh project with no `ask.json` creates an empty `ask.json`, prints next-step guidance, and exits 0.
- [ ] AC-7: `ask remove next` removes the entry from `ask.json`, deletes the matching docs/skill files, and updates `AGENTS.md`. Re-running `ask list` no longer shows the entry.
- [ ] AC-8: Adding a `package.json` script `"postinstall": "ask install"` and running `bun install` results in `.ask/docs/` being kept in sync with the resolved dependency tree on every install.
- [ ] AC-9: Running `ask install` twice in a row with no changes does not refetch any source (`.ask/resolved.json` short-circuit works).
- [ ] AC-10: A repository search for `.ask/config.json`, `.ask/ask.lock`, or `ask docs add` returns no matches in source code, tests, fixtures, README, or docs.

## Out of Scope

- pypi, pub, cargo, go, hex, nuget, maven lockfile readers (each follow-up track per ecosystem)
- git+sparse-checkout based github fetcher (separate follow-up track `github-source-git-sparse-20260410`)
- Global `~/.ask/store/v1/` cache layout (introduced together with git+sparse)
- Bare-clone reuse, isomorphic-git fallback, store GC, store linking modes (symlink/hardlink)
- Migration of any existing `.ask/config.json` or `.ask/ask.lock` files (project is in development; deletion is unconditional)
- Renaming, repurposing, or aliasing the removed `ask docs *` subcommand surface
- Concurrency control between parallel `ask install` invocations (single user assumed)
- A separate `ask init` command (folded into `ask install`'s bootstrap behavior per FR-8)

## Assumptions

- `apps/registry`'s existing per-library config (source priority, docsPath, aliases) remains the authoritative way to translate an `npm:<name>` entry into a fetch plan; this track does not change registry semantics.
- The existing source adapters (`packages/cli/src/sources/npm.ts`, `github.ts`, `web.ts`) remain unchanged in this track; only the orchestration layer above them is rewritten.
- The existing `manifest/` lockfile-reading utilities (currently used by `ask docs add` for version inference) can be generalized into a `lockfiles/` reader layer that the new `install` orchestrator consumes.
- `ask install` runs in the project root by default; CWD discovery walks upward to find `ask.json`, matching how `bun install` finds `package.json`.
- The `name` used for `.ask/docs/<name>@<version>/` and `.claude/skills/<name>-docs/` is derived from the spec: `npm:next` -> `next`, `github:vercel/next.js` -> `next.js`. Existing naming logic is preserved.
- Intent-format packages (the `intent-skills` AGENTS.md block managed by `agents-intent.ts`) continue to work; their orchestration is reattached to the new `ask install` loop in place of the removed `ask docs sync` second-pass logic.
