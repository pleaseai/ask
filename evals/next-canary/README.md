# Next.js Canary Eval Suite

Evaluates whether ASK-provided documentation helps AI agents correctly use Next.js 16+ APIs that differ from training data. Powered by [`@vercel/agent-eval`](https://github.com/vercel-labs/agent-eval) with Docker sandbox.

## Background

Vercel's [next-evals-oss](https://github.com/vercel/next-evals-oss) demonstrated that AI agents fail on Next.js 16+ APIs not in their training data, but achieve 100% pass rate when given documentation pointers via `AGENTS.md`.

| Model | Baseline | + AGENTS.md | Delta |
|---|---|---|---|
| Claude Sonnet 4.6 | 67% (14/21) | 100% (21/21) | **+33%** |
| Claude Opus 4.6 | 71% (15/21) | 100% (21/21) | **+29%** |

Source: [AGENTS.md outperforms skills](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) · [nextjs.org/evals](https://nextjs.org/evals)

This suite tests the same approach using ASK's documentation pipeline.

## Evals included

9 evals covering all cases where Sonnet 4.6 or Opus 4.6 fail at baseline:

| Eval | API tested | Sonnet fail | Opus fail |
|---|---|---|---|
| [agent-000](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-000-app-router-migration-simple) | Pages → App Router migration | | YES |
| [agent-029](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-029-use-cache-directive) | `'use cache'` + `cacheTag()` | YES | |
| [agent-031](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-031-proxy-middleware) | `proxy.ts` (replaces middleware) | YES | YES |
| [agent-032](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-032-use-cache-directive) | `cacheComponents` + `cacheLife()` | YES | |
| [agent-036](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-036-after-response) | `after()` from `next/server` | YES | |
| [agent-037](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-037-updatetag-cache) | `updateTag()` cache invalidation | | YES |
| [agent-038](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-038-refresh-settings) | `refresh()` from `next/cache` | YES | YES |
| [agent-039](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-039-indirect-proxy) | `proxy.ts` (implicit inference) | YES | YES |
| [agent-040](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-040-unstable-instant) | `unstable_instant` export | YES | YES |

## Experiments

4 experiment configurations comparing baseline vs ASK-assisted:

| Experiment | Model | Docs | File |
|---|---|---|---|
| `claude-sonnet-4.6` | Sonnet 4.6 | none | `experiments/claude-sonnet-4.6.ts` |
| `claude-sonnet-4.6--with-ask` | Sonnet 4.6 | AGENTS.md | `experiments/claude-sonnet-4.6--with-ask.ts` |
| `claude-opus-4.6` | Opus 4.6 | none | `experiments/claude-opus-4.6.ts` |
| `claude-opus-4.6--with-ask` | Opus 4.6 | AGENTS.md | `experiments/claude-opus-4.6--with-ask.ts` |

## Prerequisites

- **Docker** — sandbox runs in Docker containers
- **Anthropic API key** — for Claude agents

## Setup

```bash
cd evals/next-canary
bun install
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY
```

## Running

```bash
# Preview what would run (no API calls, no cost)
bun run eval:dry

# Quick sanity check (1 eval per experiment)
bun run eval:smoke

# Run all experiments
bun run eval

# Run a single experiment
bunx agent-eval claude-sonnet-4.6--with-ask

# Force re-run (ignore cached results)
bunx agent-eval --force
```

## How it works

1. `@vercel/agent-eval` creates a Docker sandbox per eval
2. Each eval is a self-contained Next.js project with `PROMPT.md` (task) and `EVAL.ts` (assertions)
3. The agent sees `PROMPT.md` but NOT `EVAL.ts`
4. For `--with-ask` experiments, `AGENTS.md` is injected pointing to `node_modules/next/dist/docs/`
5. After the agent completes, `EVAL.ts` is uploaded and vitest runs the assertions
6. Results are saved to `results/` with fingerprint-based caching

## Key insight

The `AGENTS.md` injected by with-ask experiments is identical to what ASK's `ask add npm:next` produces — a pointer to version-specific docs bundled in the npm package at `dist/docs/`. This is the same approach Vercel used to achieve 100% pass rate.

## Results

Results are stored in `results/<experiment>/<timestamp>/<eval>/` with:
- `summary.json` — pass rate, run count, duration
- `run-N/result.json` — per-run pass/fail
- `run-N/transcript.json` — full agent conversation

## References

- [vercel/next-evals-oss](https://github.com/vercel/next-evals-oss) — Vercel's open-source eval suite
- [vercel-labs/agent-eval](https://github.com/vercel-labs/agent-eval) — Eval framework
- [nextjs.org/evals](https://nextjs.org/evals) — Interactive results dashboard
- [vercel/next.js/evals](https://github.com/vercel/next.js/tree/canary/evals/evals) — Eval fixtures source
- [AGENTS.md outperforms skills](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) — Vercel blog post
