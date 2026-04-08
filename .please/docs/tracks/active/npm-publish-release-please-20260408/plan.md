# Plan: npm Publish & release-please Setup

> Track: npm-publish-release-please-20260408
> Spec: [spec.md](./spec.md)

## Overview
- **Source**: /please:plan
- **Track**: npm-publish-release-please-20260408
- **Created**: 2026-04-08
- **Approach**: Config-only — add release-please config + GitHub Actions workflow + package.json fields

## Purpose

Automate versioning and npm publishing for `@pleaseai/ask` CLI. Eliminates manual `npm publish` steps and ensures every release has SLSA provenance via trusted publishers.

## Context

- Monorepo with `packages/cli` (publishable) and `apps/registry` (private, Cloudflare Pages)
- Conventional Commits already enforced — release-please can parse them directly
- CI exists at `.github/workflows/ci.yml` (test only) — release workflow is separate
- No existing release-please or npm publish configuration

## Architecture Decision

**Chosen**: Separate `release.yml` workflow (not merged into `ci.yml`)
- CI and release have different triggers (`pull_request` vs `push to main`)
- release-please-action needs its own job with `contents: write` + `pull-requests: write`
- npm publish needs `id-token: write` for OIDC provenance
- Keeps concerns cleanly separated

## Tasks

### T-1: Add release-please configuration files
- Create `release-please-config.json` with monorepo setup targeting `packages/cli`
- Create `.release-please-manifest.json` with current version `{"packages/cli": "0.1.0"}`
- Configure: `node` release type, `@pleaseai/ask` package name, conventional commits

### T-2: Update `packages/cli/package.json` for npm publish
- Add `files` field: `["dist"]`
- Add `publishConfig`: `{"access": "public"}`
- Add `repository` field pointing to `pleaseai/ask`

### T-3: Create `.github/workflows/release.yml`
- Job 1 (release-please): runs `google-github-actions/release-please-action@v4` on push to `main`
- Job 2 (npm-publish): conditional on release created, uses `bun pack` → `npm publish --provenance`
- Permissions: `contents: write`, `pull-requests: write`, `id-token: write`
- Environment: `npm` (for trusted publisher OIDC)

### T-4: Add `.npmrc` to `packages/cli/`
- Set `//registry.npmjs.org/:_authToken=${NPM_CONFIG_TOKEN}` (fallback for local publish)
- Or rely on OIDC only — no `.npmrc` needed if only publishing via CI

## Dependencies

T-1 → T-3 (workflow references release-please config)
T-2 → T-3 (workflow builds and publishes the package)
T-4 is independent

## Key Files

| File | Action |
|---|---|
| `release-please-config.json` | Create |
| `.release-please-manifest.json` | Create |
| `packages/cli/package.json` | Modify |
| `.github/workflows/release.yml` | Create |
| `.github/workflows/ci.yml` | Unchanged |

## Verification

- [ ] `release-please-config.json` is valid JSON and references `packages/cli`
- [ ] `.release-please-manifest.json` matches current CLI version
- [ ] `packages/cli/package.json` has `files`, `publishConfig`, `repository`
- [ ] `release.yml` has correct triggers, permissions, and job structure
- [ ] `ci.yml` is untouched

## Progress

| Task | Status |
|---|---|
| T-1 | ⬜ |
| T-2 | ⬜ |
| T-3 | ⬜ |
| T-4 | ⬜ |

## Decision Log

- 2026-04-08: Separate `release.yml` workflow chosen over merging into `ci.yml`
- 2026-04-08: `bun pack` → `npm publish --provenance` for workspace dep resolution + SLSA provenance
- 2026-04-08: npm trusted publisher (OIDC) over long-lived NPM_TOKEN secret

## Surprises & Discoveries

(none yet)
