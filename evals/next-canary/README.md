# Next.js Canary Eval Suite

Evaluates whether ASK-provided documentation helps AI agents correctly use Next.js 16+ APIs that differ from training data.

## Background

Vercel's [next-evals-oss](https://github.com/vercel/next-evals-oss) demonstrated that Claude Sonnet 4.6 fails **7 out of 21** Next.js evals at baseline (67% pass rate), but achieves **100% pass rate** when given a 3-line `AGENTS.md` pointing to `node_modules/next/dist/docs/`.

This eval suite tests whether the ASK approach — downloading version-specific docs via `ask docs add npm:next` — produces the same effect.

### Vercel's findings

| Model | Baseline | + AGENTS.md | Delta |
|---|---|---|---|
| Claude Sonnet 4.6 | 67% (14/21) | 100% (21/21) | **+33%** |
| Claude Opus 4.6 | 71% (15/21) | 100% (21/21) | +29% |
| GPT 5.3 Codex | 86% (18/21) | 100% (21/21) | +14% |

Source: [AGENTS.md outperforms skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) · [nextjs.org/evals](https://nextjs.org/evals)

## The 7 failing evals

All failures involve Next.js 16+ APIs not in Sonnet 4.6's training data:

| Eval | API tested | Why Sonnet fails |
|---|---|---|
| [agent-029](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-029-use-cache-directive) | `'use cache'` + `cacheTag()` | Uses deprecated `fetch({ next: { revalidate } })` |
| [agent-031](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-031-proxy-middleware) | `proxy.ts` (replaces middleware) | Creates `middleware.ts` (deprecated in v16) |
| [agent-032](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-032-use-cache-directive) | `cacheComponents` + `cacheLife()` | Uses `unstable_cache` or old patterns |
| [agent-036](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-036-after-response) | `after()` from `next/server` | Uses `setTimeout` or `waitUntil()` |
| [agent-038](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-038-refresh-settings) | `refresh()` from `next/cache` | Uses `redirect()` or `router.refresh()` |
| [agent-039](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-039-indirect-proxy) | `proxy.ts` (implicit inference) | Doesn't infer proxy layer is needed |
| [agent-040](https://github.com/vercel/next.js/tree/canary/evals/evals/agent-040-unstable-instant) | `unstable_instant` export | Doesn't know about instant navigation API |

Baseline failure rate: **0/4 runs passed** for each eval (0%).

## How ASK helps

ASK's npm source strategy extracts `dist/docs/` from `next@canary` — the exact same documentation that Vercel's `AGENTS.md` points to:

```bash
ask docs add npm:next --version canary
```

This downloads ~200 markdown files covering all Next.js 16+ APIs, including:
- `proxy.md` — proxy file convention (middleware replacement)
- `after.md` — post-response work scheduling
- `refresh.md` — server-side page refresh
- `cacheTag.md` / `cacheLife.md` — cache directive APIs
- `instant-navigation.md` — instant navigation with `unstable_instant`

## Running evals

### Prerequisites

- Node.js 22.5+
- Claude CLI (`claude`)
- ASK CLI built (`bun run --cwd packages/cli build`)

### Single eval

```bash
# Baseline (no docs) — expected to FAIL
./run-eval.sh agent-031-proxy-middleware --model sonnet

# With ASK docs — expected to PASS
./run-eval.sh agent-031-proxy-middleware --with-ask --model sonnet
```

### All evals

```bash
# Run all 7 evals in both modes
./run-all.sh --model sonnet

# Run a single eval in both modes
./run-all.sh --only agent-031-proxy-middleware
```

### Results

Results are saved to `results/<eval-name>/<mode>/`:
- `summary.json` — pass/fail, duration, model
- `transcript.json` — full Claude conversation
- `eval-output.txt` — vitest assertion results
- `build-output.txt` — `next build` output

## Eval structure

Each eval is a self-contained Next.js project copied from [vercel/next.js/evals](https://github.com/vercel/next.js/tree/canary/evals/evals):

```
agent-031-proxy-middleware/
├── PROMPT.md        # Task given to the agent
├── EVAL.ts          # Vitest assertions (withheld from agent)
├── package.json     # Next.js project
├── next.config.ts
├── tsconfig.json
└── app/
    ├── layout.tsx
    └── page.tsx
```

- **PROMPT.md**: The task description. Agent sees this.
- **EVAL.ts**: Success criteria. Agent does NOT see this — it's copied into the sandbox only after the agent completes.

## Key insight

Vercel's `AGENTS.md` is only 3 lines:

```markdown
# This is NOT the Next.js you know
This version has breaking changes. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code.
```

The real value is in `next@canary`'s bundled docs at `dist/docs/`. ASK's `npm` source strategy extracts these same docs, making the documentation available to agents through both Skills and AGENTS.md.

## References

- [vercel/next-evals-oss](https://github.com/vercel/next-evals-oss) — Open-source eval suite and results
- [nextjs.org/evals](https://nextjs.org/evals) — Interactive results dashboard
- [AGENTS.md outperforms skills](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) — Vercel blog post
- [vercel/next.js/evals](https://github.com/vercel/next.js/tree/canary/evals/evals) — Eval fixtures source
- [@vercel/agent-eval](https://github.com/vercel-labs/agent-eval) — Eval framework
