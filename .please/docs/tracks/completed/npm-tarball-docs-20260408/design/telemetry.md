# Telemetry Design — ASK Registry Auto-Promotion

> Status: design only. **No code in this track.** Implementation belongs to a follow-up track.
> Track: npm-tarball-docs-20260408

## Why this exists

Tier 1 of the npm `dist/docs` work relies on the ASK Registry being populated
with curated entries (`vercel/ai`, `mastra-ai/mastra`, …). Tier 2 lets the
agent walk `node_modules` at runtime when no entry exists. The gap between
the two tiers is the promotion lag: the long tail of packages that *do* ship
useful `dist/docs` will sit in Tier 2 forever unless we have a feedback loop
that turns Tier 2 hits into Tier 1 entries.

Telemetry closes that loop. When a CLI run finds usable docs in
`node_modules` for an unregistered package, it reports a tiny anonymous
event. The Registry aggregates events, surfaces high-signal candidates, and a
human (or an automated PR) promotes them.

This document is the design contract for that loop. **No code in this track.**

## Prior art: vercel-labs/skills `src/telemetry.ts`

Reference: <https://github.com/vercel-labs/skills/blob/main/src/telemetry.ts>

We should read that file before implementing, because Vercel's "skills"
project solves a structurally identical problem (tracking which Skill files
are loaded by Claude / agents to inform a curated catalog) and has already
made several decisions worth either copying or deliberately diverging from:

| Aspect                | Vercel pattern (assumed)                                  | What we need                            |
| --------------------- | --------------------------------------------------------- | --------------------------------------- |
| Opt-in model          | env var or first-run prompt                               | env var **only** (no prompt) — see below |
| Transport             | small POST to a single endpoint                           | same                                    |
| Payload shape         | event-typed JSON                                          | same, four field types                  |
| Aggregation           | per-tool / per-skill counts                               | per-package counts                      |
| Surfacing to humans   | dashboard or generated report                             | dashboard + automated PR draft          |
| Failure mode          | swallow errors, never block the user                      | identical                               |

**Action item for the follow-up track**: open `src/telemetry.ts` line by line
and confirm or override each row above. Where Vercel has a behavior we want
to inherit (e.g. fire-and-forget, graceful 4xx handling), copy with citation.
Where we diverge (no first-run prompt, GitHub PR output instead of
dashboard), record the rationale next to the divergent code.

## Activation model — opt-in only

The CLI must be silent by default. Telemetry is enabled by setting an
environment variable:

```bash
export ASK_TELEMETRY=1
```

Rationale:

- **No first-run prompt.** Prompting on first run is surprising in CI and
  scriptable contexts. Vercel-labs/skills (per the reference file) leans on
  an env var for the same reason. We mirror that.
- **No config-file knob.** A config knob is too easy to forget; people share
  configs and accidentally enable telemetry for collaborators. An env var
  scopes consent to the actual machine that exports it.
- **Single boolean.** No "level" knob, no per-event filter. Either you opt
  in to the full schema below or you send nothing. Granular knobs invite
  privacy mistakes.

When unset, the telemetry module is a no-op and never reads `node_modules`,
hits the network, or writes any state.

## Collected fields

Each event is a flat JSON object with these fields and *only* these fields:

```jsonc
{
  "schema": 1,                    // schema version, integer
  "event": "tier2_hit",           // see Event Types below
  "package": "ai",                // npm package name (or `@scope/pkg`)
  "version": "5.1.0",             // resolved version actually read
  "docsPath": "dist/docs",        // path inside the package that succeeded
  "fileCount": 14,                // number of doc files extracted
  "success": true,                // false when extraction failed mid-flow
  "askVersion": "0.3.0",          // CLI version emitting the event
  "platform": "darwin"            // process.platform — coarse only
}
```

Hard rules:

- **No project paths.** `installPath`, `cwd`, repo names, file paths, file
  contents — none of it leaves the machine. The `docsPath` field is the
  *relative* path inside the npm package, which is public information.
- **No hostnames.** No `os.hostname()`, no MAC, no machine ID.
- **No usernames.** No `os.userInfo()`, no env-var sweeps.
- **No content.** Doc file contents are public anyway, but we still don't
  send them — only the count.
- **No persistent identifier.** No UUID, no anonymous ID, no fingerprint.
  This means we can't dedupe on the server, which is fine: rate limiting
  per source IP is enough (see below).

## Event types

