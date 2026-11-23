import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const [workflowId, version, port, runId = randomUUID()] = process.argv.slice(2);
const origin = 'http://127.0.0.1:' + port;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function start() {
  if (
    !/^\d{4,5}$/.test(port) ||
    Number(port) < 1024 ||
    Number(port) > 65535 ||
    !uuid.test(workflowId) ||
    !/^[1-9]\d*$/.test(version) ||
    !uuid.test(runId)
  )
    throw Error('워크플롯 ID·버전·실행 ID를 확인하세요.');
  let source = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    source += chunk;
    if (source.length > 8000)
      throw Error('자료는 8,000자까지 입력할 수 있습니다.');
  }
  if (!source.trim()) throw Error('이번 실행에 필요한 원본 자료를 입력하세요.');
  const url = origin + '/#/runs/' + runId;
  const request = (path, init) =>
    globalThis.fetch(origin + '/api' + path, {
      ...init,
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(20000),
    });
  const session = await request('/session', {
    method: 'POST',
    headers: { origin, 'X-Studio-Client': 'browser' },
  });
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  if (!session.ok || !cookie)
    throw Error('Workplot 로컬 세션을 열 수 없습니다.');
  const headers = { origin, cookie, 'Content-Type': 'application/json' };
  console.log('실행 요청 ID ' + runId);
  const res = await request('/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: runId,
      workflowId,
      workflowVersion: Number(version),
      material: { name: '', source: source.trim() },
    }),
  });
  if (!res.ok) {
    const { error } = await res.json();
    throw Error(
      error === 'missing_material'
        ? '필수 자료가 빠졌습니다. 스킬에 표시된 항목을 확인하세요.'
        : 'Workplot 실행 요청 실패 · ' + error,
    );
  }
  console.log(url);
  let view = await res.json();
  const until = Date.now() + 45000;
  while (
    ['queued', 'running'].includes(view.summary.status) &&
    Date.now() < until
  ) {
    await delay(700);
    const state = await request('/runs/' + runId + '/view', { headers });
    if (!state.ok)
      throw Error('상태를 확인할 수 없습니다. 실행 링크를 열어 주세요.');
    view = await state.json();
  }
  console.log(
    JSON.stringify({
      runId,
      workflowVersion: view.summary.workflowVersion,
      status: view.summary.status,
      results: view.results,
      link: view.summary.status === 'waiting' ? url + '/review' : url,
    }),
  );
  if (['failed', 'unknown', 'stopped'].includes(view.summary.status))
    process.exitCode = 1;
}
start().catch((error) => {
  console.error(
    ['EPERM', 'EACCES'].includes(error.cause?.code)
      ? 'Codex 샌드박스가 로컬 Workplot 연결을 차단했습니다. 이 실행 명령의 로컬 서버 접근 권한을 요청한 뒤 같은 자료로 재시도하세요.'
      : error.message === 'fetch failed'
        ? '로컬 Workplot 서버(127.0.0.1:4310)에 연결할 수 없습니다.'
        : error.message,
  );
  process.exitCode = 1;
});
