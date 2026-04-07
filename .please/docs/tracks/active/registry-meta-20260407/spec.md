# Spec: Registry 스키마 메타데이터 보강

## 배경

현재 `apps/registry/content.config.ts` 스키마는 strategies 배열 중심이고, 단순 케이스(github에서 docs 한 경로만 가져오는)도 strategies를 명시해야 한다. 또한 cdnjs 같은 큐레이션 레지스트리가 제공하는 메타데이터(homepage, license, repository, autoupdate 추적 정보)가 없어 향후 검색/브라우징 UX 확장에 한계가 있다.

## 목표

레지스트리 엔트리에 다음을 추가하여 (a) 단순 케이스 작성을 간소화하고 (b) 검색/큐레이션 메타데이터를 풍부하게 만든다.

```yaml
---
name: next
ecosystem: npm
repo: vercel/next.js          # 신규 — github strategy의 기본값
homepage: https://nextjs.org  # 신규 (선택)
license: MIT                  # 신규 (선택)
docsPath: docs                # 신규 — strategies 없을 때 기본 경로
description: ...
strategies: []                # 비어있어도 OK — repo + docsPath로 자동 생성
tags: [react, ssr]
---
```

## User Stories

- **US-1**: 단순 github docs 라이브러리는 `repo` + `docsPath`만으로 등록 가능 (strategies 생략)
- **US-2**: 레지스트리 브라우저(`apps/registry`)가 homepage/license를 카드에 표시 가능
- **US-3**: 기존 strategies 기반 엔트리는 그대로 동작 (backward compatible)

## Functional Requirements

- **FR-1**: `content.config.ts`의 registry schema에 `repo`, `homepage`, `license`, `docsPath` optional 필드 추가
- **FR-2**: `strategies`가 비어있거나 누락된 경우, `repo`로부터 default github strategy를 자동 생성하는 helper(`expandStrategies`) 추가. 이를 위해 schema의 `strategies` 필드를 `z.array(strategySchema).optional().default([])`로 변경 필수.
- **FR-3**: `expandStrategies`는 CLI(`packages/cli/src/registry.ts`)와 registry API(`apps/registry/server/api/registry/...`) 양쪽에서 공유
- **FR-4**: 기존 6개 엔트리 마이그레이션 — 가능한 곳은 `repo` top-level로 단순화

## Non-Functional Requirements

- **NFR-1**: schema 변경은 zod refinement로 "strategies 또는 repo 중 하나는 필수" 검증
- **NFR-2**: registry build (Nuxt Content)가 마이그레이션 후에도 통과
- **NFR-3**: registry API 응답 형태 호환 — 기존 CLI 클라이언트가 깨지지 않도록 `strategies`는 항상 채워서 응답

## Success Criteria

- **SC-1**: `repo: vercel/next.js`만 적은 엔트리가 `bun run --cwd apps/registry build`를 통과
- **SC-2**: API 호출 시 자동 expand된 strategies가 응답에 포함
- **SC-3**: 기존 CLI(이전 버전)도 새 레지스트리 응답으로 계속 동작
- **SC-4**: 6개 엔트리 마이그레이션 완료, registry dev 서버에서 정상 표시

## Out of Scope

- `aliases` 필드 (별도 작업)
- `autoupdate` 자동 sync 로직 (메타 필드만 추가, 실제 sync 자동화는 별도)
- CLI 식별자 문법 (별도 track: `cli-shorthand`)
