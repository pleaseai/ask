# GitHub Store — PM-Unified Layout

> Track: github-store-pm-unified-20260411
> Type: refactor

## Overview

Restructure `<ASK_HOME>/github/` to an opensrc-style flat nested layout so that five known correctness defects in the current `db/` + `checkouts/` split become structurally impossible. Align `github` storage with the PM mental model (`<kind>/<identity>@<version>/`) already used by `npm`, `web`, and `llms-txt` sources.

Background and full rationale: `.please/docs/ideas/github-store-pm-unified.md` (Direction 6 synthesis).

**Target layout:**

    <ASK_HOME>/github/<host>/<owner>/<repo>/<tag>/

With `github.com` hard-coded as the host for MVP (reserved path segment for later `gitlab`/`bitbucket` expansion).

## Defects Eliminated (Structural)

1. `owner__repo` flattening collisions (nested path replaces `__` delimiter).
2. `FETCH_HEAD` races across concurrent installs (no shared bare repo).
3. `ref` containing `/` breakage (validated out at schema layer).
4. `db/` garbage collection staleness (no `db/` to GC).
5. Concurrent installs overwriting each other's `FETCH_HEAD` state.

## Defects Fixed (Spot)

6. `link`/`ref` mode pointing at repo root instead of `docsPath` subdirectory — fixed via new `FetchResult.storeSubpath` field.
7. Missing `verifyEntry()` gating on store-hit short-circuit — fixed via explicit guard in `install.ts` and `sources/github.ts` store-hit branches.

## Scope

### In scope

- **Store helpers** (`packages/cli/src/store/index.ts`):
  - Add `githubStorePath(askHome, host, owner, repo, tag)` → `<askHome>/github/<host>/<owner>/<repo>/<tag>/`.
  - Keep `assertContained()` guard.
  - Delete `githubDbPath` and `githubCheckoutPath`.

- **GitHub source rewrite** (`packages/cli/src/sources/github.ts`):
  - Shallow clone via `git clone --depth 1 --branch <tag> --single-branch <url> <tmpDir>`.
  - Tag fallback chain: try `<tag>` as-is first; if it does NOT already start with `v`, additionally try `v<tag>`. Never emit `vv1.2.3` (Q2 resolution).
  - Remove `.git/` after successful clone (`fs.rmSync` recursive).
  - Before `.git/` removal, capture commit SHA via `git rev-parse HEAD` for `ResolvedEntry.commit` (Q5 resolution).
  - Materialize via `cpDirAtomic(tmpDir, storeDir)` under `acquireEntryLock(storeDir)`, then `stampEntry(storeDir)`.
  - Return `FetchResult` with new `storeSubpath: docsPath` field.
  - Keep `fetchFromTarGz` path for git-less environments, updated to new layout.

- **Delete** `packages/cli/src/store/github-bare.ts` and its test file.

- **Schema changes** (`packages/schema/`):
  - Add `storeSubpath?: string` to `FetchResult` (`packages/cli/src/sources/index.ts`).
  - Add `commit?: string` to `ResolvedEntry` (`packages/schema/src/resolved.ts`).
  - Add mutable-ref refinement to the `github` entry `ref` field (`packages/schema/src/ask-json.ts`): accept 40-char hex SHA, `v?<semver>`, or tag-like strings containing `.` or a digit; reject `main`/`master`/`develop`/`trunk`/`HEAD`/`latest` and single-word strings without `.` or digits. Expose a schema factory or variant so callers can bypass the refinement (CLI escape hatch).

- **Storage / materialization** (`packages/cli/src/storage.ts`):
  - Link mode: resolve symlink target as `path.join(options.storePath, options.storeSubpath ?? '')`.
  - Ref mode: same join for path resolution.
  - Apply same join in `packages/cli/src/agents.ts:generateAgentsMd`.

- **Store-hit verification guard** (`packages/cli/src/install.ts`):
  - Around `install.ts:274`, wrap `fs.existsSync(storeDir)` with `&& verifyEntry(storeDir)`.
  - Apply the same guard in `sources/github.ts:54` internal store-hit branch.
  - On verification failure: quarantine entry to `<askHome>/.quarantine/<timestamp>-<uuid>/` and fall through to fresh fetch.

- **CLI escape hatch**:
  - Add `--allow-mutable-ref` flag to `ask install` and `ask add`.
  - When set, CLI selects the lax schema variant to bypass the ref refinement.

- **Store version bump + legacy detection**:
  - Write `<askHome>/STORE_VERSION` = `"2"` on first install.
  - On install, if `<askHome>/github/db` or `<askHome>/github/checkouts` exists, print one-line legacy warning.
  - Add `ask cache clean --legacy` subcommand to remove `github/db`, `github/checkouts`, and any other legacy paths.

- **Tests**:
  - Unit: nested path resolution via `githubStorePath`; mutable-ref validation matrix (positive and negative cases); `storeSubpath` join behavior in both link and ref modes; `verifyEntry` quarantine flow; tag fallback ordering (including `v`-prefix short-circuit).
  - Integration: shallow clone of a small public repo into a temp `ASK_HOME`; concurrent install of two different tags of the same repo (both succeed, no collision); store-hit path after simulated corruption (content tampering) quarantines and re-fetches.

