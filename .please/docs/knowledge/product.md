# Product Guide — ASK (Agent Skills Kit)

## Vision

ASK is an AI documentation platform that bridges the gap between version-specific library knowledge and AI coding agents. Developers configure documentation sources; AI agents consume accurate, up-to-date docs instead of relying on stale training data.

## Problem Statement

AI coding agents frequently hallucinate or reference outdated APIs because their training data lags behind library releases. Benchmarks (e.g., Next.js evals) show that providing version-specific documentation via `AGENTS.md` can improve agent accuracy from ~70% to 100%. However, manually assembling and maintaining these docs is tedious and error-prone.

## Target Users

1. **Developers** — configure ASK to download and manage library docs for their projects.
2. **AI coding agents** — consume generated `AGENTS.md` files and Claude Code skills to reference accurate, version-specific documentation.

## Core Value Proposition

One command (`ask install`) generates `AGENTS.md` with lazy documentation references — agents access docs on-demand via `ask src` / `ask docs`, turning any project into an AI-friendly workspace.

The lazy commands `ask src <spec>` and `ask docs <spec>` give coding agents on-demand documentation access: they print absolute paths to a cached source tree (and any documentation directories), fetching on cache miss. Both commands work via shell substitution, e.g. `rg "pattern" $(ask src react)`.

## Product Components

| Component | Purpose |
|---|---|
| **CLI** (`@pleaseai/ask`) | Downloads docs, generates AGENTS.md (+ opt-in Claude Code skills) |
| **Registry** (`apps/registry`) | Community-curated catalog of library doc configs |

## Long-term Vision

Evolve the ASK Registry into a full AI documentation platform — the go-to destination for AI-optimized documentation discovery and delivery across all ecosystems.

## Ecosystem Strategy

**npm-first**: Deep focus on the npm/Node.js ecosystem to establish quality and patterns before expanding to PyPI, Go, Rust, Dart, and others.

## Success Metrics

- Number of registry entries (library configs)
- CLI download/usage count
- Agent accuracy improvement with ASK-generated docs
- Community contributions to the registry
