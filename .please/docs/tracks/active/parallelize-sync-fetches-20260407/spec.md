# Spec: Parallelize sync command fetches

> Refs #2

## Context

`packages/cli/src/index.ts` `syncCmd` currently iterates `config.docs` serially, awaiting each `source.fetch()` in turn. For workspaces with many `github`/`npm` entries this is dominated by network I/O and runs ~6× slower than necessary. Identified by the `/simplify` efficiency reviewer (Finding #3, confidence ≥80) during the `feat/ask-workspace-migration-track` review and deferred from that track to keep its scope tight.

## Problem

- Each `github` fetch involves a tarball download + `git ls-remote` (~3–5s).
- 10 github entries → ~30s wall time today; bounded parallelism could finish in ~5s.
- `web` sources should remain serial (politeness toward upstream servers).
- Existing failure semantics must be preserved: a single entry failing must NOT abort the batch (the current `try/catch` per entry already guarantees this).
- Existing write ordering must be preserved: `saveDocs → addDocEntry → upsertLockEntry → removeDocs (old) → generateSkill`. The comment at `packages/cli/src/index.ts:266-272` explains why this order matters for crash recovery.

## Goals

1. Parallelize network-bound work (`source.fetch`) for `github`, `npm`, `llms-txt` with bounded concurrency.
2. Keep `web` fetches serial.
3. Apply disk writes (saveDocs / addDocEntry / upsertLockEntry / removeDocs / generateSkill) sequentially after fetches, preserving the documented safe ordering.
4. Preserve catch-and-continue per-entry failure semantics. Final summary line (`drifted/unchanged/failed`) must remain accurate.
5. No change to user-facing CLI surface, output format, or `.ask/config.json` / `ask.lock` schema.

## Non-goals

- Refactoring `io.ts` to introduce generic `readJson<T>`/`writeJson<T>` helpers (mentioned in issue as out-of-scope).
- Batching lock+config writes into a single read/write at the end. May fall out naturally but is not a blocker — can be a follow-up if it complicates the PR.
- Changing fetch retry / timeout behavior.
- Adding telemetry or progress bars beyond existing `consola` lines.

## Functional Requirements

- **FR-1**: `syncCmd` partitions `config.docs` into a parallel-safe group (`github`, `npm`, `llms-txt`) and a serial group (`web`).
- **FR-2**: Parallel-safe group runs through a concurrency limiter with a bound of 5 in-flight fetches.
- **FR-3**: Serial group runs sequentially, in original order, after (or interleaved with — implementer's choice) the parallel group. Total ordering of disk writes must remain deterministic per entry.
- **FR-4**: Each entry's outcome (`unchanged` / `drifted` / `failed`) is logged in the same format as today.
- **FR-5**: A failure in one entry must not affect any other entry.
- **FR-6**: Final summary line `Sync complete: X re-fetched, Y unchanged, Z failed. AGENTS.md updated.` remains correct.

## Success Criteria

- **SC-1**: All existing tests pass (`bun run --cwd packages/cli lint && bun run --cwd packages/cli build` succeed; any vitest suites green).
- **SC-2**: New test coverage for the partition + concurrency-limit logic (table-driven, mocked sources).
- **SC-3**: Manual smoke: a `.ask/config.json` containing 3 github entries syncs faster than the same config on `main` (qualitative — no perf budget enforced in CI).
- **SC-4**: Lock + config files are byte-identical to a serial run for the same input (deterministic output).

## Risks

- **R-1**: A naive `Promise.all` would lose the catch-and-continue semantics — the limiter must wrap each fetch in its own try/catch.
- **R-2**: Interleaved `consola` logs from parallel fetches could become hard to read. Acceptable trade-off; can be mitigated by logging start+end as a single line per entry once both events are known.
- **R-3**: Concurrency limiter dependency choice (`p-limit` vs inline). Inline is preferable to keep the dependency tree minimal — `p-limit` is ~10 LOC of logic that's easy to inline.
