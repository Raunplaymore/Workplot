export type PendingRequest = {
  id: string;
  text: string;
  evidence: string;
  remaining: string;
};

export function requestContext(requests: PendingRequest[]) {
  if (!requests.length) return {};
  return {
    roundRequests: requests.map((r) => r.text),
    requestLedger: requests,
    roundRequestPolicy:
      '사용자 원문과 직전 근거·남은 질문을 현재 단계의 판단 기준으로 삼는다. 첫 계획에는 원문의 의도, 사용자가 관찰할 변화, 남은 질문을 확인할 방법을 적는다. 구현과 검토에서는 각 요청을 실제 결과와 대조한다. 일반 테스트 통과만으로 사용성 개선을 완료 처리하지 않는다. 마지막 인계문에 요청마다 아래 형식의 한 줄을 작성한다. evidence에 확인한 변화와 재확인할 수 있는 근거를, remaining에 미검증 항목과 다음 첫 행동을 적는다. 확인할 근거가 없으면 미확인으로 남긴다. 모두 확인한 경우에만 status를 done으로 쓰고 remaining을 비운다. 기존 역할·권한과 승인 절차를 따른다.',
    requestHandoffFormat:
      '요청 판정 {"id":"요청 ID","status":"open 또는 done","evidence":"확인된 변화와 근거","remaining":"남은 질문과 다음 행동"}',
  };
}

export function applyRequestHandoff(
  requests: PendingRequest[],
  document: string,
) {
  const reports = new Map<
    string,
    { done: boolean; evidence: string; remaining: string } | null
  >();
  for (const line of document.split(/\r?\n/)) {
    if (!line.startsWith('요청 판정 ')) continue;
    try {
      const row = JSON.parse(line.slice('요청 판정 '.length));
      if (
        !row ||
        typeof row.id !== 'string' ||
        typeof row.evidence !== 'string' ||
        typeof row.remaining !== 'string'
      )
        continue;
      const evidence = row.evidence.trim();
      const remaining = row.remaining.trim();
      const done = row.status === 'done';
      if (done ? !evidence || !!remaining : row.status !== 'open' || !remaining)
        continue;
      reports.set(
        row.id,
        reports.has(row.id) ? null : { done, evidence, remaining },
      );
    } catch {
      // A missing or unreadable verdict keeps the original request open.
    }
  }
  return requests.flatMap((request) => {
    const report = reports.get(request.id);
    if (!report) return [request];
    if (report.done) return [];
    return [
      {
        ...request,
        evidence: report.evidence || request.evidence,
        remaining: report.remaining,
      },
    ];
  });
}
