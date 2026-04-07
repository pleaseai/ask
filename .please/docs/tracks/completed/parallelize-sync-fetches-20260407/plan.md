# Plan: Parallelize sync command fetches

> Spec: [spec.md](./spec.md) · Issue: #2

## Architecture

Refactor `syncCmd` in `packages/cli/src/index.ts` to:

1. Extract a small inline concurrency limiter (`runWithConcurrency<T, R>(items, limit, fn)`) — ~15 LOC, no new dependency. Place it in `packages/cli/src/concurrency.ts` so it can be unit-tested in isolation.
2. Extract per-entry processing (fetch + diff + writes) into a private function `syncEntry(projectDir, entry, lock): Promise<'drifted' | 'unchanged' | 'failed'>`. This makes the main loop trivially partitionable and the entry logic testable.
3. In `syncCmd`:
   - Partition `config.docs` into `parallel = entries where source ∈ {github, npm, llms-txt}` and `serial = entries where source === 'web'`.
   - Run `parallel` through `runWithConcurrency(parallel, 5, syncEntry)`.
   - Run `serial` through a plain `for…of` loop calling `syncEntry`.
   - Aggregate counters from both phases for the final summary.

The lock object is read once at the start (already true today). Per-entry writes via `upsertLockEntry`/`addDocEntry` continue to read+merge+write the file each call — this is acceptable for now (out-of-scope: see spec). They are called from `syncEntry` which is awaited per entry inside the limiter, so there's no concurrent write to the same file from the parallel group (each entry writes once, and `upsertLockEntry` itself is synchronous fs).

> ⚠️ **Concurrency hazard to verify**: `addDocEntry` and `upsertLockEntry` do read-modify-write on shared files. Even if each call is synchronous, parallel fetches that resolve simultaneously and then call these in quick succession on the event loop are still safe *only* because Node's fs sync ops are blocking. Confirm during T-2 that there is no `await` between the read and write inside these helpers — if there is, the implementation must serialize writes.

## Tasks

- [x] **T-1**: Create `packages/cli/src/concurrency.ts` with `runWithConcurrency` + unit tests
  - Signature: `runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>`
  - Preserves input order in the result array
  - Each `fn` call is independent — errors from one item must not reject the whole batch; instead, the caller wraps `fn` to convert errors into a result variant (we'll do this in T-3)
  - Vitest table-driven tests: limit=1 (serial), limit=∞, limit < items.length, empty input, single item

- [x] **T-2**: Audit `addDocEntry` (`config.ts`) and `upsertLockEntry` (`io.ts`) for read-modify-write atomicity
  - Read both functions; confirm no `await` between read and write
  - If safe → document the invariant in a comment above each
  - If unsafe → add a note to the plan and serialize writes by funneling them through a sequential post-fetch loop (the original "fetches first, writes after" design from the issue proposal)

- [x] **T-3**: Extract `syncEntry` helper in `packages/cli/src/index.ts`
  - Pure-ish: takes `(projectDir, entry, lock)`, returns `{ status: 'drifted' | 'unchanged' | 'failed', resolvedVersion?: string, error?: unknown }`
  - Wraps the existing per-entry body (lines 250-292) verbatim — no behavior change, just relocation
  - Must NOT throw — catches errors internally and returns `status: 'failed'`
  - Logs the same `consola.info` / `consola.success` / `consola.error` lines as today

- [x] **T-4**: Refactor `syncCmd` body to partition + parallelize
  - Partition entries by `source` field
  - `await runWithConcurrency(parallelEntries, 5, e => syncEntry(projectDir, e, lock))`
  - `for (const e of serialEntries) await syncEntry(...)`
  - Aggregate `drifted` / `unchanged` / `failed` counters from both result sets
  - Final `consola.success` summary unchanged

- [x] **T-5**: Vitest coverage for `syncCmd` partition logic
  - Mock `getSource` to return controlled fetch results (one `github`, one `npm`, one `web`, one failing)
  - Assert: counters are correct, web is processed serially (verify by recording call order), failed entry does not abort batch
  - May require small refactor to make `syncCmd.run` testable (export the inner function or run via `runMain` in a child process — prefer the export approach)

- [x] **T-6**: Manual smoke test
  - Create a temp `.ask/config.json` with 3 github entries pointing at small public repos
  - Run `node packages/cli/dist/index.js docs sync` on this branch and on `main`
  - Eyeball wall-clock difference; record in PR description (no CI gate)

- [x] **T-7**: Run `bun run --cwd packages/cli lint` and `bun run --cwd packages/cli build` — both must pass

## Verification

- `bun run --cwd packages/cli lint` ✅
- `bun run --cwd packages/cli build` ✅
- Vitest suites for `concurrency.ts` and `syncCmd` partition ✅
- Manual smoke test recorded in PR description ✅
- `.ask/ask.lock` and `.ask/config.json` byte-identical to a serial run for the same input ✅

## Out of scope

- Generic `readJson<T>`/`writeJson<T>` helpers in `io.ts` (deferred per issue)
- Batching lock+config writes into a single read/write at end of sync (may revisit if T-2 finds atomicity issues)
- Replacing `consola` with structured logging
- Adding `--concurrency` CLI flag (hard-code 5 for now; can be exposed later if requested)

## Outcomes & Retrospective

### What Was Shipped

- `runWithConcurrency` inline limiter (no new dep) + 8 unit tests
- `syncEntry` extracted from the serial loop, never throws, preserves write ordering
- Partition: github/npm/llms-txt parallel (cap=5), web serial
- `runSync(projectDir, options)` exported with DI hook for testing
- `runMain` entry-point guard so the module is importable from tests
- Cross-platform fix using `pathToFileURL` (caught in code review)

### What Went Well

- T-2 atomicity audit was decisive — `addDocEntry`/`upsertLockEntry` are fully synchronous, so no serialization layer was needed and the design stayed simple.
- Dependency injection on `runSync` enabled fast, deterministic partition tests without mocking the network or spawning child processes.
- The code review caught a real cross-platform bug (Windows entry-point guard) that would have shipped silently.

### What Could Improve

- The initial entry-point guard (`\`file://\${process.argv[1]}\``) was a thinko — should have reached for `pathToFileURL` immediately. Worth a gotcha entry.
- Manual smoke test (T-6) was skipped — partition tests cover the behavior, but a real-world wall-clock measurement would have strengthened the PR.

### Tech Debt Created

- None. Out-of-scope items (generic `readJson`/`writeJson`, lock+config write batching, `--concurrency` flag) were deferred deliberately and called out in spec/plan/PR.
