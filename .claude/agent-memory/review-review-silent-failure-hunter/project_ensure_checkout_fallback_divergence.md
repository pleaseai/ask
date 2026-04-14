---
name: ensureCheckout fallback-ref path divergence (RESOLVED in 9f25e8f)
description: Historical — ensureCheckout discarded GithubSource.fetch().storePath; fixed in PR #82 iteration 2 by threading fetchResult.storePath
type: project
---

**Status: RESOLVED** in commit `9f25e8f` (PR #82, iteration 2).

Fix at `packages/cli/src/commands/ensure-checkout.ts:224`:
```ts
const resolvedCheckoutDir = fetchResult?.storePath ?? checkoutDir
```
Integration test at `packages/cli/test/commands/ensure-checkout.integration.test.ts:66` (`returns the winning candidate path when fetch falls back from ref to a fallbackRef`) guards the regression.

**Historical context (why this memory exists):** `ensureCheckout` previously computed `checkoutDir` from the originally requested `ref` and discarded the `FetchResult` returned by `fetcher.fetch(...)`. `GithubSource.fetch` may write to `<askHome>/github/github.com/<owner>/<repo>/<winningCandidate>/` where the winner comes from `refCandidates(ref, fallbackRefs)` — e.g. a monorepo tag like `ai@6.0.159`, or the `v<ref>` variant produced inside `cloneAtTag`. Discarding `storePath` caused `runDocs`/`runSrc` to walk a nonexistent directory and exit 0 with no output. PR #82 first fixed the naming axis (`githubCheckoutPath` → `githubStorePath`); the iteration-2 commit closed the ref-selection axis.

**How to apply:** Keep this pattern in mind when reviewing any caller that trusts a pre-fetch-computed path. Treat `await fetcher.fetch(...)` without using the return value as a silent-failure smell for any source with fallback/retry ref logic. Also: any `runDocs`-style "emit N lines" loop should assert N > 0 before exit 0 — that invariant would catch every future variant of this class.
