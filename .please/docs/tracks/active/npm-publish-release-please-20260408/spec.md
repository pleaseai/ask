# npm Publish & release-please Setup

> Track: npm-publish-release-please-20260408

## Overview

Set up automated release management for the `@pleaseai/ask` CLI package using release-please and GitHub Actions. When commits land on `main`, release-please automatically creates/updates a Release PR with changelog and version bump. Merging the Release PR triggers `bun pack` (workspace dependency resolution) → `npm publish --provenance` using npm trusted publishers (OIDC).

## Scope

### In Scope

1. **release-please configuration** — `release-please-config.json` + `.release-please-manifest.json` for monorepo setup (targeting `packages/cli` only)
2. **Release workflow** — `.github/workflows/release.yml` GitHub Actions workflow:
   - Triggered on push to `main`
   - Runs release-please to create/update Release PR
   - On Release PR merge: builds CLI, runs `bun pack` (resolves workspace deps), publishes via `npm publish --provenance`
3. **npm trusted publisher** — Uses GitHub Actions OIDC token for npm authentication (no `NPM_TOKEN` secret needed)
4. **npm publish preparation** — Ensure `package.json` has correct `files`, `publishConfig`, and `repository` fields

### Out of Scope

- Registry app (`apps/registry`) release/deploy — handled separately via Cloudflare Pages
- Changelog customization beyond release-please defaults
- Pre-release/canary version publishing

## Success Criteria

- [ ] SC-1: `release-please-config.json` and `.release-please-manifest.json` are valid and target `packages/cli`
- [ ] SC-2: `.github/workflows/release.yml` triggers on push to `main` and runs release-please-action
- [ ] SC-3: On release PR merge, workflow builds `packages/cli`, runs `bun pack` (resolves workspace deps), and publishes via `npm publish --provenance`
- [ ] SC-4: Workflow uses `id-token: write` permission and npm trusted publisher (OIDC) — no long-lived NPM_TOKEN secret
- [ ] SC-5: `packages/cli/package.json` includes `files`, `publishConfig`, and `repository` fields
- [ ] SC-6: Existing CI workflow (`ci.yml`) is unaffected

## Constraints

- Uses `google-github-actions/release-please-action` (official GitHub Action)
- npm authentication via trusted publisher (GitHub Actions OIDC) — repo admin must configure trusted publisher on npmjs.com for `@pleaseai/ask`
- Publish step: `bun pack` (resolve workspace dependencies into tarball) → `npm publish --provenance` (SLSA provenance attestation)
- Only `packages/cli` is published; root and `apps/registry` remain private
- Conventional Commits format is already enforced (compatible with release-please)
