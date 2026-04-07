# Plan: CLI 식별자 문법 확장

## Architecture

`packages/cli/src/registry.ts`의 `parseEcosystem`을 확장한 `parseDocSpec` 함수로 교체. 결과 타입을 union으로 분리:

```ts
type ParsedDocSpec =
  | { kind: 'github', owner: string, repo: string, ref?: string }
  | { kind: 'ecosystem', ecosystem: string, name: string, version: string }
  | { kind: 'name', name: string, version: string }
```

> **이름 충돌 주의**: `packages/cli/src/index.ts`에 이미 `parseSpec(spec): { name, version }`라는 로컬 함수가 있다 (line 76). 본 track에서 신규 export는 `parseDocSpec`로 명명하고, 기존 로컬 `parseSpec`은 그대로 두거나 호출부 전부를 마이그레이션하면서 함께 제거한다. 이름 충돌 방지가 T-2의 핵심 작업.

`src/index.ts`의 `add` 명령은 파싱 결과의 `kind`로 분기:
- `github` → `getSource('github').fetch({ source: 'github', repo: 'owner/repo', tag: ref, name, version })` 직행, 레지스트리 호출 생략
- `ecosystem` / `name` → 기존 `resolveFromRegistry` 경로

(`getSource(type)`는 단일 인자, 실제 config는 반환된 `DocSource.fetch(options)`에 전달. `packages/cli/src/sources/index.ts:54` 참고.)

## Files

| 변경 | 파일 | 내용 |
|---|---|---|
| Modify | `packages/cli/src/registry.ts` | `parseEcosystem` → `parseSpec`로 확장. union 타입, github/ecosystem/name 분기 |
| Modify | `packages/cli/src/index.ts` | `add` 명령에서 `parseSpec` 호출, `kind === 'github'`이면 레지스트리 lookup 건너뛰기 |
| Add | `packages/cli/test/registry.test.ts` | `parseSpec` 단위 테스트 — 각 kind별 케이스, 에러 케이스 |
| Modify | `packages/cli/README.md` | 신규 식별자 문법 예시 추가 |

## Tasks

- **T-1** [test] `parseDocSpec` 함수 단위 테스트 작성 — github/ecosystem/name 각 분기 + invalid 입력
- **T-2** [impl] `parseDocSpec` 함수 구현, `parseEcosystem` 호출자 마이그레이션, `index.ts` 로컬 `parseSpec`과의 이름 충돌 정리 (기존 로컬 함수 제거 또는 `parseNameVersion`으로 리네임)
- **T-3** [impl] `add` 명령에서 github 직행 분기 추가, `getSource('github').fetch(...)` 직접 호출, 레지스트리 lookup skip 경로
- **T-4** [test] e2e 스모크 테스트 — `ask docs add vercel/next.js` (실제 네트워크) 또는 mock으로 검증
- **T-5** [docs] README에 신규 문법 섹션 추가
- **T-6** [chore] 회귀 테스트 — 기존 6개 엔트리 add 동작 확인

## Risks

- `owner/repo` 패턴이 향후 alias(`org/team-name`)와 충돌할 가능성 → 슬래시 1개 + 콜론 없음으로 엄격히 제한
- `@ref`가 npm dist-tag(`@canary`)와 형태가 같음 → github 모드에서는 항상 git ref로 해석. ecosystem 모드와 충돌 없음 (prefix로 분리됨)

## Dependencies

- 없음. 독립 실행 가능.
- `registry-meta-20260407`, `ecosystem-resolvers-20260407` track과 병렬 진행 가능.
