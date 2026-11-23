# 내 워크플로 선택 직후 상세 확인

기준 커밋은 `523cd311200b6b5ba2cb7c5359d90bb07cb76d01`이다. 재개 시 남아 있던 선택 상세 수정과 검증 자료를 확인하고 데스크톱 변경 후 검사를 마쳤다. 직전 회차의 빈 보관함 수정과 스테이징 상태를 보존했다. 이번 회차 변경은 미커밋 상태다.

## 검증 조건

- 검사용 주소 `http://127.0.0.1:4310/#/library`에서 Chromium을 390×844px와 1440×900px로 열고 `주간 회의록` v1, `월간 정산` v3 순서로 선택했다. 각 선택 후 제목·목적·저장 버전을 합성 자료와 대조했다.
- 기본 조건은 합성 워크플로 두 건과 짧은 목적을 사용했다. 재현 조건은 합성 워크플로 여덟 건을 추가하고 `월간 정산`의 목적을 690자로 늘렸다. 같은 조건을 변경 전후에 사용했다.
- 브라우저 요청을 Fastify 요청 주입에 연결하고 임시 SQLite를 사용했다. 제공자 실행을 비활성화한 검사용 앱에서 검사했다. [검사 스크립트](.local/library-selection.mjs)

## 변경 전

- 390px 기본 조건에서는 두 항목 모두 세 값을 한 화면에서 읽을 수 있었다. 재현 조건에서 `월간 정산`을 선택하면 제목과 `저장 v3`는 보였으나, 목적의 끝은 화면 아래로 내려가 스크롤이 필요했다. [390px 기본](.local/library-selection/before-basic-390-1.png) · [390px 재현](.local/library-selection/before-390-1.png)
- 1440px에서는 기본 조건과 재현 조건 모두 두 항목의 제목·목적·저장 버전이 선택 직후 보였다. [1440px 재현](.local/library-selection/before-1440-1.png) · [변경 전 측정](.local/library-selection/before.log)

## 변경 후

- 좁은 화면에서 목록 항목을 직접 선택하면 해당 버전의 상세가 준비된 뒤 요약의 위치를 확인한다. 요약이 화면 밖으로 걸치면 포커스와 스크롤을 요약으로 이동한다. [WorkflowLibrary.tsx](apps/web/src/WorkflowLibrary.tsx#L352)
- 390px에서는 두 조건 모두 두 항목의 제목·목적·저장 버전이 추가 조작 없이 보였다. 재현 조건의 `월간 정산` 목적이 차지한 세로 좌표는 변경 전 569–920px에서 변경 후 150–501px로 이동했다. [390px 회의록](.local/library-selection/after-390-0.png) · [390px 정산](.local/library-selection/after-390-1.png) · [모바일 측정](.local/library-selection/after.log)
- 1440px에서는 두 조건 모두 두 항목의 세 값이 계속 보였다. 긴 목적의 위치도 변경 전후 153–309px로 같았다. [1440px 회의록](.local/library-selection/after-1440-0.png) · [1440px 정산](.local/library-selection/after-1440-1.png) · [데스크톱 재검사](.local/library-selection/after-desktop-retry.log)

## 검사 결과와 남은 범위

- 직전 시도의 타입 검사·린트·빌드 로그를 확인했다. 빌드에는 Vite 번들 크기 경고가 있다. 대상 Vitest 검사 2파일 7건이 통과했다. [타입 검사](.local/library-selection/typecheck.log) · [린트](.local/library-selection/lint.log) · [빌드](.local/library-selection/build-after.log) · [Vitest](.local/library-selection/vitest.log)
- 현재 환경의 루프백 리스닝은 `listen EPERM`으로 차단됐다. Chromium 시작 시 `/tmp`에 임시 디렉터리를 만들지 못한 오류는 작업 폴더 아래의 쓰기 가능한 경로를 지정해 해결했다. 기존 SQLite 바이너리로 검사했으며 직전 네이티브 재빌드 차단 원인은 미확인이다. [Chromium 초기 오류](.local/library-selection/after-desktop.log)
- 리스닝 서버를 거치는 검사, 전체 테스트, 사용자 참여 검증은 이번 회차에 미실시다. 확인한 합성 자료의 범위에서 선택 상세 기준을 충족했다. 다음 회차는 두 화면 폭에서 `흐름 편집`을 열어 편집 대상의 제목과 버전을 대조하는 것부터 시작한다. 올바른 자료를 골라 실행하는 행동도 검증 범위에 남아 있다.

---

# 직전 회차 기록 — 내 워크플로의 빈 보관함 안내

기준 커밋은 `523cd311200b6b5ba2cb7c5359d90bb07cb76d01`이다. 재개 시 남아 있던 [WorkflowLibrary.tsx](apps/web/src/WorkflowLibrary.tsx#L234)의 변경을 보존했다. 선택한 위치의 항목을 먼저 구한 뒤 검색어를 적용하므로 빈 보관함과 검색 불일치를 구분할 수 있다.

## 검증 조건

- Chromium의 `#/library`에서 390×844px와 데스크톱 1440×900px를 확인했다.
- `qa/workflow.json`의 합성 정의로 임시 SQLite에 활성 항목 하나를 만들고 검색 입력을 비운 상태에서 보관함을 선택했다.
- [검사 스크립트](.local/library-check.mjs)는 지정된 검사용 주소의 브라우저 요청을 Fastify `inject`에 연결한다. 운영 실행은 조작하지 않았다.
- 재개 시 직전 시도의 브라우저 캡처 8장을 직접 대조했다. 캡처와 스크립트는 로컬 작업 폴더의 `.local`에 있다.

## 변경 전

- 두 화면에서 빈 보관함을 열자 검색어가 비어 있어도 `검색 결과가 없습니다.`가 표시됐다. [390px](.local/library-evidence/before-390.png) · [1440px](.local/library-evidence/before-1440.png)

## 변경 후

- 동일한 조건에서 두 화면 모두 `보관한 워크플로가 없습니다.`가 표시됐다. 사용자는 보관함을 열어 보관한 항목이 없는 상태를 바로 확인할 수 있다. [390px](.local/library-evidence/after-390.png) · [1440px](.local/library-evidence/after-1440.png)
- 임시 저장소의 항목을 보관한 뒤 일치하지 않는 검색어를 입력하자 두 화면 모두 `검색 결과가 없습니다.`가 표시됐다. [390px](.local/library-evidence/search-390.png) · [1440px](.local/library-evidence/search-1440.png)
- 검색어를 지우자 두 화면 모두 보관 항목이 다시 표시됐다. [390px](.local/library-evidence/cleared-390.png) · [1440px](.local/library-evidence/cleared-1440.png)

## 검사 결과와 남은 범위

- `npm run typecheck`, `npm run lint`, `npm run build`가 통과했다. 빌드에서 Vite 번들 크기 경고가 발생했다.
- 직전 오프라인 설치 로그에서 `zwitch` 캐시 누락에 따른 `ENOTCACHED`를 확인했다. 남아 있는 의존성으로 검사했다. 직전 브라우저 권한 및 네이티브 재빌드 차단의 구체적 원인은 확인할 수 있는 오류 기록이 없어 미확인이다.
- 리스닝 서버를 거치는 전체 Playwright 검사와 사용자 참여 검증은 미실시다.
- 다음 회차에는 합성 워크플로를 선택하고 상세에서 목적과 저장 버전을 함께 파악할 수 있는지 두 화면 폭에서 확인한다. 편집 진입과 실행 자료 확인도 전체 미션의 남은 범위다.
