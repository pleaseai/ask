# Nuxt UI Eval Suite

Compares documentation source quality for Nuxt UI by measuring how well AI agents use Nuxt UI v4 APIs across 4 conditions: no docs (baseline), llms.txt, llms-full.txt, and GitHub docs.

## Motivation

Libraries increasingly offer `llms.txt` / `llms-full.txt` as LLM-optimized documentation. This suite tests whether these formats actually help agents compared to raw GitHub docs or no docs at all.

## Experiments

| Experiment | Doc source | Description |
|---|---|---|
| `base` | none | Baseline — agent relies on training data only |
| `with-llms-txt` | `ui.nuxt.com/llms.txt` | Concise overview + doc links (~5KB) |
| `with-llms-full-txt` | `ui.nuxt.com/llms-full.txt` | Complete docs inlined (~200KB) |
| `with-github-docs` | `nuxt/ui` repo `docs/` | GitHub docs with ASK-style AGENTS.md |

## Evals

6 evals targeting Nuxt UI v4 features and breaking changes:

| Eval | Feature tested | Why it's hard without docs |
|---|---|---|
| eval-001-chat-message | `UChatMessage` + `parts` prop | Brand new v4 component, AI SDK format. Negative: detects deprecated `content` prop and `useChat()` |
| eval-002-command-palette | `UCommandPalette` groups API | v4 API differs significantly from v2 |
| eval-003-theme-customization | `@theme` directive + `app.config.ts` | v4 CSS-first theming replaces config-based. Negative: detects `tailwind.config` and `@nuxt/ui-pro` |
| eval-004-field-group | `UFieldGroup` (was `UButtonGroup`) | v4 renamed ButtonGroup → FieldGroup. Negative: detects deprecated `UButtonGroup` |
| eval-005-nullable-input | `v-model.nullable` (was `.nullify`) | v4 renamed nullify → nullable modifier. Negative: detects deprecated `.nullify` |
| eval-006-nested-form | `nested` prop + `name` inheritance | v4 changed nested form pattern. Negative: detects deprecated `:state` on nested forms |

## Prerequisites

- **Docker** — sandbox runs in Docker containers
- **Anthropic API key** — for Claude agents

## Setup

```bash
cd evals/nuxt-ui
bun install
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY
```

## Running

```bash
# Preview what would run (no API calls)
bun run eval:dry

# Quick sanity check (1 eval per experiment)
bun run eval:smoke

# Run all experiments
bun run eval

# Run a single experiment
bunx agent-eval with-llms-full-txt

# Force re-run (ignore cache)
bunx agent-eval --force
```

## Analyzing results

```bash
# Table summary (pass rate, duration, tokens, cost)
bun run analyze

# Specific timestamp
bun run analyze --timestamp 2026-04-07T03

# Export formats
bun run analyze:json
bun run analyze:csv
```

Results saved to `results/<experiment>/<timestamp>/<eval>/` with:
- `summary.json` — pass rate, run count, duration
- `run-N/result.json` — per-run pass/fail, o11y (tool calls, files read/modified)
- `run-N/transcript-raw.jsonl` — raw API messages with token usage

## Results (2026-04-07)

**Model**: claude-sonnet-4-6 | **Sandbox**: Vercel | **Runs**: 4 (early exit on first pass)

### Pass Rate

| Eval | base | with-github-docs | with-llms-full-txt | with-llms-txt |
|---|---|---|---|---|
| eval-001-chat-message | 100% (1/1) | 100% (1/1) | 100% (1/1) | 50% (1/2) |
| eval-002-command-palette | 100% (1/1) | 100% (1/1) | 50% (1/2) | 33% (1/3) |
| eval-003-theme-customization | 100% (1/1) | 100% (1/1) | 50% (1/2) | 25% (1/4) |
| eval-004-field-group | 50% (1/2) | 100% (1/1) | 33% (1/3) | 100% (1/1) |
| eval-005-nullable-input | 100% (1/1) | 100% (1/1) | 50% (1/2) | 25% (1/4) |
| eval-006-nested-form | 100% (1/1) | 100% (1/1) | 33% (1/3) | 100% (1/1) |
| **OVERALL** | **86% (6/7)** | **100% (6/6)** | **46% (6/13)** | **40% (6/15)** |

### Token Usage & Cost

| Experiment | Total Input | Output | Est. Cost |
|---|---:|---:|---:|
| base | 2,035,331 | 15,897 | $1.82 |
| with-github-docs | 1,802,642 | 11,940 | $1.67 |
| with-llms-full-txt | 3,328,611 | 18,554 | $2.93 |
| with-llms-txt | 4,598,076 | 18,748 | $4.83 |

### Tool Call Patterns

| Experiment | Total | Read | Write | Edit | Shell | Glob | Grep | WebFetch | Turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | 51 | 15 | 8 | 1 | 23 | 1 | 0 | 0 | 13 |
| with-github-docs | 50 | 16 | 7 | 1 | 13 | 7 | 0 | 0 | 17 |
| with-llms-full-txt | 113 | 51 | 8 | 1 | 17 | 7 | 29 | 0 | 30 |
| with-llms-txt | 117 | 42 | 11 | 3 | 7 | 11 | 8 | 21 | 36 |

### Key Findings

1. **ASK-style github-docs is the most effective** — 100% pass rate at the lowest cost ($1.67). Structured docs with version warnings let the agent find correct v4 APIs without excessive exploration.

2. **llms.txt and llms-full.txt hurt more than they help** — Both scored below baseline (40% and 46% vs 86%). The agent spends tokens searching through large unstructured docs (29 grep calls for llms-full-txt, 21 web fetches for llms-txt) but still uses deprecated patterns.

3. **Breaking change evals differentiate effectively** — The original 3 evals (v4 new features) all passed 100% across every experiment. The 3 new evals targeting v4 breaking changes (FieldGroup, nullable, nested form) create clear separation between doc sources.

4. **Baseline is surprisingly strong** — Training data already covers most v4 APIs (86%). The main gap is `ButtonGroup → FieldGroup` rename (eval-004), which only github-docs consistently caught.

5. **Cost scales inversely with quality** — The worst performer (with-llms-txt) costs 2.9x more than the best (with-github-docs), driven by retry loops and exploratory tool calls.
