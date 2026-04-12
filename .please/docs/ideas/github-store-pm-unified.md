---
title: GitHub Store — PM-Unified Layout
status: idea
created: 2026-04-11
author: Minsu Lee
tags: [store, github, correctness, refactor]
related:
  - packages/cli/src/store/index.ts
  - packages/cli/src/store/github-bare.ts
  - packages/cli/src/sources/github.ts
  - packages/cli/src/storage.ts
  - packages/cli/src/install.ts
  - vendor/opensrc/packages/opensrc/cli/src/core/cache.rs
  - vendor/opensrc/packages/opensrc/cli/src/core/git.rs
prior_art:
  - https://github.com/vercel-labs/opensrc
---

# GitHub Store — PM-Unified Layout

## Problem Statement

**How might we** restructure `<ASK_HOME>/github/` so that known correctness
defects — `owner__repo` flattening collisions, `FETCH_HEAD` races across
concurrent installs, `link`/`ref` mode pointing at the repo root instead of
the `docsPath` subdirectory, and missing `verifyEntry()` gating on store-hit
short-circuit — are eliminated at the **layout level**, and so that `github`
storage aligns with how the other source kinds (`npm`, `web`, `llms-txt`) and
general-purpose package managers (cargo, bun, go, pnpm) already work?

## Recommended Direction

Adopt an **opensrc-style flat nested layout**:

```
<ASK_HOME>/github/<host>/<owner>/<repo>/<tag>/
```

Drop the current `db/` + `checkouts/` split entirely. Each `github` entry is
a standalone shallow clone performed with
`git clone --depth 1 --branch <tag> --single-branch <url> <tmpDir>`, with
`.git/` removed after extraction. This matches the prior art in
`vendor/opensrc/packages/opensrc/cli/src/core/cache.rs:83` and aligns `github`
storage shape with what `npm`, `web`, and `llms-txt` already do
(`<kind>/<identity>@<version>/`), so the four source kinds finally follow the
same mental model. Host is a reserved path segment (`github.com` hard-coded
for MVP) so that `gitlab`/`bitbucket` can later land without another migration.

The shared bare-clone subsystem (`packages/cli/src/store/github-bare.ts`) is
deleted. This is counter-intuitive — it gives up object-level deduplication
across tags of the same repo — but it is how every general-purpose package
manager treats versioned artifacts. The payoff is that **five correctness
defects collapse into structural impossibilities**:

- `owner`/`repo` collision cannot happen (nested path, not `__` flattening).
- `FETCH_HEAD` race cannot happen (no shared bare repo; each install is an
  independent shallow clone).
- `ref` containing `/` cannot happen (tags are constrained by validation).
- `db/` garbage collection cannot be stale (no `db/` to GC).
- Two concurrent installs into the same shared bare repo cannot overwrite
  each other's `FETCH_HEAD`.

The remaining two defects — `link` mode path mismatch and missing store-hit
verification — are orthogonal spot fixes that land in the same PR via a new
`FetchResult.storeSubpath` field and a `verifyEntry()` guard on the store-hit
branch in `packages/cli/src/install.ts`.

We pair this with **validation-layer rejection of mutable refs**
(`main`, `master`, `develop`, `HEAD`, `latest`, single-word branch-like
strings). This codifies the convention already implied by the schema
requirement that `ref` be explicit: we turn "explicit" into "explicit AND
tag-like (SHA, `v?<semver>`, or a tag pattern containing a `.` or digit)".
A `--allow-mutable-ref` escape hatch covers CI / test scenarios. This is a
narrow borrow of the "fence & fail loud" philosophy — we do not reject link
mode × github, nor refs with `/`, nor any other input that previous
alternative directions proposed.

## Key Assumptions to Validate

- [ ] **A1 — Shallow clone per tag is an acceptable network cost.**
  *Test*: benchmark `git clone --depth 1 --branch v<X.Y.Z>` against three
  representative libraries (`vercel/next.js`, `colinhacks/zod`, `vuejs/vue`)
  on warm and cold network. Compare to the current bare-clone-then-archive
  path. Acceptable if less than 2× slower in the common case and acceptable
  absolute wall time (< 10s for typical libraries).

- [ ] **A2 — Users rarely install multiple tags of the same repo in one
  project.**
  *Test*: scan existing `apps/registry/content/registry/**/*.md` frontmatter
  and real-world `ask.json` samples. Count instances where the same
  `owner/repo` appears with different `ref` values in the same project.
  Acceptable if the ratio is below ~5% of entries. If significantly higher,
  re-evaluate whether a file-level hardlink/reflink layer is worth adding in
  a follow-up.

