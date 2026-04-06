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
| `with-github-docs` | `nuxt/ui` repo `docs/` | Raw documentation files from GitHub |

## Evals

3 evals targeting Nuxt UI v4 features unlikely to be in training data:

| Eval | Feature tested | Why it's hard without docs |
|---|---|---|
| eval-001-chat-message | `UChatMessage` + `parts` prop | Brand new v4 component, AI SDK format |
| eval-002-command-palette | `UCommandPalette` groups API | v4 API differs significantly from v2 |
| eval-003-theme-customization | `@theme` directive + `app.config.ts` | v4 CSS-first theming replaces config-based |

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

## Expected outcome

| Doc source | Expected pass rate | Reasoning |
|---|---|---|
| base | Low | v4 chat components not in training data |
| llms.txt | Medium | Overview helps but lacks API details |
| llms-full.txt | High | Complete API docs, LLM-optimized |
| github-docs | Medium-High | Complete but unstructured, requires navigation |

## Results

Results saved to `results/<experiment>/<timestamp>/<eval>/` with:
- `summary.json` — pass rate, run count, duration
- `run-N/result.json` — per-run pass/fail
- `run-N/transcript.json` — full agent conversation
