---
name: setup-docs
description: >
  Bootstrap documentation for an entire project's dependencies in one shot. Reads the
  project's manifest and lockfile, derives the full dependency list with resolved
  versions, asks the user to confirm the targets, then runs the `add-docs` pipeline for
  each one and rebuilds the `AGENTS.md` auto-generated block in a single pass. Use this
  skill when the user is initializing ASK on a project for the first time, has just
  cloned a repo and wants every dependency's docs available, or asks something like
  "ASK 셋업해줘", "이 프로젝트 의존성 문서 다 받아줘", "set up ask for this repo",
  "bootstrap docs for all deps", "initialize agents.md from package.json". Trigger on:
  "셋업", "setup", "bootstrap", "초기화", "initialize", "all dependencies", "전체 의존성",
  combined with any mention of docs, AGENTS.md, or ASK.
---

# setup-docs — Bootstrap Docs for Every Dependency

One-shot project initialization. Use this when the user wants documentation for **every**
dependency, not just one specific library.

For a single library, use `add-docs` instead.
For refreshing already-tracked libraries after upgrades, use `sync-docs`.

## When to use this skill

- New ASK adoption: the user just installed ASK and has nothing in `.ask/docs/` yet.
- Fresh clone: the user wants to populate `AGENTS.md` from scratch based on the project's
  dependencies.
- Major reorganization: the user explicitly wants to rebuild the full doc set.

## Design principle — narrow by default, expand on request

Fetching docs for **every** dependency sounds complete, but in practice it
pollutes `AGENTS.md` with toolchain packages (ESLint plugins, build tools,
type-only shims) that an AI agent will never reference when writing
application code. It also balloons wall-clock time and failure rate, since
those packages rarely have docs in the places the registry/sources look.

This skill therefore defaults to a **focused set**:

1. **Runtime `dependencies` only** — skip `devDependencies` and `peerDependencies`
   unless the user asks for them.
2. **Deny-list filter** — even inside `dependencies`, drop packages that match
   the patterns in [`references/deny-list.md`](./references/deny-list.md)
   (linters, bundlers, test runners, git hooks, polyfills, etc.).
3. **User override is always one step away** — the confirmation prompt shows
   what was excluded so the user can flip the decision with `include-dev`,
   `include <name>`, or `all`.

The rationale is: optimize for the signal-to-noise ratio of `AGENTS.md`, not
for exhaustiveness. A curated list of 8 libraries the AI will actually use
is more valuable than an exhaustive list of 60 where 50 are build plumbing.

## Pipeline

```
parse manifest + lockfile → derive (name, version) list
  → apply default scope (dependencies only) + deny-list filter
  → confirm with user (show included / deny-filtered / devDeps buckets)
  → for each confirmed: run add-docs steps 1–6.5 (writes resolved.json per entry)
  → final pass: rebuild AGENTS.md block once → ensure CLAUDE.md @AGENTS.md
```

The key difference from running `add-docs` in a loop: **Step 7 (AGENTS.md regeneration)
runs only once at the very end** so the file isn't rewritten N times.

## Step 1 — Parse the manifest and lockfile

Detect the ecosystem the same way `add-docs` Step 2 does, then parse the relevant files.
Always prefer the **lockfile** for the resolved version; fall back to the manifest's
declared range only when no lockfile exists.

| Ecosystem | Manifest (default scope: direct runtime deps the project itself declares) | Lockfile (preferred for version) |
|---|---|---|
| npm | `package.json` → `dependencies` only | `bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` |
| pypi | `pyproject.toml` `[project.dependencies]` / `[tool.poetry.dependencies]`, or `requirements.txt` (skip `-dev` / `-test` files) | `poetry.lock`, `uv.lock`, pinned `requirements.txt` |
| go | `go.mod` `require` block, direct deps only (skip entries marked `// indirect`) | `go.sum` (versions are already in `go.mod`) |
| crates | `Cargo.toml` `[dependencies]` (skip `[dev-dependencies]` / `[build-dependencies]`) | `Cargo.lock` |
| pub | `pubspec.yaml` `dependencies` (skip `dev_dependencies`) | `pubspec.lock` |
| hex | `mix.exs` `deps/0` where `:only` is not `:dev` or `:test` | `mix.lock` |
| maven | `pom.xml` `dependencies` with `scope != test` / `provided`, or `build.gradle(.kts)` `implementation`/`api` (not `testImplementation`) | Maven resolves at build time; no separate lockfile |

For each dependency, produce a `(ecosystem, name, version)` triple. If the lockfile gives
a precise version (e.g. `3.22.4`), use that. If only a range is available (e.g. `^3.22`),
pass the range to `add-docs` and let the source resolve it.

**Always skip**, regardless of user override: workspace-internal packages,
`link:`/`file:`/`workspace:` deps, and anything that resolves to a path.
These don't have docs to download.