- [ ] **A3 — Removing `.git/` after clone does not break downstream
  consumers.**
  *Test*: audit `packages/cli/src/sources/github.ts`
  (`extractDocsFromDir`, `resolveCommit`) and call sites in
  `packages/cli/src/install.ts` and `packages/cli/src/storage.ts` for any
  dependency on `.git/` metadata after the initial clone completes. opensrc
  proves this is safe in practice, but ASK-specific code paths must be
  confirmed. `resolveCommit` uses `git ls-remote` so it does not depend on a
  local `.git/`.

- [ ] **A4 — The mutable-ref validation heuristic produces ≤ 1% false
  positives on real refs.**
  *Test*: apply the heuristic (40-char hex SHA, `v?<semver>`, tag-like with
  ≥ 1 `.` or digit, no whitespace, no `/`) to every `ref` field in committed
  `ask.json` samples and registry entries. Acceptable if ≤ 1 false rejection
  per 100 entries. Escape hatch via `--allow-mutable-ref` must be documented
  in `README.md`.

- [ ] **A5 — Existing `~/.ask/github/db|checkouts/` users can be orphaned
  cleanly.**
  User has already confirmed this is acceptable (the store is early-stage).
  Implementation must still print a one-line warning on first upgraded
  install: *"legacy github store detected at `~/.ask/github/{db,checkouts}`,
  run `ask cache clean --legacy` to reclaim space"*.

## MVP Scope

### In scope — the minimum change that makes this real

1. **Store helpers** (`packages/cli/src/store/index.ts`):
   - Add `githubStorePath(askHome, host, owner, repo, tag)` →
     `<askHome>/github/<host>/<owner>/<repo>/<tag>/`
   - Delete `githubDbPath` and `githubCheckoutPath`.
   - Keep `assertContained()` guard on the new helper.

2. **GitHub source rewrite** (`packages/cli/src/sources/github.ts`):
   - Shallow clone directly into a per-install temp directory via
     `execFileSync('git', ['clone', '--depth', '1', '--branch', <tag>,
     '--single-branch', <url>, <tmpDir>])`.
   - Fallback chain: try `<tag>` as-is; if it already starts with `v`, do
     not prefix; otherwise try `v<tag>`. (See Q2 below.)
   - After successful clone, `fs.rmSync(path.join(tmpDir, '.git'),
     { recursive: true, force: true })`.
   - Materialize via `cpDirAtomic(tmpDir, storeDir)` under
     `acquireEntryLock(storeDir)`, then `stampEntry(storeDir)`.
   - Return `FetchResult` with new `storeSubpath: docsPath` field pointing
     at the docs directory within the cloned tree.
   - Keep the `fetchFromTarGz` path as-is for git-less environments, but
     update it to write to the new layout.

3. **Delete** `packages/cli/src/store/github-bare.ts` and its test file.

4. **Schema** (`packages/cli/src/sources/index.ts`):
   - Add `storeSubpath?: string` to `FetchResult`.

5. **Storage / materialization** (`packages/cli/src/storage.ts`):
   - In link mode (`storage.ts:44`), resolve the symlink target as
     `path.join(options.storePath, options.storeSubpath ?? '')`.
   - Same for ref mode path resolution in
     `packages/cli/src/agents.ts:generateAgentsMd`.

6. **Store-hit verification guard** (`packages/cli/src/install.ts`):
   - In the store-hit short-circuit block around `install.ts:274`, wrap
     `fs.existsSync(storeDir)` with an additional `&& verifyEntry(storeDir)`
     check. On verification failure, move the entry to
     `<askHome>/.quarantine/<timestamp>-<uuid>/` and fall through to a fresh
     fetch.
   - Apply the same guard in the github source's internal store-hit branch
     (`sources/github.ts:54`).

7. **Ref validation** (`packages/schema/src/ask-json.ts`):
   - Add a refinement on the `github` entry's `ref` field that accepts
     40-char hex SHA, `v?<semver>` (re-use `semver` lib where possible),
     and tag-like patterns. Reject obvious branches
     (`main`, `master`, `develop`, `trunk`, `HEAD`, `latest`) and any
     single-word string containing neither `.` nor a digit.
   - Emit a descriptive error message suggesting `--allow-mutable-ref`.
   - Add `--allow-mutable-ref` flag to `ask install` and `ask add`; when
     present, bypass the refinement.

8. **Store version bump and legacy detection**:
   - Write `<askHome>/STORE_VERSION` = `"2"` on first install.
   - On install, if `<askHome>/github/db` or `<askHome>/github/checkouts`
     exists, print the one-line legacy warning described in A5.
   - Add `ask cache clean --legacy` subcommand that removes `github/db`,
     `github/checkouts`, and any other legacy paths we identify.

9. **Tests**:
   - Unit: nested path resolution via `githubStorePath`, mutable-ref
     validation matrix (positive and negative cases),
     `storeSubpath` join behavior in both link and ref modes, `verifyEntry`
     quarantine flow.
   - Integration: shallow clone of a small public repo into a temp
     `ASK_HOME`; concurrent install of two different tags of the same repo
     (both must succeed with no collision); store-hit path after simulated
     corruption (content tampering) must quarantine and re-fetch.

