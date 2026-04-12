# T011 Pre-Implementation Audits — A2 & A4

> Track: github-store-pm-unified-20260411
> Date: 2026-04-12
> Purpose: Validate the two assumptions from the idea doc that gate
> the decision to remove the shared bare-clone subsystem and enforce
> strict ref validation.

## A2 — Multi-tag installs of the same repo

**Assumption**: Users rarely install multiple tags of the same repo in one
project. Acceptable if the ratio is below ~5% of entries.

### Scope scanned
- All committed registry entries: `apps/registry/content/registry/**/*.md` (50 entries)
- All committed `ask.json` samples: `**/ask.json` excluding node_modules

### Results

| Source | Entries | Duplicate owner/repo with different ref |
|---|---|---|
| `apps/registry/content/registry/**/*.md` | 50 | 0 (refs not declared at registry level — refs are per-project in `ask.json`) |
| Committed `ask.json` samples | 1 (`example/ask.json`) | 0 (single entry, no ref) |

### Verdict
**Green.** Zero observed duplicate-ref entries in committed samples. The
assumption holds — removing the dedup layer (shared bare clone across
refs of the same repo) does not affect any current user. The plan's
follow-up note stands: if real-world data later shows significant
multi-tag usage, a hardlink/reflink dedup layer can be added without
further layout migration (the nested paths already support it).

## A4 — Mutable-ref heuristic false-positive rate

**Assumption**: The strict ref heuristic (accept 40-hex SHA, `v?<semver>`,
tag-like strings with `.` or digits; reject `main`/`master`/`develop`/
`trunk`/`HEAD`/`latest` and bare single-word refs) produces ≤ 1% false
positives on real refs.

### Scope scanned
All unique `ref:` values across:
- `packages/cli/test/**/*.test.ts` (test fixtures)
- Committed `ask.json` samples

### Results (16 unique refs)

| Ref | Heuristic verdict | Expected |
|---|---|---|
| `2.5.0` | accept | accept |
| `2.6.1` | accept | accept |
| `v0.0.0-nonexistent` | accept | accept |
| `v0.115.0` | accept | accept |
| `v1.0.0` | accept | accept |
| `v14.2.3` | accept | accept |
| `v15.0.0` | accept | accept |
| `v15.2.3` | accept | accept |
| `v17.0.0` | accept | accept |
| `v18.2.0` | accept | accept |
| `v18.3.0` | accept | accept |
| `v3.22.4` | accept | accept |
| `v33.4.0-jre` | accept | accept |
| `v4.17.21` | accept | accept |
| `canary` | reject | reject (negative test case) |
| `main` | reject | reject (negative test case) |

### Verdict
**Green.** 14/16 refs accepted — every real tag-like ref matched. The
two rejections (`main`, `canary`) are INTENDED negative cases used in
tests to verify the strict schema actually rejects mutable refs (or to
exercise `--allow-mutable-ref`). There are no false positives.

Real-world false-positive rate on committed non-test fixtures: 0/1 (the
single `example/ask.json` entry is PM-driven and has no ref).

### Edge cases noted but not blockers
- `release-2024.01` passes (contains a dot) ✓
- `r12345` passes (contains a digit) ✓
- Bare `1.0.0` without `v` prefix passes (tag fallback covers the clone
  side; see `cloneAtTag` in `sources/github.ts`).
