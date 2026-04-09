---
name: Next.js
description: The React framework by Vercel
repo: vercel/next.js
homepage: https://nextjs.org
license: MIT
tags:
  - react
  - framework
  - ssr
  - vercel
packages:
  - name: next
    aliases:
      - ecosystem: npm
        name: next
    sources:
      - type: npm
        package: next
        path: dist/docs
      - type: github
        repo: vercel/next.js
        path: docs
---

# Next.js

The React framework by Vercel. Starting from `canary`, official docs are bundled in `dist/docs`.

## Version notes
- `canary`: Latest features, use npm `dist/docs` path
- `latest`: Stable release, use GitHub docs path