**Default-skip (user can override)**: dev/test/build scopes in the table
above **and** npm `peerDependencies` (which are expected to be provided
by the host project, not owned by it). If the user asks for `include-dev`,
re-read the manifest and merge both the dev/test/build scopes **and**
`peerDependencies` into the candidate list before the deny-list filter
runs. Track dev/test/build and peer scopes as separate buckets so Step 2
can list them independently in the confirmation output.

## Step 1.5 — Apply the deny-list

Read [`references/deny-list.md`](./references/deny-list.md) and drop any
candidate whose package name matches a glob pattern listed there. Keep the
dropped entries in a separate bucket so Step 2 can show them to the user.

Matching rules:

- Glob-style (`*` = any chars, `?` = one char), case-sensitive.
- Applied to the package name only (no version, no ecosystem prefix).
- Works across ecosystems — patterns that only make sense for npm
  (`@types/*`) simply won't match non-npm names.

If the user says `all`, skip this step entirely.
If the user says `include <name>` (or a comma-separated list), move each
name out of whichever **soft-skip** bucket it currently lives in — the
deny-list bucket, the devDependencies bucket, or the peerDependencies
bucket — and put it back into the keep bucket before Step 2.
`include <name>` is the single-package escape hatch for *soft* skips only;
it does **not** override the always-skip rules in Step 1 (workspace /
`link:` / `file:` / path deps). Those have no downloadable docs, so
forcing them in would just produce errors.

## Step 2 — Show the plan and confirm

Print the derived buckets so the user can see exactly what's in and
what's out. Show every soft-skip bucket that has at least one entry —
deny-list, devDependencies, and peerDependencies each get their own
line so nothing is silently dropped:

```
ASK setup plan for <project> (default scope: direct runtime dependencies)

Will fetch (8):
  npm:
    - zod@3.22.4
    - hono@4.6.2
    - drizzle-orm@0.36.0
    - @mastra/core@0.5.2
    ...

Skipped by deny-list (4):
  eslint, prettier, typescript, @types/node

Skipped devDependencies (23):
  husky, lint-staged, turbo, vitest, tsup, ...

Skipped peerDependencies (2):
  react, react-dom

Proceed? Options:
  - yes              fetch the 8 packages above
  - include-dev      also fetch devDependencies AND peerDependencies
                     (both still subject to deny-list)
  - include <names>  force-include specific packages from any soft-skip
                     bucket (comma-separated)
  - all              disable deny-list AND include dev + peer deps
  - select           pick a subset interactively
  - cancel
```

Omit any bucket whose count is zero — e.g. a Go project won't have a
`peerDependencies` bucket at all. Always-skip entries from Step 1
(workspace / path deps) are never shown as a bucket because they are
not recoverable through any user override.

**Stop and wait** for the user's answer. Never start fetching silently —
mass downloads against upstream registries deserve an explicit checkpoint.

If the user says `include-dev` or `all`, recompute the buckets and
re-display before proceeding. If they say `include foo,bar`, move those
names from whichever soft-skip bucket they live in (deny-list,
devDependencies, or peerDependencies) back into the keep bucket and
confirm once more with the updated plan.

If the final keep-bucket is still large (>30 entries after overrides),
warn about wall-clock time before starting.

## Step 3 — Run `add-docs` Steps 1–6.5 for each entry

For each `(ecosystem, name, version)`:

1. Follow `add-docs` Steps 1–6.5 exactly (parse, registry lookup, fallback, fetch, save,
   upsert into `.ask/resolved.json`).
2. **Skip Step 7** for now — the AGENTS.md regeneration is deferred.
3. On failure, **do not abort the whole batch**. Record the error and continue. Examples
   of survivable failures: registry miss + no fallback, source returned zero files,
   network timeout.
4. Track results in two buckets: `succeeded[]` and `failed[{name, reason}]`.

You may run fetches in parallel (up to ~4 at a time) when the source allows it
(`github` and `npm` archive downloads parallelize cleanly; `web` crawls should stay
serial to be polite to upstream servers).

## Step 4 — Regenerate AGENTS.md once

After the loop, run `add-docs` Step 7 a single time. Because Step 6 already populated
`ask.json` + `.ask/resolved.json` with every successful entry, the regenerated marker block will
list them all in one shot. Then run Step 8 to ensure `CLAUDE.md` references `AGENTS.md`.

## Step 5 — Report

Print a summary:

```
Fetched docs for 12 of 14 dependencies.

✓ Succeeded: zod, hono, drizzle-orm, ...
✗ Failed:
  - some-private-pkg: registry miss, no GitHub repo in npm metadata
  - obscure-lib: no docs/ directory found in tarball

To retry a failure manually, run add-docs with explicit --source.
```

The failures are recoverable with manual hints, so keep the message actionable.

## Guardrails

- **Always confirm before fetching.** Mass downloads against many upstream servers
  deserve a human checkpoint.
- **Partial success is fine.** Don't roll back successful fetches because one failed.
- **Idempotency.** Re-running `setup-docs` on a project that already has entries should
  replace them in place (Step 6 already does this) — not duplicate.
- All `add-docs` guardrails apply transitively: read before write, never invent versions
  or repos, marker block is sacred.