| Event              | When fired                                                      |
| ------------------ | --------------------------------------------------------------- |
| `tier2_hit`        | Tier 2 fallback found docs in `node_modules` for an unregistered package |
| `tier2_miss`       | Tier 2 walked `node_modules` but found nothing usable           |
| `tier1_local_hit`  | A registered npm strategy was satisfied from the local install (no tarball download) |
| `tier1_tarball`    | A registered npm strategy fell back to tarball download         |

The first two are the promotion signal. The latter two are quality metrics:
they tell us how often the local-first read pays off so we can decide
whether to keep optimizing it.

## Aggregation flow

```
CLI                Registry server          Promotion bot
 │                       │                       │
 │ POST /tlm  (event)    │                       │
 ├──────────────────────►│                       │
 │ 204                   │                       │
 │◄──────────────────────┤                       │
 │                       │ aggregate per package │
 │                       ├──────────────────────►│
 │                       │                       │ if count > threshold
 │                       │                       │ AND docsPath consistent:
 │                       │                       │   draft GH PR
 │                       │                       │   adding `<owner>/<repo>.md`
 │                       │                       │   with npm strategy
```

1. **Endpoint**: a single Cloudflare Worker route under
   `https://ask-registry.pages.dev/tlm`. POST only, accepts JSON, returns
   `204 No Content`. CORS not needed (server-to-server only).
2. **Storage**: a D1 table keyed on `(package, docsPath, version_major)`
   with a counter, last-seen timestamp, and a histogram of `fileCount`.
   No row-per-event storage — pre-aggregated only, so the worst we leak in
   a breach is "package X was looked up N times".
3. **Promotion threshold**: `count >= 5` AND `distinct askVersion >= 2` AND
   `consistent docsPath`. Tunable per ecosystem in a config file.
4. **Promotion bot**: a scheduled GitHub Action that scans the D1 table,
   finds candidates above threshold, and opens a draft PR adding the
   registry entry. The PR body links back to the count and the
   `docsPath`.
5. **Human review**: every promoted entry goes through normal PR review.
   Telemetry is a *suggestion*, not an authority.

## Privacy & abuse considerations

- **IP rate limit**: per-IP throttle at the worker (e.g. 100 events / hour).
  A noisy CI farm cannot drown the signal.
- **No IP storage**: rate limit uses an in-memory bucket on the worker
  edge; no log entry survives the request.
- **Public package names only**: anything in the payload is also publicly
  visible on `https://registry.npmjs.org/<package>`. No private/internal
  package leaks.
- **Tor / proxy users**: the env-var opt-in covers this — users routing
  through Tor explicitly chose to opt in.
- **Crawlers and scrapers**: the endpoint is unauthenticated. Cost scales
  with traffic, so we cap at the worker level (CPU + request limits).
- **Children of children**: if ASK is run via `npx ask` from inside another
  tool, the env var must propagate. Tools embedding ASK should never set
  `ASK_TELEMETRY=1` on behalf of users — that would launder consent.

## Failure modes

The telemetry module **must never** affect the CLI's exit code, output, or
timing in a user-visible way:

- Network failures → swallow, log at debug level only.
- Endpoint 4xx/5xx → swallow.
- DNS failure → swallow.
- Timeout → 2s hard cap on the POST, swallow on expiry.
- Schema mismatch (server side) → server logs, client doesn't notice.

If `ASK_TELEMETRY=1` is set but the request fails, the user sees the same
output as if they had not set it. This is the property the vercel-labs/skills
file enforces; we copy it.

## What this design does NOT include

- **Registry-side schema for the D1 table** — separate task, follow-up track.
- **Worker route implementation** — separate task, follow-up track.
- **Promotion bot GitHub Action** — separate task, follow-up track.
- **Dashboard UI** — out of scope; the GitHub PRs are the dashboard.
- **A `--telemetry` CLI flag** — explicitly rejected. Env var only.
- **Per-user IDs of any kind** — explicitly rejected.

## Open questions for the follow-up track

1. Should `tier1_local_hit` events also be opt-in, or are they so cheap and
   so non-identifying that we always send them when telemetry is enabled?
   (Recommend: opt-in same as everything else — no special cases.)
2. Promotion bot: PR-per-candidate or one rolling PR? PR-per-candidate is
   easier to review individually but spammy.
3. Threshold tuning: should `count >= 5` apply globally or be per-ecosystem?
   PyPI may need a different floor than npm.
4. How long to keep aggregated counters before pruning? (Recommend: 90
   days after last hit, then drop the row.)
