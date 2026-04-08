---
name: Mastra
description: TypeScript framework for building AI agents, workflows, and RAG pipelines
repo: mastra-ai/mastra
docsPath: docs
homepage: https://mastra.ai
license: Apache-2.0
aliases:
  - ecosystem: npm
    name: "@mastra/core"
  - ecosystem: npm
    name: "@mastra/memory"
strategies:
  - source: npm
    package: "@mastra/core"
    docsPath: dist/docs
  - source: npm
    package: "@mastra/memory"
    docsPath: dist/docs
  - source: github
    repo: mastra-ai/mastra
    docsPath: docs
tags: [ai, agents, framework, typescript, rag]
---

# Mastra

The TypeScript framework for building AI agents, workflows, RAG pipelines, and
evals. Multiple Mastra packages (`@mastra/core`, `@mastra/memory`, and others)
ship curated agent docs inside their npm tarballs at `dist/docs`, which ASK
prefers over the monorepo `docs` directory for the same reasons listed in the
`vercel/ai` entry.

## Scoped + monorepo handling

Mastra is a monorepo with several scoped packages. Each scoped package's
tarball is independent, so the npm strategy maps cleanly to one strategy per
scope. The GitHub strategy remains as a final fallback when neither package is
installed locally.
