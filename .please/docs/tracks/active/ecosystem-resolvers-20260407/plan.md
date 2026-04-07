# Plan: Ecosystem Resolver 도입

## Architecture

resolver는 source와 직교하는 새 레이어. 호출 흐름:

```
ask docs add npm:lodash
  └→ parseSpec → { kind: 'ecosystem', ecosystem: 'npm', name: 'lodash', version: 'latest' }
       └→ registry lookup (있으면 사용)
       └→ 없으면 getResolver('npm').resolve('lodash', 'latest')
            └→ fetch https://registry.npmjs.org/lodash
            └→ extract repository.url → 'lodash/lodash'
            └→ resolve version → '4.17.21' → tag 'v4.17.21' or '4.17.21'
       └→ getSource('github', { repo: 'lodash/lodash', tag: '4.17.21' }).fetch()
```

## Files

| 변경 | 파일 | 내용 |
|---|---|---|
| Add | `packages/cli/src/resolvers/index.ts` | `EcosystemResolver` interface, `getResolver` factory |
| Add | `packages/cli/src/resolvers/npm.ts` | npm registry API resolver |
| Add | `packages/cli/src/resolvers/pypi.ts` | PyPI JSON API resolver |
| Add | `packages/cli/src/resolvers/pub.ts` | pub.dev API resolver |
| Add | `packages/cli/src/resolvers/utils.ts` | `parseRepoUrl(url)` — git+https://github.com/foo/bar.git → foo/bar |
| Modify | `packages/cli/src/index.ts` | `add` 명령에서 ecosystem prefix 분기에 resolver 추가 (registry miss fallback) |
| Add | `packages/cli/test/resolvers/npm.test.ts` | mock fetch로 단위 테스트 |
| Add | `packages/cli/test/resolvers/pypi.test.ts` | 동일 |
| Add | `packages/cli/test/resolvers/pub.test.ts` | 동일 |
| Modify | `packages/cli/README.md` | 신규 ecosystem 지원 표 |

## Tasks

- **T-1** [impl] `EcosystemResolver` interface + `parseRepoUrl` 유틸 + 단위 테스트
- **T-2** [impl] npm resolver — registry API + dist-tags + semver 해석
- **T-3** [impl] pypi resolver — project_urls 추출 + PEP 440
- **T-4** [impl] pub resolver — pubspec.repository 추출
- **T-5** [test] 각 resolver 단위 테스트 (mock fetch)
- **T-6** [impl] `add` 명령 통합 — registry miss 시 resolver fallback
- **T-7** [test] e2e 스모크 — `ask docs add npm:lodash`, `pub:riverpod`
- **T-8** [docs] README 업데이트
- **T-9** [chore] 회귀 — 기존 `npm:next` 동작 (registry hit) 확인

## Risks

- 패키지의 `repository` 필드가 누락되거나 부정확한 경우 → 명확한 에러 메시지, 사용자에게 `owner/repo` 직접 입력 안내
- git tag 명명 규칙 불일치 (`v1.0.0` vs `1.0.0`) → 두 형태 모두 시도, github API 404 시 fallback
- semver range 해석 라이브러리 의존 — `semver` 패키지 추가 검토

## Dependencies

- **Soft dependency**: `cli-shorthand-20260407` — github 직행 코드 경로가 먼저 정리되면 resolver가 그 경로를 재사용할 수 있어 자연스러움. 병렬 진행도 가능하지만 cli-shorthand가 먼저 merge되는 것을 권장.
- **Soft dependency**: `registry-meta-20260407` — 신규 `repo` top-level 필드가 있으면 resolver의 결과를 그대로 레지스트리에 등록하기 쉬움 (후속 작업 연결고리).
