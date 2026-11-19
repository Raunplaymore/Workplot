# Workplot

프롬프트 설계가 낯선 사용자를 위한 브라우저 + 로컬 서버 기반 에이전트 작업실입니다.
브라우저에서 작업 흐름을 편집·저장하고 기존 Codex로 문서 작성, 검토 승인, 수정본 저장, 중단을 할 수 있습니다. [1차 개발 검증 기록](docs/phase-1/verification.md)

## 대시보드와 와이어 편집

첫 화면은 실행 현황입니다. 왼쪽 **흐름 설계**에서 예시를 편집하거나 **흐름 목록**에서 저장한 흐름을 엽니다. 저장한 버전을 실행하면 해당 실행의 문서·승인·중단 화면으로 이동합니다. 검토 대기 건은 현황에서 **검토 열기 → 검토할 문서 열기**로 들어갑니다. 오른쪽 패널에서 고정 버전의 단계와 최근 실행 로그를 확인할 수 있습니다. 편집기에서는 오른쪽 출력 단자를 다음 단계의 왼쪽 입력 단자로 연결합니다. 키보드로는 ‘다음 단계 연결’을 사용합니다. 연결을 바꾸면 업무 설계서가 갱신되며 모든 단계를 한 줄로 연결한 뒤 새 버전을 저장할 수 있습니다. 실행 중인 버전은 시작 시점의 흐름을 따릅니다.

## 실행

Node.js 26.13.1과 함께 제공되는 npm을 사용합니다. 기존 nvm에 설치한 후 이 폴더에서 실행하세요.

```sh
nvm use
npm ci
npm run dev
```

개발 화면: <http://127.0.0.1:5173>, 로컬 API: <http://127.0.0.1:4310/api/health>.
종료는 Ctrl+C입니다. 이미 실행 중인 서버가 있으면 해당 서버를 먼저 종료해야 합니다.

빌드한 화면과 API를 하나의 로컬 서버에서 실행하려면:

```sh
npm run build
npm start
```

이때 화면 주소는 <http://127.0.0.1:4310>입니다. 서버는 루프백 주소에서만 수신합니다.
SQLite는 저장소의 `.local/studio.sqlite`에 생성되며 Git에 포함되지 않습니다.
`/api/tools`는 서버의 PATH에서 고정된 `claude --version`, `codex --version`을 실행하고 서버 수명 동안 결과를 공유합니다. 새로 설치한 도구를 다시 감지하려면 서버를 재시작하세요. 실행할 때만 공식 Codex의 ChatGPT 로그인 상태를 확인합니다. 같은 실행 터미널의 PATH에서 `codex`가 확인되어야 합니다. 브라우저와 로컬 서버 사이의 저장 계약과 세션 검사는 [T02 작업 정의와 실행 기록 저장](apps/server/T02.md)에 정리했습니다.

## 구성

- `apps/web`: React 19, Vite 8, React Flow, CSS Modules
- `apps/server`: Fastify 5, SQLite/better-sqlite3, 기존 Codex CLI 연결과 작업 버전·실행 저장
- `packages/contracts`: Zod 공통 저장·응답 계약
- `e2e`: Playwright 브라우저 검사

공통 패키지를 먼저 빌드하도록 루트 명령에 순서가 설정되어 있습니다. `npm run dev`는 세 작업 공간의 변경을 감시합니다.
Node 버전은 `.nvmrc`, `.node-version`, `engines`에, 패키지 설치 결과는 `package-lock.json`에 고정합니다.

실행이 실패하면 대시보드에서 **실패 상세 열기 → 실패한 단계 다시 실행**을 누르세요. 같은 실행 ID와 워크플로 버전에서 해당 작업을 다시 시작합니다. 승인한 문서가 바뀌면 재실행이 차단됩니다. 재실행 정보가 저장되기 전에 만들어진 실패 기록은 조회할 수 있습니다.

## 검증

편집·실행·승인·중단을 한꺼번에 검증하려면 `npm run qa`를 실행하세요. 격리된 로컬 서버에서 브라우저 회귀 검사와 실제 Codex 검사를 순차 실행합니다. [QA 항목과 실행 조건](docs/phase-1/qa.md)

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npx playwright install chromium
npm run test:e2e
```

앱의 모델 API 직접 호출·API 키 설정·SDK 기반 실행을 사용하지 않습니다. 사용자가 선택한 기존 Claude Code·Codex 도구를 연결하는 방향입니다. [AGENTS.md](AGENTS.md)의 규칙을 따릅니다. 기존 API 연결 계획은 중단했고 실제 호출 경로를 제거했습니다.

[T01 로컬 검증](apps/server/T01.md)의 준비 명령은 외부 호출 없이 실행됩니다. `--live`는 차단됩니다. API 키·모델·예산 설정을 요구하지 않습니다. 기존 도구의 로그인은 공식 도구에서 처리하며, 내부 서비스 통신과 계정 사용 한도는 해당 도구에 따릅니다.

[기술 스택](https://chatgpt.com/space/page_f5d0380c832c81918ec26c4524328de3) · [과제 목록](https://chatgpt.com/space/page_4c85afd5a6a88191ad27f94aa9b68940)
