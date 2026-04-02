---
name: next
ecosystem: npm
description: Vercel의 React 프레임워크
strategies:
  - source: npm
    package: next
    docsPath: dist/docs
  - source: github
    repo: vercel/next.js
    docsPath: docs
tags: [react, framework, ssr, vercel]
---

# Next.js

Vercel이 만든 React 프레임워크. `canary` 버전부터 `dist/docs`에 공식 문서가 포함되어 배포됩니다.

## 버전별 참고
- `canary`: 최신 기능, npm `dist/docs` 경로 권장
- `latest`: 안정 버전, GitHub docs 경로 권장