### Out of scope

- Keeping the bare clone subsystem (deliberately removed; opensrc parity).
- Content-addressable SHA keying (violates PM convention; exceeds correctness scope).
- Cross-host support (gitlab.com, bitbucket.org) — path segment reserved, no code paths shipped.
- File-level hardlink/reflink dedup across tags of the same repo — revisited only if A2 proves wrong in follow-up.
- Central `sources.json`-style manifest unifying all kinds — separate track.
- In-place migration of legacy `db|checkouts/` layouts (one-line warning + `cache clean --legacy` is the entire migration story; user confirmed early-stage breakage is acceptable).
- Rejecting `link` mode × github (the `storeSubpath` fix makes link mode work).
- A1 network-cost benchmark (deferred to follow-up, per clarification).
- `apps/registry` removal (separate track, per clarification).

## Success Criteria

- [ ] **SC-1 — Layout**: Every `github`-kind entry materializes under `<askHome>/github/github.com/<owner>/<repo>/<tag>/`. No `github/db/` or `github/checkouts/` directories are created for new installs.
- [ ] **SC-2 — Concurrent safety**: Two simultaneous installs of different tags of the same repo both succeed; neither corrupts the other. Integration test asserts this explicitly.
- [ ] **SC-3 — `link`/`ref` subpath correctness**: When an entry declares `docsPath`, the symlink target (link mode) or recorded path (ref mode) points at the docs subdirectory, not the repo root. Regression test covers a non-empty `docsPath`.
- [ ] **SC-4 — Store-hit verification**: A corrupted store entry (tampered `INDEX.md` or missing stamp) is detected on store-hit, moved to `.quarantine/`, and triggers a fresh fetch on the next install.
- [ ] **SC-5 — Mutable-ref rejection**: `ask install` with an entry `ref: "main"` (or `master`/`HEAD`/`latest`/`develop`) fails with a descriptive error pointing to `--allow-mutable-ref`. With the flag, the same install succeeds.
- [ ] **SC-6 — ResolvedEntry commit**: After a successful install of a `github` entry, `.ask/resolved.json` records the commit SHA (40-char hex) the tag resolved to at install time.
- [ ] **SC-7 — Legacy detection**: On first install after upgrade, if `~/.ask/github/db` or `~/.ask/github/checkouts` exists, a one-line warning is printed pointing at `ask cache clean --legacy`. The subcommand removes both directories and exits cleanly.
- [ ] **SC-8 — Store version**: `<askHome>/STORE_VERSION` contains the literal string `"2"` after any successful install against a fresh `ASK_HOME`.
- [ ] **SC-9 — Test suite green**: `bun run test` passes with all existing tests plus the new unit and integration tests above.

## Constraints

- **No in-place data migration.** Users of the legacy `db/checkouts` layout receive a warning and a cleanup subcommand; no automatic conversion of existing entries. (User confirmed early-stage breakage is acceptable.)
- **PM convention compliance.** Layout follows `<kind>/<identity>@<version>/` as already established by `npm`, `web`, `llms-txt` source kinds and by cargo/bun/go/pnpm.
- **No Windows regressions.** The current `link → copy` fallback on Windows is retained; `cpDirAtomic` continues to handle the non-symlink path.
- **opensrc parity where it makes sense.** Shallow clone + `.git/` strip mirrors `vendor/opensrc/packages/opensrc/cli/src/core/git.rs:37`; layout mirrors `.../core/cache.rs:83`. ASK-specific guarantees (`verifyEntry`, per-entry `.lock`, `writeEntryAtomic`) are preserved.
- **Schema is the source of truth for ref validity.** Mutable-ref rejection lives as a Zod refinement in `packages/schema/src/ask-json.ts`; CLI-only enforcement is rejected (duplicates logic, ref invariant belongs to the data shape). Escape hatch is expressed via a schema factory selected by CLI flag, not by skipping validation entirely.

## Open Questions (deferred or informational)

- **Q3** — How should `ask cache ls` render legacy entries (separate section vs inline vs hidden behind `--legacy`)? Decision deferred to the `ask cache clean --legacy` implementation step in the plan.
- **Q4** — Removing `.git/` is declared a non-goal blocker: future enhancements that want commit history / cross-tag diff will rebuild on `git ls-remote` + on-demand re-fetch.
- **A1 benchmark** — Deferred to a follow-up track. No gating on this for MVP.
- **A2 corpus scan** — Executed during planning/implementation as a quick one-shot to confirm the low-duplicate-tag assumption; result logged in PR description. No gating.
- **A3 `.git/` dependency audit** — Executed during implementation (read-only audit of `sources/github.ts`, `install.ts`, `storage.ts`); result logged in PR description. Implementation must NOT introduce new `.git/` consumers after clone.
- **A4 false-positive rate** — Validated by running the heuristic against every committed `ask.json` and registry entry `ref` during implementation; logged in PR.
