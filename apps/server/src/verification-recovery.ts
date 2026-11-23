export function verificationRecovery(previous?: {
  runId: string;
  results: Record<string, string>;
}) {
  if (!previous) return;
  const receipt = previous.results['verified-commit.md'] ?? '';
  const observed =
    previous.results['change-evidence.md'] ??
    previous.results['session-review.md'];
  if (
    !observed ||
    receipt.startsWith('작업 브랜치 커밋 ·') ||
    !/(?:기준 화면|전후 (?:비교|캡처)|화면 캡처|브라우저 검증|화면 검증).{0,65}(?:0\s*\/\s*2|못|실패|미확보|미검증|미완료|미확인)/s.test(
      observed + ' ' + receipt,
    )
  )
    return;
  const stages = [
    ['QA 서버 기동', /listen EPERM|EADDRINUSE|서버 기동 실패/i],
    ['브라우저 시작', /Mach 포트|browserType.launch|Chromium.{0,24}실행 실패/i],
    ['페이지 접속', /ECONNREFUSED|ERR_CONNECTION|page.goto:|접속 실패/i],
    ['대상 요소 탐색', /locator\..{0,80}timeout|요소 탐색 실패/i],
    ['캡처', /page.screenshot:|캡처 실패/i],
  ] as const;
  const failures = stages.flatMap(([stage, pattern]) => {
    const line = observed.split('\n').find((s) => pattern.test(s));
    return line ? [{ stage, evidence: line.slice(0, 500) }] : [];
  });
  return {
    sourceRun: previous.runId,
    resumeAt: failures[0]?.stage ?? '최초 실패 단계 확인',
    failures,
    originalEvidence: observed,
    action:
      '새 과제를 선택하기 전에 직전 과제의 QA 실행 환경을 복구한다. 실패가 확인된 첫 단계부터 점검하고 이미 차단된 명령의 단순 재시도를 피한다. QA 전용 주소에서 서버 기동, 페이지 접속, 대상 요소 탐색, 캡처 결과를 단계별로 기록한다. 원래 과제의 1440px와 390px 기준 화면을 확보한 뒤 동일 조작으로 수정 후 화면을 비교한다.',
  };
}
