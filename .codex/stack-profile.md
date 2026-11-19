# Stack Profile: Agent Workflow Studio

> 사용자 확정 방향: 앱은 모델 API 직접 호출·API 키 설정·SDK 기반 실행을 사용하지 않는다. 기존 Claude Code·Codex 도구 연결은 허용된 제품 방향이다. 공식 로그인·권한 경로를 사용하고 숨긴 키·프록시로 API 방식에 우회 연결하지 않는다. 도구 내부 서비스 통신은 완전 오프라인과 구분한다. API 도입은 사용자의 별도 명시 요청 전까지 절대 금지한다.

2026-11-16 초기 저장소 확인 기준이다. 작업 시 package.json·잠금 파일·실제 코드를 다시 확인한다.

## Stack

| 영역      | 현재 구성                                                                    |
| --------- | ---------------------------------------------------------------------------- |
| 런타임    | Node 26.13.1, npm workspaces, TypeScript 6.0.3 strict, ESM                   |
| 웹        | React 19, Vite 8, React Flow 12, CSS Modules                                 |
| 서버      | Fastify 5, @fastify/static, better-sqlite3 13                                |
| 공통 계약 | Zod 4, @studio/contracts                                                     |
| 과거 설치 | @anthropic-ai/claude-agent-sdk 0.3.325 설치, 사용 중단, CLI 연결로 대체 예정 |
| 검증      | Vitest 5, Playwright, tsc, ESLint, Prettier                                  |

TypeScript 7은 초기 설치 당시 typescript-eslint의 지원 범위를 벗어나 6.0.3으로 고정했다. 업그레이드 시 peer dependency와 실제 검사를 확인한다. 프런트 비밀키를 VITE_* 변수에 넣지 않는다.

## Path Mapping

| 대상               | 실제 경로                                            |
| ------------------ | ---------------------------------------------------- |
| 웹 진입과 작업실   | apps/web/src/main.tsx, apps/web/src/App.tsx          |
| 스타일             | apps/web/src/App.module.css, apps/web/src/global.css |
| 개발 프록시        | apps/web/vite.config.ts                              |
| 서버 조립·현재 API | apps/server/src/app.ts                               |
| 서버 시작·종료     | apps/server/src/index.ts                             |
| 공통 응답 스키마   | packages/contracts/src/index.ts                      |
| 서버 검사          | apps/server/test/app.test.ts                         |
| 브라우저 검사      | e2e/studio.spec.ts, playwright.config.ts             |
| 테스트 설정        | vitest.config.ts, tsconfig.json                      |
| 로컬 데이터        | .local/studio.sqlite, Git 제외                       |

현재 `/api/health`와 스키마 버전 메타데이터만 있다. 작업 정의 저장, 실행기, 승인, SSE, 파일 접근 API는 아직 구현되지 않았다. 향후 경로를 이미 존재하는 모듈처럼 참조하지 않는다.

## Commands

루트에서 `nvm use` 후 실행한다. 설치는 `npm ci`를 사용한다. 공통 패키지 빌드는 루트 스크립트가 먼저 처리한다.

| 명령                 | 목적                                |
| -------------------- | ----------------------------------- |
| npm run dev          | contracts 감시, tsx 서버, Vite 실행 |
| npm run build        | 공통 계약 → 서버 → 웹 빌드          |
| npm start            | 빌드된 서버·웹 실행                 |
| npm run typecheck    | 작업 공간과 테스트 타입 검사        |
| npm run lint         | ESLint                              |
| npm test             | Vitest 서버 검사                    |
| npm run test:e2e     | 빌드 후 Chromium 통합 검사          |
| npm run format:check | Prettier 형식 검사                  |

Playwright 브라우저가 없으면 `npx playwright install chromium`으로 설치한다. 개발 화면은 127.0.0.1:5173, API·빌드 화면은 127.0.0.1:4310이다. Playwright는 별도 서버를 시작하며 기존 서버 재사용을 허용하지 않는다. 4310 사용 시 소유 프로세스를 확인하고 임의로 다른 서버를 종료하지 않는다.

## Naming and Boundaries

- 컴포넌트는 PascalCase, 훅은 useName, 서버 로컬 ESM import는 기존 `.js` 확장자 관례를 따른다.
- 공통 계약 수정 시 웹 호출부·서버·저장·테스트를 함께 확인한다.
- 현재 React 상태와 CSS Modules를 우선한다. 필요 없이 상태 라이브러리·ORM·큐·게임 엔진을 추가하지 않는다.
- 로컬 서버가 실행 상태의 기준이며 UI는 그 상태를 표시한다.

## High-Risk Areas

실행·승인 중복 방지, 정의 버전 고정, 파일 경계와 비밀정보, 중단·프로세스 종료, 결과 파일 보존, SQLite 쓰기 실패, 생성 콘텐츠 미리보기 격리를 우선 확인한다. 실제 도구 행동의 결과가 불확실하면 성공·실패를 추측하지 않고 미확인 상태를 보존한다.

## 수정된 연결 스택

Node child_process로 기존 CLI 하나부터 연결하고 stdout의 구조화된 이벤트와 실행별 결과 파일을 수집한다. Fastify·React Flow·SQLite·Zod를 사용한다. 내부 HTTP는 브라우저와 로컬 서버 간 통신이다. 실제 CLI 승인·중단·로그인 동작은 T01에서 확인한다. 세부 계획은 [T01](../apps/server/T01.md)을 따른다.