### Not in MVP, but reserved for follow-up

- Central `sources.json`-style manifest across kinds.
- Cross-host support (`gitlab.com`, `bitbucket.org`).
- File-level hardlink/reflink dedup layer (only if A2 proves wrong).
- Windows first-class support (current `link` → `copy` fallback is retained).

## Not Doing (and Why)

- **Keeping the bare clone subsystem.** opensrc deliberately skipped it.
  Removing it collapses four of the five defects structurally. Keeping it
  would require continuing to invest in `FETCH_HEAD` race protection,
  `db/` GC, and bare-repo-level locking.

- **Content-addressable SHA keying.** Violates the PM convention shared by
  cargo, bun, go, and pnpm — all of which key on name/version. Would
  introduce schema churn and UX changes that exceed the correctness-only
  scope the user confirmed.

- **Cross-host (gitlab/bitbucket) support.** The new layout reserves the
  `<host>/` segment so it can be added later without another migration,
  but no code path for non-github hosts ships in this change.

- **Central manifest unifying all kinds.** Attractive but orthogonal to
  `github`-specific correctness defects. Belongs in its own track.

- **Dedup optimization across multiple tags of the same repo.** Recoverable
  later via a hardlink/reflink layer if A2 proves wrong. Measure first.

- **In-place migration of legacy `db|checkouts/` layouts.** User confirmed
  early-stage breakage is acceptable. Migration is a one-line warning plus
  `cache clean --legacy`; no data conversion.

- **Rejecting `link` mode × github.** Direction 4 (*Fence & Fail*) proposed
  this; we reject the rejection. The `storeSubpath` fix makes link mode
  work correctly against github entries.

## Open Questions

- **Q1 — Schema vs CLI for ref validation.** Should the mutable-ref
  refinement live in `packages/schema/src/ask-json.ts` as a Zod refinement,
  or in the CLI install-time validator only? Schema placement is cleaner
  and applies to every consumer of the schema package, but couples
  validation to a package that may be consumed beyond the CLI.

- **Q2 — Tag fallback chain ordering.** opensrc's `clone_at_tag`
  (`vendor/opensrc/packages/opensrc/cli/src/core/git.rs:37`) tries
  `v<version>` first, then `<version>`. When the user already writes
  `ref: "v1.2.3"`, this would try `vv1.2.3` and fail before the fallback.
  Conditional: do not prefix `v` if the ref already starts with `v`.

- **Q3 — `ask cache ls` and legacy entries.** Should legacy entries be
  displayed separately, inline under the same view, or hidden behind
  `--legacy`? Discoverability versus clutter.

- **Q4 — Does removing `.git/` foreclose any future enhancement?**
  Possible futures: "show me the commit log of this doc", "diff a doc
  between two tags", "auto-update on new tag". All of these can be rebuilt
  on top of `git ls-remote` + on-demand re-fetch. Should be explicitly
  declared a non-goal.

- **Q5 — Should `ResolvedEntry.commit?: string` land in this change?** It
  is a nominal schema addition (record the SHA that the tag resolved to at
  install time, captured via `git rev-parse HEAD` before `.git/` deletion).
  Zero correctness impact in this change but cheap to add, and unblocks
  future "did upstream retag this?" detection without another schema bump.

## References

- **Prior art**: `vercel-labs/opensrc` at `vendor/opensrc/`. Key files:
  - `packages/opensrc/cli/src/core/cache.rs:83` — `get_repo_path`
    (nested layout)
  - `packages/opensrc/cli/src/core/git.rs:36` — `clone_at_tag` (shallow
    clone + tag fallback)
  - `packages/opensrc/cli/src/core/git.rs:147` — `remove_git_dir` (post-clone
    `.git/` removal)
- **ASK current state**: `packages/cli/src/store/index.ts:49-67` (current
  helpers), `packages/cli/src/store/github-bare.ts` (to be deleted),
  `packages/cli/src/sources/github.ts:51-148` (to be rewritten),
  `packages/cli/src/install.ts:265-298` (store-hit short-circuit),
  `packages/cli/src/storage.ts:28-104` (materialization pipeline).
- **Conversation history**: Direction 6 is a synthesis of Directions 1–5
  explored during the brainstorming session, shaped by two data points
  from the user: (a) "general PM mental model", and (b) "opensrc is
  available as reference". Directions 1 (*Surgical*) and 5 (*Tmp-Checkout*)
  were close but each missed one dimension — D1 kept the `owner__repo`
  flattening, D5 deviated from PM convention by not persisting
  per-version directories. D6 takes the structural fix of opensrc while
  keeping ASK's strengths (`verifyEntry`, per-entry `.lock`,
  `writeEntryAtomic`).
