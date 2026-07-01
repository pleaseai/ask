---
name: csp-cli-source-location
description: Where to find the real csp (code-search) CLI source to verify ask<->csp integration claims (clap arg defs, subcommands)
metadata:
  type: reference
---

The `csp` binary that `packages/cli/src/commands/search.ts` and `resolve-csp.ts` shell out to
is NOT part of this monorepo — it's a separate Rust project (`code-search`). When reviewing
`ask search` / `ask cache` diffs that reference csp's CLI surface (subcommands, flags, exit
codes), verify claims against the actual clap definitions rather than trusting comments.

Locations observed on this machine (any one may be present/stale — check before trusting):
- `/Volumes/Dev/IdeaProjects/pleaseai-oss/repos/code-search/crates/csp-cli/src/main.rs`
- `/Users/lms/orca/workspaces/code-search/wiki/crates/csp-cli`
- `/Users/lms/orca/workspaces/code-search/copy-over-shim/crates/csp-cli`

Confirmed facts (as of the `ask-csp-integration-20260701` track, commit a2b8195 on
`amondnet/rust`):
- `Command::Search { query, path, top_k, content, index, git_ref }` — `query` and `path` are
  positional in that order (query first, then path). `--top-k`/`-k`, `--content` (repeatable,
  `num_args = 1..` so `--content code docs` in one flag occurrence IS valid clap syntax, not
  a bug), `--index`, `--ref`.
- `Command::Clear { what }` exists with `what` positional, valid values `all | index | savings`
  (see `CLEAR_CHOICES`). So `csp clear index` (referenced in `packages/cli/src/store/cache.ts`
  `cacheGc`'s advisory message) is a real, valid invocation — not a hallucinated command.

See also [[ask-csp-integration-track]].
