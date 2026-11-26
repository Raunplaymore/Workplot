const errorText: Record<string, string> = {
  promotion_changed:
    '승인 대상이 바뀌었거나 같은 브랜치에서 다른 요청을 처리 중입니다. 최신 후보를 확인하세요.',
  invalid_completion_goal:
    'Codex가 완성 목표와 합격 기준을 작성하지 못했습니다. 목표 다시 제안으로 재시도하세요.',
  invalid_workflow_link:
    '연결할 흐름은 작업으로 시작하고 끝나야 합니다. 자기 참조·중첩 호출·다음 세션 승인은 연결할 수 없고, 펼친 흐름은 고유한 ID의 32단계까지 지원합니다.',
  comparison_conflict:
    '비교 대상 문서나 저장 상태가 달라졌습니다. 화면을 다시 열어 확인하세요.',
  comparison_evidence:
    'Codex의 인용문을 문서에서 확인할 수 없습니다. 근거 대조를 다시 실행하세요.',
  skill_export_conflict:
    '이미 사용 중인 이름이거나 등록한 스킬이 변경됐습니다. 다른 이름을 선택하거나 최신 등록 상태를 확인하세요.',
  invalid_schedule: '예약 시각과 자료 파일명(.md 또는 .txt)을 확인하세요.',
  schedule_material:
    '필수 입력값이나 자료 파일(UTF-8, 최대 8,000자)을 확인하세요.',
  skill_selection: '입력창에서 $로 사용할 Codex 스킬 하나를 골라 주세요.',
  skill_catalog:
    '로컬 Codex에서 스킬을 읽지 못했습니다. Codex 설치와 실행 환경을 확인하세요.',
  skill_changed:
    '스킬 지침이 변경되었습니다. 창을 닫고 스킬을 다시 선택하세요.',
  invalid_node: '단계 제목, 작업 지침과 흐름 연결을 확인하세요.',
  invalid_node_fit:
    '입력 자료에 맞는 제안을 만들지 못했습니다. 필요한 자료와 삽입 위치를 확인한 뒤 다시 시도하세요.',
  invalid_match: '내 워크플로를 탐색하지 못했습니다. 다시 시도하세요.',
  invalid_proposal:
    'Codex가 유효한 변경안을 만들지 못했습니다. 요청을 구체화해 다시 시도하세요.',
  rerun_conflict:
    '재실행할 수 없습니다. 다른 실행이 진행 중이거나 저장 버전 또는 선행 문서가 달라졌는지 확인하세요.',
  retry_slot_busy:
    '실행 슬롯이나 같은 작업 폴더를 사용 중입니다. 실행 현황에서 확인한 뒤 실패 단계만 다시 시도하세요.',
  retry_conflict:
    '재실행 조건이 달라졌습니다. 실행 상태와 이전 결과 문서를 확인하세요.',
  stale_version:
    '다른 변경이 먼저 저장됐습니다. 작업 목록에서 최신 버전을 다시 여세요.',
  missing_material: '이번 실행에 필요한 자료를 입력하세요.',
  quota: '한도 대기 · Codex 사용 한도에 도달했습니다.',
  login: '터미널에서 Codex의 ChatGPT 로그인을 확인하세요.',
  cli: '로컬 서버가 Codex를 찾지 못했습니다. 설치와 서버 실행 환경을 확인하세요.',
  output: '실행할 작업 단계와 Codex 담당자 설정을 확인하세요.',
  not_found: '기록이나 결과 파일을 찾을 수 없습니다.',
};

export class LocalRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function send(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError && !init.signal?.aborted)
      throw new TypeError(
        '로컬 서버 응답을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.',
        { cause: error },
      );
    throw error;
  }
}
export async function localRequest(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
) {
  const init: RequestInit = {
    method,
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  let response = await send('/api' + path, init);
  if (response.status === 401) {
    const session = await send('/api/session', {
      method: 'POST',
      headers: { 'X-Studio-Client': 'browser' },
    });
    if (!session.ok) throw new Error('로컬 작업실 세션을 열 수 없습니다.');
    response = await send('/api' + path, init);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new LocalRequestError(
      response.status,
      (typeof data.detail === 'string' && data.detail
        ? data.detail
        : data.error === 'request_files' && typeof data.message === 'string'
          ? data.message
          : undefined) ??
        (response.status === 404 &&
        data.error === 'Not Found' &&
        path.endsWith('/session-requests')
          ? '현재 서버 버전에서는 다음 회차 요청을 저장할 수 없습니다. 실행 중인 작업이 끝나면 Workplot 서버를 재시작해 주세요.'
          : undefined) ??
        errorText[data.error] ??
        (response.status === 409
          ? '다른 실행 또는 변경과 충돌했습니다. 현재 상태를 확인하세요.'
          : '로컬 서버 요청을 완료할 수 없습니다.'),
    );
  }
  return response;
}
