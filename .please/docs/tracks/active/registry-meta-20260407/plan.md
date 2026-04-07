# Plan: Registry 스키마 메타데이터 보강

## Architecture

레지스트리 스키마와 CLI/API 양쪽의 strategy resolution 로직을 동시에 손본다. 핵심은 `expandStrategies`라는 순수 함수를 공유 모듈로 분리해 양쪽에서 동일한 결과를 보장하는 것.

```
apps/registry/content.config.ts        # zod schema 확장
packages/shared/src/registry-schema.ts # 신규: 공유 타입 + expandStrategies (또는 cli/registry.ts에 두고 import)
apps/registry/server/api/...           # API 응답 시 expand 적용
packages/cli/src/registry.ts           # CLI fetch 시에도 expand 적용 (서버가 이미 했지만 방어적으로)
```

워크스페이스에 `packages/shared`가 없으면, 우선 `packages/cli/src/registry-schema.ts`에 두고 registry app이 상대 import 하거나 복제. 단일 monorepo이므로 path import 가능.

## Files

| 변경 | 파일 | 내용 |
|---|---|---|
| Modify | `apps/registry/content.config.ts` | schema에 `repo`, `homepage`, `license`, `docsPath` 추가, refinement |
| Add | `packages/cli/src/registry-schema.ts` | `expandStrategies(entry)` 공유 함수 + 타입 |
| Modify | `packages/cli/src/registry.ts` | 응답 파싱 후 `expandStrategies` 호출 |
| Modify | `apps/registry/server/api/registry/[ecosystem]/[name].get.ts` | 응답 직전 expand |
| Modify | `apps/registry/content/registry/npm/zod.md` | `repo: colinhacks/zod` 추가, strategies 단순화 |
| Modify | `apps/registry/content/registry/npm/next.md` | `repo: vercel/next.js` 추가 |
| Modify | `apps/registry/content/registry/npm/nuxt.md` | 동일 |
| Modify | `apps/registry/content/registry/npm/nuxt-ui.md` | 동일 |
| Modify | `apps/registry/content/registry/npm/tailwindcss.md` | `homepage`, `license` 추가 |
| Modify | `apps/registry/content/registry/pypi/fastapi.md` | `repo: fastapi/fastapi` 추가 |
| Add | `packages/cli/test/registry-schema.test.ts` | `expandStrategies` 단위 테스트 |

## Tasks

- **T-1** [impl] `expandStrategies` 함수 + 타입 정의
- **T-2** [test] `expandStrategies` 단위 테스트 — repo만 / strategies만 / 둘 다 / 둘 다 없음(에러)
- **T-3** [impl] `content.config.ts` schema 확장 + zod refinement
- **T-4** [impl] registry API 응답 시 expand 적용
- **T-5** [impl] CLI `resolveFromRegistry`에서 expand 적용 (방어적)
- **T-6** [chore] 6개 기존 엔트리 마이그레이션
- **T-7** [test] `bun run --cwd apps/registry build` 통과 확인
- **T-8** [test] CLI 회귀 테스트 — 기존 엔트리 add 동작 확인

## Risks

- registry API 응답 형태 변경으로 캐시된 클라이언트가 깨질 위험 → `strategies`를 항상 포함해 호환성 유지
- zod refinement가 build 단계에서만 검증 → CI에 build step 포함 확인 필요

## Dependencies

- 독립 실행 가능. `cli-shorthand`와 병렬 진행 가능.
- `ecosystem-resolvers` track에서 이 스키마를 활용하므로 그 track보다 먼저 또는 동시에 완료되는 것이 자연스러움.
