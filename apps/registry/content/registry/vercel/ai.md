---
name: Vercel AI SDK
description: TypeScript SDK for building AI-powered applications and agents
repo: vercel/ai
homepage: https://sdk.vercel.ai
license: Apache-2.0
tags:
  - ai
  - llm
  - sdk
  - agents
  - typescript
packages:
  - name: ai
    aliases:
      - ecosystem: npm
        name: ai
    sources:
      - type: npm
        package: ai
        path: dist/docs
      - type: github
        repo: vercel/ai
        path: content/docs
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
