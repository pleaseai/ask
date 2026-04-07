# Spec: Ecosystem Resolver 도입 (pub/npm/pypi → github 위임)

## 배경

현재 `packages/cli/src/sources/`는 `npm`, `github`, `web` 세 source가 각자 download까지 책임진다. 새 ecosystem(dart pub, cargo, go 등)을 추가하려면 매번 download 로직을 새로 작성해야 한다. 또한 레지스트리에 없는 npm/pub 패키지는 docs를 받을 방법이 없다.

핵심 통찰: 거의 모든 ecosystem은 패키지 메타데이터에 `repository` URL을 가지고 있다. 즉 **메타데이터 → github repo 추출 → github source로 위임**하는 resolver 패턴이면 download 로직을 재사용할 수 있다.

## 목표

ecosystem adapter를 "downloader"가 아닌 **resolver**로 재정의:

```ts
interface EcosystemResolver {
  resolve(name: string, version: string): Promise<{
    repo: string         // owner/repo
    ref: string          // git tag or branch
    resolvedVersion: string
  }>
}
```

지원 ecosystem:
- `npm` — `https://registry.npmjs.org/<name>` → `repository.url`
- `pypi` — `https://pypi.org/pypi/<name>/json` → `info.project_urls.Source`
- `pub` — `https://pub.dev/api/packages/<name>` → `latest.pubspec.repository`

resolver 결과는 항상 github source로 위임해 download.

## User Stories

- **US-1**: 레지스트리에 없는 npm 패키지(`ask docs add npm:lodash`)도 자동으로 github repo를 찾아 docs 다운로드
- **US-2**: dart 프로젝트(`pub:riverpod`)에서도 동일하게 동작
- **US-3**: 버전 해석은 ecosystem 규칙대로 (`npm:react@^18` → 18.x.x 최신 → 해당 git tag)

## Functional Requirements

- **FR-1**: `packages/cli/src/resolvers/` 디렉터리 신설, ecosystem별 resolver 구현
- **FR-2**: `getResolver(ecosystem)` 팩토리 함수
- **FR-3**: 각 resolver는 ecosystem별 메타 API에서 `repository` URL을 추출, `owner/repo` 정규화
- **FR-4**: 버전 해석 로직 — npm은 dist-tags + semver range, pypi는 PEP 440, pub은 caret syntax
- **FR-5**: 추출된 git ref는 다음 규칙으로 결정:
  1. ecosystem 메타에 명시적 git tag가 있으면 사용
  2. 없으면 `v{version}` 또는 `{version}` tag를 시도
  3. 둘 다 실패하면 default branch
- **FR-6**: `add` 명령은 ecosystem prefix가 있으면 resolver → github source 순으로 위임. 레지스트리 lookup은 1순위 그대로 유지.

## Non-Functional Requirements

- **NFR-1**: resolver 호출은 단일 fetch로 끝나야 함 (가능한 경우)
- **NFR-2**: resolver는 source와 분리된 모듈 — 단위 테스트 가능 (mock fetch)
- **NFR-3**: 기존 `sources/npm.ts`는 deprecate 예고 — 단, 회귀 없이 한 릴리스는 유지

## Success Criteria

- **SC-1**: `ask docs add npm:lodash` (레지스트리 미등록) 실행 시 lodash/lodash repo의 docs 다운로드
- **SC-2**: `ask docs add pub:riverpod` 실행 시 riverpod repo의 docs 다운로드
- **SC-3**: `ask docs add npm:next@^15` 실행 시 v15.x.x 최신 git tag의 tarball 다운로드
- **SC-4**: 기존 `npm` source 직접 사용 경로 회귀 없음

## Out of Scope

- cargo, go, hex, nuget resolver (구조만 만들고, 실제 구현은 후속)
- 레지스트리 등록 자동화 (resolver 결과를 레지스트리에 자동 등록하는 기능)
- web crawl resolver
