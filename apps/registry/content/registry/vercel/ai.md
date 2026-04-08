---
name: Vercel AI SDK
description: TypeScript SDK for building AI-powered applications and agents
repo: vercel/ai
docsPath: dist/docs
homepage: https://sdk.vercel.ai
license: Apache-2.0
aliases:
  - ecosystem: npm
    name: ai
strategies:
  - source: npm
    package: ai
    docsPath: dist/docs
  - source: github
    repo: vercel/ai
    docsPath: content/docs
tags: [ai, llm, sdk, agents, typescript]
---

# Vercel AI SDK

TypeScript SDK for building AI-powered applications and agents from Vercel.
The published npm tarball ships curated agent docs in `dist/docs`, which the
ASK CLI prefers over the GitHub `content/docs` mirror because it (1) matches
the installed version exactly and (2) is already present in `node_modules`
for offline reads.

## Why npm strategy first

`vercel/ai` is one of the libraries that pioneered shipping agent-curated
documentation inside the npm tarball. The `dist/docs/` directory is generated
at publish time, version-pinned, and selected by the maintainers — it is the
authoritative source for AI agents using ASK.
