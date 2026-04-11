---
name: Shell pipe stderr loss pattern
description: execSync with curl | tar pipelines erases HTTP/network errors — require -fsSL or split into execFileSync calls
type: feedback
---

`execSync('curl -sL "<url>" | tar xz -C "<dir>"')` is a recurring anti-pattern in `packages/cli/src/sources/`. Three compounding failures:

1. `curl -s` silences stderr AND `curl -L` does not imply `-f` — curl exits 0 on HTTP 404/403/500, sending the error body into tar.
2. The pipe exit code is tar's, not curl's. Tar exits 0 on an empty input (or fails with a cryptic "unexpected EOF" that doesn't mention the HTTP status).
3. The caller's error is a generic "Failed to extract archive" with zero diagnostic detail.

**Why:** A reviewer (me, in PR #60) flagged this in `sources/github.ts:fetchFromTarGz`. Users hitting rate limits / private repos / wrong refs would get indistinguishable "Failed to extract archive" errors.

**How to apply:** Whenever new code uses `execSync` with a `curl | tar` pipeline, require either:
- `curl -fsSL` (the `-f` is load-bearing — fail on HTTP errors; `-S` shows errors even with `-s`), OR
- Split into `execFileSync('curl', [...])` followed by `execFileSync('tar', [...])` so each command's stderr surfaces independently. Prefer this when the URL or ref comes from user input, since it also avoids shell injection.
