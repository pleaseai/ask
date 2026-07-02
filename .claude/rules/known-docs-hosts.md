---
paths:
  - "hooks/**"
---

# Maintaining `hooks/known-docs-hosts.json`

This map powers the WebFetch PreToolUse hook (`hooks/fetch-hint.mjs`): when an
agent fetches a known library documentation site, the hook injects a hint
suggesting the equivalent `ask` command. github.com / raw.githubusercontent.com
URLs are handled by dedicated parsers in the hook — never add them to this map.

## Key format (hostname)

- Bare hostname only: lowercase, no scheme, no path, no trailing slash.
- Never include a `www.` prefix — the hook strips it before lookup.
- The hook falls back by stripping leading labels (`docs.astro.build` →
  `astro.build`), so register the apex domain unless the docs genuinely live on
  an unrelated host (e.g. `fastapi.tiangolo.com`, `requests.readthedocs.io`).

## Value format (ask spec) — ecosystem spec first

Prefer the ecosystem spec (`npm:<pkg>`, `pypi:<pkg>`, `pub:<pkg>`) whenever the
library ships a published package. Rationale (see
`packages/cli/src/commands/ensure-checkout.ts`):

- Version resolution is lockfile-first: the checkout pins to the version the
  current project actually installs — the whole point of hinting away from the
  live docs site.
- npm specs set `npmPackageName`, so `ask docs` walks `node_modules/<pkg>/`
  first (zero-network README/docs).
- The resolver handles monorepo tag conventions (`<unscoped-pkg>@<version>`
  fallbackRefs) that a raw `github:` spec would miss.

Use `github:owner/repo` ONLY when no package is published (e.g. `emulate.dev`,
`kubernetes.io`). Such specs resolve to the default branch (`main`) — unpinned,
but still better than scraping HTML.

Only use ecosystems that have a resolver: `npm`, `pypi`, `pub`, `maven`.

## What NOT to add

- Hosts whose docs cover many unrelated packages selected by URL path (e.g.
  `tanstack.com/query` vs `tanstack.com/router`). The map is host-only; a wrong
  spec hint is worse than staying silent. Extend the hook with path-aware rules
  first if such a host is ever needed.
- Monorepo umbrella repos as `github:` when a canonical entry package exists —
  map to that package instead (e.g. `angular.dev` → `npm:@angular/core`).
- General-purpose sites (blogs, MDN, Stack Overflow): the hook must stay
  high-precision; when in doubt, leave the host out.

## After editing

Run `node --test hooks/fetch-hint.test.mjs`. When adding an entry with a new
shape (new ecosystem, first readthedocs-style host, etc.), add a test case.
