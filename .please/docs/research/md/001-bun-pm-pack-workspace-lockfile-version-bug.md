---
id: "001"
title: "bun pm pack workspace:* version resolution bug (stale bun.lock)"
url: "https://github.com/oven-sh/bun/issues/20477"
date: 2026-04-13
summary: "bun pm pack reads workspace:* resolved versions from bun.lock instead of the workspace package's actual package.json, causing stale versions to be embedded in packed tarballs after a version bump."
tags: [bun, workspace, lockfile, pack, publish, monorepo, bug]
---

# bun pm pack workspace:* version resolution bug (stale bun.lock)

## Status

**Open bug** — confirmed as of April 2026. No fix shipped.

## Primary Issue

[#20477 — `bun pm pack` replaces workspace packages with bun.lock version, not their package.json one](https://github.com/oven-sh/bun/issues/20477)

Reported against Bun 1.2.16 on Darwin arm64. Exact scenario:

1. Monorepo has package B depending on package A via `"A": "workspace:*"`.
2. A's `package.json` version is bumped (e.g. `0.3.0` → `0.3.1`).
3. `bun install` does NOT update the version entry for A in `bun.lock`.
4. `bun pm pack` in B's directory resolves `workspace:*` to `0.3.0` (the stale lockfile value) instead of `0.3.1` (the current `package.json` value).

The packed tarball therefore publishes the wrong resolved version for the workspace dependency.

## Root Cause Issue

[#18906 — bun.lock workspace versions no longer get updated after bumping workspace package.json version](https://github.com/oven-sh/bun/issues/18906)

Since Bun 1.2.7, `bun install --lockfile-only` only updates workspace version entries in `bun.lock` when a dependency changes, not when the workspace package's own version field is bumped. This upstream staleness is what `bun pm pack` then exposes.

## Related Issue

[#18518 — `bun pm pack` is unable to handle bundled dependencies when using "workspace:*"](https://github.com/oven-sh/bun/issues/18518)

A separate but related failure mode where `bun pm pack` cannot resolve workspace versions for bundled dependencies.

## Known Workarounds

1. **Run `bun update <package-name>`** after bumping a workspace package version — forces the lockfile entry to refresh before packing.
2. **Delete `bun.lock` and re-run `bun install`** before `bun pm pack` — heavy-handed but reliable in CI.
3. **Use `bun publish` directly** instead of `bun pm pack` if the workflow permits.

## Impact on release-please Workflows

release-please bumps `package.json` via a PR commit, but `bun.lock` is not automatically reconciled. Any `bun pm pack` run after the bump but before a dependency-triggering `bun install` will embed the old version. Safest CI mitigation: run plain `bun install` (not `--lockfile-only`) as part of the pack/publish step.
