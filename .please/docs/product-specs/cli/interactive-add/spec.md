---
product_spec_domain: cli/interactive-add
---

# Interactive Add

> Track: interactive-add-20260412

## Overview

`ask add` 명령을 인자 없이 실행하면 interactive 모드로 진입하여 프로젝트 의존성을 기반으로 라이브러리를 추천하고, 사용자가 복수 라이브러리를 선택하거나 직접 입력하여 한번에 추가할 수 있는 기능을 구현합니다.

## Requirements

### Functional Requirements

- [ ] FR-1: `ask add` 을 인자 없이 실행하면 interactive 모드로 진입한다. 기존 `ask add <spec>` 동작은 그대로 유지한다.
- [ ] FR-2: Interactive 모드 진입 시 프로젝트 파일(package.json, pyproject.toml, go.mod, Cargo.toml 등)을 기반으로 ecosystem을 자동 감지한다. 기존 `detectEcosystem()` 로직을 재사용한다.
- [ ] FR-3: 감지된 ecosystem의 프로젝트 의존성(package.json dependencies, devDependencies 등)을 읽어, 아직 ask.json에 등록되지 않은 라이브러리를 추천 목록으로 표시한다.
- [ ] FR-4: 추천 목록에서 복수 라이브러리를 선택할 수 있다 (multi-select).
- [ ] FR-5: 추천 목록 외에 직접 spec을 텍스트로 입력할 수 있다 (예: `npm:lodash`, `github:owner/repo@v1`).
- [ ] FR-6: 선택된 모든 라이브러리를 ask.json에 추가하고, `runInstall`을 실행하여 AGENTS.md 및 SKILL.md를 생성한다.
- [ ] FR-7: 추천 시 ASK Registry에 등록된 라이브러리를 우선 표시하고, 미등록 라이브러리는 하단에 표시한다.

### Non-functional Requirements

- [ ] NFR-1: CI/non-TTY 환경에서는 interactive 모드가 실행되지 않고 에러 메시지와 함께 종료한다.
- [ ] NFR-2: 기존 citty + consola 프레임워크를 활용하여 interactive 프롬프트를 구현한다.
- [ ] NFR-3: Registry API 호출에 10초 timeout을 적용한다 (기존 `AbortSignal.timeout` 패턴).

## User Stories

- US-1: 나는 개발자로서 `ask add`를 실행하면, 프로젝트 의존성 중 등록되지 않은 라이브러리 목록을 보고 선택할 수 있다.
- US-2: 나는 개발자로서 추천에 없는 라이브러리도 직접 입력하여 추가할 수 있다.
- US-3: 나는 개발자로서 여러 라이브러리를 한번에 선택하여 배치로 추가할 수 있다.

## Acceptance Criteria

- [ ] AC-1: `ask add` (인자 없이) 실행 시 interactive prompt가 표시된다.
- [ ] AC-2: `ask add npm:next` (인자 있음) 실행 시 기존과 동일하게 작동한다.
- [ ] AC-3: npm 프로젝트에서 package.json 의존성 중 ask.json에 없는 항목이 추천된다.
- [ ] AC-4: 추천 목록에서 0개 이상 선택 후 confirm하면 ask.json에 추가 + install 실행.
- [ ] AC-5: non-TTY 환경에서 `ask add` (인자 없음) 실행 시 에러와 함께 종료된다.

## Out of Scope

- 기존 `ask add <spec>` 명령의 동작 변경
- 의존성 버전 선택 UI (lockfile resolved version 사용)
- PyPI, Go, Cargo 등 비-npm ecosystem의 의존성 스캔 (npm-first, 향후 확장)
- Registry 검색/필터링 UI (추천 목록만 제공)

## Assumptions

- `consola`의 `prompt()` API를 활용하여 interactive 프롬프트를 구현한다 (citty는 prompts 내장 미지원).
- ASK Registry API에서 등록 여부를 확인하는 batch endpoint가 없으면, 개별 조회 또는 로컬 매칭으로 대체한다.
- npm ecosystem 우선 구현 후 다른 ecosystem으로 확장 가능한 구조로 설계한다.
