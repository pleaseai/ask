---
name: Mastra
description: TypeScript framework for building AI agents, workflows, and RAG pipelines
repo: mastra-ai/mastra
homepage: https://mastra.ai
license: Apache-2.0
tags:
  - ai
  - agents
  - framework
  - typescript
  - rag
packages:
  - name: "@mastra/core"
    aliases:
      - ecosystem: npm
        name: "@mastra/core"
    sources:
      - type: npm
        package: "@mastra/core"
        path: dist/docs
      - type: github
        repo: mastra-ai/mastra
        path: docs
  - name: "@mastra/memory"
    aliases:
      - ecosystem: npm
        name: "@mastra/memory"
    sources:
      - type: npm
        package: "@mastra/memory"
        path: dist/docs
      - type: github
        repo: mastra-ai/mastra
        path: docs
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
