---
name: pleaseai/ask repo merge settings
description: Repo only allows squash merge; merge commit and rebase are disabled
type: project
---

`pleaseai/ask` repository merge settings (verified 2026-04-08):
- `mergeCommitAllowed`: false
- `squashMergeAllowed`: true
- `rebaseMergeAllowed`: false

**Why:** Squash-only keeps main history clean (one commit per PR).
**How to apply:** Always use `gh pr merge --squash` (or `--auto --squash`). No need to check repo settings again unless something changes.
