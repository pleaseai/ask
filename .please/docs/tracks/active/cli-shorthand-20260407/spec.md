# Spec: CLI 식별자 문법 확장 (owner/repo 직행 + @version)

## 배경

현재 `ask docs add <name>`은 항상 ASK Registry lookup을 거치며, 레지스트리에 등록되지 않은 라이브러리는 `--source` 플래그를 명시해야만 동작한다. 사용자는 GitHub repo URL을 알고 있어도 즉시 사용할 수 없다.

비교 대상 분석:
- **skills.sh**: `npx skills add vercel-labs/agent-skills` — owner/repo가 곧 식별자, 별도 lookup 없음
- **unpkg**: `unpkg.com/preact@10.5.0/...` — semver/dist-tag/full-version 모두 지원
- **cdnjs**: 큐레이션 기반, 새 라이브러리 추가가 느려지는 단점

## 목표

CLI가 다음 식별자를 모두 받아들이도록 한다:

```bash
ask docs add vercel/next.js                # github 직행 (레지스트리 무관)
ask docs add vercel/next.js@canary         # tag/branch 지원
ask docs add vercel/next.js@v15.0.0        # git tag
ask docs add npm:next                      # ecosystem prefix (현행 유지)
ask docs add npm:next@^15                  # semver range (신규)
ask docs add next                          # 레지스트리 alias lookup (현행 유지)
```

## User Stories

- **US-1**: 레지스트리에 없는 라이브러리도 `owner/repo`만 알면 즉시 docs 다운로드 가능
- **US-2**: 특정 git tag 또는 branch의 docs를 명시적으로 받을 수 있음
- **US-3**: npm dist-tag(`canary`, `next`)와 semver range를 ecosystem prefix와 함께 사용 가능
- **US-4**: 기존 `name` 단독 입력은 그대로 동작 (backward compatible)

## Functional Requirements

- **FR-1**: `parseSpec(input)` 함수가 다음 형태를 구별해 파싱한다:
  1. `owner/repo[@ref]` — 슬래시 1개, 콜론 없음 → github 직행
  2. `ecosystem:name[@version]` — 콜론 prefix → 레지스트리 lookup
  3. `name[@version]` — 단순 이름 → 레지스트리 lookup
- **FR-2**: github 직행 모드는 `getSource('github', { repo, tag?, branch? })`로 즉시 위임. 레지스트리 호출하지 않음.
- **FR-3**: `@ref`는 git tag 우선, branch fallback (둘 다 시도). 명시적 구분 없음 — github API가 결정.
- **FR-4**: ecosystem prefix가 있는 경우 `@version`은 해당 ecosystem의 버전 해석기로 전달 (FR는 본 트랙 범위 밖, 다음 track에서 처리).
- **FR-5**: 잘못된 형식(슬래시 2개 이상, 빈 owner/repo)은 명확한 에러 메시지 출력.

## Non-Functional Requirements

- **NFR-1**: 기존 `add next`, `add npm:next` 입력의 동작은 변경되지 않는다.
- **NFR-2**: 신규 파싱 로직은 단위 테스트로 100% 분기 커버.
- **NFR-3**: 레지스트리 미사용 경로는 네트워크 호출이 0회 (github API 호출 제외).

## Success Criteria

- **SC-1**: `ask docs add vercel/next.js` 실행 시 레지스트리 fetch 로그 없이 github source가 곧바로 동작
- **SC-2**: `ask docs add vercel/next.js@v15.0.0` 실행 시 해당 tag의 tarball 다운로드
- **SC-3**: 기존 6개 레지스트리 엔트리(`add next`, `add npm:zod` 등) 모두 동작 회귀 없음
- **SC-4**: 잘못된 형식 입력에 대한 에러 메시지가 사용자에게 실행 가능한 가이드 제공

## Out of Scope

- npm/pypi/pub 메타데이터 fallback resolver (별도 track: `ecosystem-resolvers`)
- Registry 스키마 변경 (별도 track: `registry-meta`)
- Web source의 URL 직행 모드
