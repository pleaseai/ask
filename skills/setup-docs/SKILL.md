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

## Pipeline

```
parse manifest + lockfile → derive (name, version) list → confirm with user
  → for each: run add-docs steps 1–6.5 (writes config + ask.lock per entry)
  → final pass: rebuild AGENTS.md block once → ensure CLAUDE.md @AGENTS.md
```

The key difference from running `add-docs` in a loop: **Step 7 (AGENTS.md regeneration)
runs only once at the very end** so the file isn't rewritten N times.

## Step 1 — Parse the manifest and lockfile

Detect the ecosystem the same way `add-docs` Step 2 does, then parse the relevant files.
Always prefer the **lockfile** for the resolved version; fall back to the manifest's
declared range only when no lockfile exists.

| Ecosystem | Manifest | Lockfile (preferred for version) |
|---|---|---|
| npm | `package.json` (`dependencies` + `devDependencies` + `peerDependencies`) | `bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` |
| pypi | `pyproject.toml` (`[project.dependencies]` or `[tool.poetry.dependencies]`) or `requirements.txt` | `poetry.lock`, `uv.lock`, pinned `requirements.txt` |
| go | `go.mod` (`require` block) | `go.sum` (versions are already in `go.mod`) |
| crates | `Cargo.toml` (`[dependencies]`) | `Cargo.lock` |
| pub | `pubspec.yaml` (`dependencies`) | `pubspec.lock` |
| hex | `mix.exs` (`deps/0`) | `mix.lock` |
| maven | `pom.xml` or `build.gradle` / `build.gradle.kts` (`dependencies` block) | Maven resolves at build time; no separate lockfile |

For each dependency, produce a `(ecosystem, name, version)` triple. If the lockfile gives
a precise version (e.g. `3.22.4`), use that. If only a range is available (e.g. `^3.22`),
pass the range to `add-docs` and let the source resolve it.

**Skip**: workspace-internal packages, `link:`/`file:`/`workspace:` deps, and anything
that resolves to a path. These don't have docs to download.

## Step 2 — Show the plan and confirm

Print the derived list to the user as a table or bullet list, grouped by ecosystem if
mixed. Then **stop and ask for confirmation** before fetching anything. Example:

```
About to fetch docs for 14 dependencies:

npm:
  - zod@3.22.4
  - hono@4.6.2
  - drizzle-orm@0.36.0
  ...

Proceed? (yes / select subset / cancel)
```

If the list is large (>30 entries), warn the user about wall-clock time and offer to
filter (e.g. only `dependencies`, skip `devDependencies`).

## Step 3 — Run `add-docs` Steps 1–6.5 for each entry

For each `(ecosystem, name, version)`:

1. Follow `add-docs` Steps 1–6.5 exactly (parse, registry lookup, fallback, fetch, save,
   update `.ask/config.json`, record into `.ask/ask.lock`).
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
`.ask/config.json` with every successful entry, the regenerated marker block will
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
