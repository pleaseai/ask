---
name: ensureCheckout fallback-ref path divergence
description: ensureCheckout discards GithubSource.fetch().storePath; fallbackRefs/v-prefix winners silently produce wrong checkoutDir
type: project
---

`packages/cli/src/commands/ensure-checkout.ts` computes `checkoutDir` from the *originally requested* `ref` and then discards the `FetchResult` from `fetcher.fetch(fetchOpts)`. But `GithubSource.fetch` may write to `<askHome>/github/github.com/<owner>/<repo>/<winningCandidate>/` where `winningCandidate` comes from `refCandidates(ref, fallbackRefs)` — i.e. a monorepo tag like `ai@6.0.159`, or the `v<ref>` variant produced inside `cloneAtTag`. The returned `storePath` reflects the winner; the discarded value is the one that matters.

**Why:** PR #82 fixed the legacy-path variant of this bug (`githubCheckoutPath` → `githubStorePath`) but did not fix the fallback-ref variant. Downstream: `runDocs` → `findDocLikePaths(result.checkoutDir)` → `fs.existsSync` false → `[]` → exit 0 with no output. The source file even has a comment at lines 191-193 warning about this class of divergence, but only the naming axis is defended, not the ref-selection axis.

**How to apply:** When reviewing `ensureCheckout` or any caller that trusts a pre-fetch-computed path, check whether the fetcher's actual output location is read back. Treat `await fetcher.fetch(...)` without using the return value as a silent-failure smell for any source that has fallback/retry ref logic. Also: any `runDocs`-style "emit N lines" loop should assert N > 0 before exit 0 — that invariant would catch every future variant of this class.
