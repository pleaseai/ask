---
name: sync-docs
description: >
  Detect drift between the project's installed dependency versions and the docs already
  saved under `.ask/docs/`, then re-fetch only what changed. Reads `ask.json`,
  compares each tracked entry to the current resolved version in the project's lockfile,
  and runs the `add-docs` pipeline for any version that moved. Also prunes entries for
  dependencies that were removed and reports any new dependencies that have no docs yet.
  MUST use this skill whenever the user mentions upgrading dependencies, after running
  `bun add` / `npm install` / `pnpm up` / `cargo update` / etc., when the lockfile
  changed, or when the user asks "의존성 업데이트했어 문서도 갱신해줘", "sync docs",
  "refresh docs after upgrade", "버전 올렸어", "lockfile 바뀌었어", "ASK 동기화".
  Trigger on: "sync", "동기화", "drift", "refresh docs", "after upgrade", "업그레이드 후",
  "버전 변경", "lockfile changed", combined with any mention of docs or ASK.
---

# sync-docs — Detect Drift and Re-fetch Changed Docs

Keeps `.ask/docs/` and `AGENTS.md` aligned with the project's actual installed
dependency versions. Run this whenever the lockfile moves.

For first-time setup, use `setup-docs`.
For adding a brand-new library that isn't tracked yet, use `add-docs`.

## When to use this skill

- The user just ran `bun add`, `bun update`, `npm install`, `pnpm up`, `cargo update`,
  `go get -u`, etc.
- The user explicitly asks to refresh, sync, or check drift.
- A code review notices `AGENTS.md` references stale versions.
- Periodic maintenance ("clean up old docs").

## Pipeline

```
read ask.json + .ask/resolved.json → parse current manifest/lockfile → classify each entry
  → for each "changed": run add-docs steps 1–6.5 (and delete the old version dir)
  → for each "removed": prune dir + remove from ask.json + clear from resolved.json (with confirmation)
  → for each "new in manifest, missing from ask.json": report only, recommend setup-docs
  → final pass: rebuild AGENTS.md block once → ensure CLAUDE.md @AGENTS.md
  → summarize
```

## Step 1 — Load tracked entries

Read `ask.json`. If it doesn't exist or has an empty `libraries[]`, tell the user
there's nothing to sync and recommend `setup-docs`. Stop.

## Step 2 — Read current installed versions

Parse the manifest and lockfile exactly like `setup-docs` Step 1. Build a map of
`name → currentResolvedVersion` for the ecosystem the project uses. Prefer the lockfile.

## Step 3 — Classify every tracked entry

For each entry in `ask.json`'s `libraries[]`, compute one of these states:

| State | Condition | Action |
|---|---|---|
| **unchanged** | Tracked version === current version | Skip |
| **drifted** | Tracked version ≠ current version, name still in manifest | Re-fetch |
| **removed** | Name no longer in manifest at all | Prune (with confirmation) |
| **untracked** | Name **is** in manifest but **not** in `ask.json` | Report only |

**Comparison source**: prefer `.ask/resolved.json` `entries.<name>.resolvedVersion` (and
content hash) over the declared spec. The resolved cache records what was *actually*
fetched last time. If the cache has no entry for a tracked name, treat it as **drifted**
(forces a re-fetch to populate the cache).

For github entries, also compare `lock.commit` against the current head of the same
ref. If the version string is unchanged but the commit moved (common when tracking
`main`), that still counts as drift.

Group the results by state and **show the user the plan before doing anything destructive**:

```
Drift detected:
  ⟳  zod          3.22.4 → 3.23.8     (will re-fetch)
  ⟳  hono         4.6.2  → 4.6.5      (will re-fetch)

Removed from project (will prune docs after confirmation):
  ✗  old-lib      1.0.0

New dependencies without docs (run `setup-docs` or `add-docs` to fetch):
  +  brand-new-pkg @ 0.4.1

Unchanged (skipping): 11 entries

Proceed with re-fetch and prune?
```

## Step 4 — Re-fetch drifted entries

For each `drifted` entry:

1. Run `add-docs` Steps 1–6 with the new version. The pipeline will overwrite the
   `.ask/resolved.json` entry in place (Step 6 already replaces by name).
2. **After** the new version is on disk, delete the **old** directory:
   `rm -rf .ask/docs/<name>@<oldVersion>/`. Do this only after the new fetch
   succeeds so a failed fetch can't leave the project with no docs at all.
3. On failure, leave the old directory intact, record the error, and continue.

Parallelism rules from `setup-docs` Step 3 apply: github/npm in parallel (≤4), web serial.

## Step 5 — Prune removed entries

For each `removed` entry, after the user has confirmed:

1. Delete `.ask/docs/<name>@<version>/` recursively.
2. Remove the entry from `ask.json`'s `libraries[]` and clear it from `.ask/resolved.json`.

If the user declined to prune, skip — do not silently keep stale data and do not
silently delete it either.

## Step 6 — Report untracked dependencies

For each `untracked` entry, **just list it**. Do not auto-fetch — the user might have
a reason that dependency isn't tracked (e.g. it's a build tool with no useful docs).
Recommend `add-docs <name>` or `setup-docs` if they want full coverage.

## Step 7 — Rebuild AGENTS.md and CLAUDE.md

Run `add-docs` Step 7 once at the end so the marker block reflects the post-sync state
of `ask.json`. Then `add-docs` Step 8 to ensure the `@AGENTS.md` reference.

If the sync resulted in **zero changes** to `ask.json`, you can still re-run
Step 7 — it'll be a no-op rewrite — or skip it. Skipping is fine and avoids touching
the file's mtime.

## Step 8 — Summarize

Print exactly what changed:

```
Synced 13 tracked entries.

Re-fetched (2):
  ⟳ zod  3.22.4 → 3.23.8
  ⟳ hono 4.6.2  → 4.6.5

Pruned (1):
  ✗ old-lib 1.0.0

Untracked dependencies (3) — run add-docs to fetch:
  + brand-new-pkg, another-new-thing, yet-another

AGENTS.md updated.
```

## Guardrails

- **Never delete the old version directory before the new fetch succeeds.** Order
  matters — prefer brief disk waste over a window with no docs.
- **Confirm before pruning.** Removed-from-manifest is a strong signal but not
  irreversible from the user's perspective; ask first.
- **Don't auto-fetch untracked deps.** That's `setup-docs` / `add-docs`'s job and
  the user should opt in.
- All `add-docs` guardrails apply transitively.

## Future automation note

When ASK ships as a Claude Code plugin, this skill is the natural target for a
`PostToolUse` hook on lockfile edits — the hook can invoke `sync-docs` automatically
after `bun.lock` / `package-lock.json` / etc. change. That's outside the scope of this
skill itself; it just needs to be runnable on demand.
