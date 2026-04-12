# Common Pitfalls in This Project

## CI/CD (Added: 2026-04-13)

- **bun pm pack resolves workspace:\* from lockfile, not package.json**: `bun pm pack` substitutes `workspace:*` dependencies using the version recorded in `bun.lock`, not the live `package.json` version. When release-please bumps `package.json` versions without regenerating the lockfile, the packed tarball ships with stale dependency versions. This caused `@pleaseai/ask@0.3.2` to depend on `@pleaseai/ask-schema@0.3.0` instead of `0.3.1`, breaking `bunx @pleaseai/ask@latest`.
  - Impact: Published CLI package is broken for all users running via `bunx`/`npx`
  - Workaround: Regenerate lockfile before packing (`rm bun.lock && bun install`). Applied in `.github/workflows/release.yml`.
  - Status: oven-sh/bun#20477, oven-sh/bun#18906 - open/unfixed

## Database

- _No known issues yet_

## Authentication

- _No known issues yet_

## External Services

- _No known issues yet_

---

**How to use this file:**

1. Add gotchas as you discover them
2. Include workarounds and issue numbers
3. Remove when issues are resolved
4. Archive to `archive/resolved-gotchas.md`
