# Telemetry-Driven Auto-Registry with JSON Migration

## Problem Statement

> **How might we** eliminate the manual registry registration process so that ASK's library coverage grows organically from real user installs, while maintaining docs quality through success-rate-based trust?

## Recommended Direction

Two complementary changes that reinforce each other:

### Change 1: Markdown → JSON (immediate, low-risk)

Switch registry entries from Markdown (`type: 'page'`) to JSON (`type: 'data'`) in Nuxt Content v3. The markdown body is unused — CLI routing only needs structured frontmatter data. JSON eliminates YAML indentation pitfalls, enables IDE autocomplete via JSON Schema, and makes community contributions trivially validatable.

```ts
// content.config.ts — the only code change
registry: defineCollection({
  type: 'data',                    // was: 'page'
  source: 'registry/**/*.json',   // was: 'registry/**/*.md'
  schema: registryEntrySchema,     // unchanged
})
```

### Change 2: Telemetry-Driven Auto-Registration (skill.sh model)

Adopt the [skill.sh](https://skills.sh) model: CLI collects anonymous install telemetry (opt-out via `ASK_NO_TELEMETRY=1`), a server aggregates success rates, and high-confidence combinations are auto-promoted to registry entries.

```
ask install npm:react
  → docs fetch succeeds
  → telemetry event: { spec, resolved: { repo, docsPath, version, tag, source }, success, timestamp }
  → server aggregation → success rate > threshold → auto-entry
```

**Why success-rate based trust matters:**
- Simple install counts can be gamed or misleading
- Success rate validates that a `(repo, docsPath, tag)` combination actually works
- Solves the monorepo tag pattern problem via crowdsourcing: `@tanstack/query@5.75.7` vs `v5.75.7` — whichever tag pattern succeeds most wins
- Current 50 curated entries serve as seed data during cold-start

**Privacy model (skill.sh reference):**
- CLI code: open source (auditable what gets sent)
- Telemetry data: anonymous aggregate only (no user/device identifiers)
- Opt-out: `ASK_NO_TELEMETRY=1` environment variable
- Server code: follows skill.sh model (CLI open, server private, results publicly queryable via API)

### Key Design Principle: One Entry Per Library, Not Per Version

The registry stores **location and pattern information**, not version-specific snapshots. Each library has exactly one entry containing:

- `repo` — where the source lives
- `docsPath` — where docs are within the repo
- `tagPattern` — how to map npm/pypi versions to git tags (e.g., `v{version}`, `@tanstack/query@{version}`)

The CLI resolves the **version** at runtime from the project's lockfile, applies the `tagPattern` to derive the git tag, and fetches docs at that tag. No per-version registration needed.

```
Registry (version-agnostic, registered once):
├── repo: facebook/react
├── docsPath: docs
├── tagPattern: v{version}
└── source: github

CLI runtime (resolved per install):
├── version: 19.1.0          ← from lockfile
├── tag: v19.1.0             ← tagPattern applied
└── fetch: github.com/facebook/react/tree/v19.1.0/docs
```

Common `tagPattern` examples learned from telemetry:

| repo | tagPattern | example tag |
|------|-----------|-------------|
| `facebook/react` | `v{version}` | `v19.1.0` |
| `TanStack/query` | `@tanstack/query@{version}` | `@tanstack/query@5.75.7` |
| `expressjs/express` | `v{version}` | `v4.21.0` |
| `lodash/lodash` | `{version}` | `4.17.21` |

**Edge case — docsPath changes across major versions:** Extremely rare, but telemetry handles it naturally. When success rate drops for a known `docsPath`, the new path surfaces from successful installs on the latest version. No manual intervention needed.

**Solves version → tag mapping** — one of the hardest problems in multi-ecosystem support. Tag conventions vary wildly across repos. Telemetry learns the `tagPattern` per repo from successful installs, eliminating the need for manual registry configuration.

**Telemetry payload (full scope):**
```json
{
  "spec": "npm:react",
  "resolved": {
    "repo": "facebook/react",
    "docsPath": "docs",
    "version": "19.1.0",
    "tag": "v19.1.0",
    "tagPattern": "v{version}",
    "source": "github"
  },
  "success": true,
  "error": null,
  "timestamp": "2026-04-13T10:00:00Z"
}
```

On failure:
```json
{
  "spec": "npm:@tanstack/react-query",
  "resolved": {
    "repo": "TanStack/query",
    "docsPath": "docs",
    "version": "5.75.7",
    "tag": "v5.75.7",
    "source": "github"
  },
  "success": false,
  "error": "TAG_NOT_FOUND",
  "timestamp": "2026-04-13T10:00:00Z"
}
```

## Key Assumptions to Validate

- [ ] **Opt-out default yields sufficient data** — skill.sh proves this model works; validate at ASK's user scale. Target: 100+ events/month minimum.
- [ ] **Success rate is a good proxy for docs quality** — a successful fetch ≠ quality docs. Consider adding file count/size thresholds.
- [ ] **tagPattern inference works reliably** — when multiple tag patterns succeed for the same repo, majority vote should surface the canonical pattern. Validate with known monorepos (TanStack, Mastra, Spring).
- [ ] **Cold-start period is acceptable** — seed 50 entries → telemetry-augmented: how many weeks/months?
- [ ] **JSON migration is non-breaking** — verify `queryCollection` API behavior is identical for `type: 'data'` vs `type: 'page'`.

## MVP Scope

**In:**
- Convert 50 existing `.md` entries to `.json` (automated script)
- Update `content.config.ts`: `type: 'data'`, source `**/*.json`
- Export JSON Schema from `registryEntrySchema` for IDE support
- Add opt-out telemetry layer to CLI (`ASK_NO_TELEMETRY=1`)
- Cloudflare Workers + D1 telemetry aggregation API
- Success-rate threshold for auto-promotion (e.g., 5+ installs, 80%+ success)
- CLI registry lookup returns both seed and telemetry-promoted entries

**Out:**
- Web browser/search UI (CLI routing only)
- User authentication/accounts
- Real-time leaderboard/ranking UI
- AI/ML-based docsPath inference engine
- Immediate removal of `apps/registry/` (gradual deprecation)

## Not Doing (and Why)

- **Web registry browser** — CLI routing-only purpose. Web UI is over-engineering.
- **Per-version registry entries** — Registry stores patterns (`tagPattern`, `docsPath`), not version snapshots. CLI resolves version at runtime from lockfile. One entry per library is sufficient.
- **Per-user tracking** — Privacy. Anonymous aggregates only.
- **Auto docsPath inference engine** — Convention-based discovery already exists; telemetry augments it. No separate ML needed.
- **Real-time telemetry processing** — Batch aggregation (hourly or daily) is sufficient. Real-time adds complexity.
- **Open-sourcing the aggregation server** — Following skill.sh model: CLI is open (auditable), server is private, results are publicly queryable.

## Open Questions

- Should the telemetry API live as an API route in `apps/registry/` (Cloudflare Pages) or as a separate Workers service?
- Seed entry migration: automated `md → json` conversion script, or manual review during conversion?
- Success-rate threshold tuning: start low (3 installs, 60% success) and raise gradually?
- Monorepo disambiguation: when multiple tag patterns succeed simultaneously, selection algorithm?
- Should telemetry-promoted entries be committed back to the git repo as `.json` files (via bot PR), or live only in D1?

## References

- [skill.sh — The Agent Skills Directory](https://skills.sh/docs)
- [skill.sh CLI telemetry model](https://skills.sh/docs/cli)
- [Nuxt Content v3 JSON files](https://content.nuxt.com/docs/files/json)
- [Homebrew analytics (open data model)](https://docs.brew.sh/Analytics)
- [Next.js telemetry](https://nextjs.org/telemetry)
