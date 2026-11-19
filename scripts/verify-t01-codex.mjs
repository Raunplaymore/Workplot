// Live smoke test using the installed Codex CLI and its existing ChatGPT login.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.argv[2];
assert(
  binary?.startsWith('/'),
  '설치된 codex 실행 파일의 절대 경로를 지정하세요.',
);
const local = resolve('.local');
mkdirSync(local, { recursive: true });
const cwd = mkdtempSync(join(local, 't01-live-'));
const evidence = join(cwd, 'evidence.jsonl');
const record = (check, details = {}) =>
  writeFileSync(evidence, JSON.stringify({ check, ...details }) + '\n', {
    flag: 'a',
  });

const child = spawn(
  binary,
  [
    'app-server',
    '--stdio',
    '--disable',
    'hooks',
    '--disable',
    'plugins',
    '--disable',
    'multi_agent',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'model_provider="openai"',
    '-c',
    'mcp_servers={}',
    '-c',
    'web_search="disabled"',
    '-c',
    'analytics.enabled=false',
  ],
  {
    cwd,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: cwd,
      LANG: 'en_US.UTF-8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
console.log(cwd);
record('process-start', { pid: child.pid });
const closed = once(child, 'close');
let closedAlready = false;
child.on('close', () => {
  closedAlready = true;
});
child.stdin.on('error', () => {});
child.stderr.resume();
const messages = [];
let nextId = 0;
const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
createInterface({ input: child.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    record('invalid-stdout');
    return;
  }
  messages.push(message);
  if (
    message.method &&
    message.id !== undefined &&
    message.method !== 'item/commandExecution/requestApproval'
  ) {
    record('unhandled-request', { method: message.method });
    write({
      id: message.id,
      error: { code: -32601, message: 'Unsupported in T01' },
    });
  }
});
async function waitFor(check, predicate, from = 0, timeout = 75_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = messages.slice(from).find(predicate);
    if (found) return found;
    if (closedAlready) throw new Error(check + ': CLI disconnected');
    await delay(40);
  }
  throw new Error(check + ': timed out');
}
async function request(method, params) {
  const id = ++nextId;
  const from = messages.length;
  write({ id, method, params });
  const response = await waitFor(
    method,
    (msg) => msg.id === id && !msg.method,
    from,
  );
  if (response.error) {
    record('rpc-error', { method, code: response.error.code });
    throw new Error(method + ': CLI returned an RPC error');
  }
  return response.result;
}
async function thread() {
  const { thread } = await request('thread/start', {
    cwd,
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
  return thread.id;
}
let turns = 0;
async function start(threadId, text) {
  const from = messages.length;
  const { turn } = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text, textElements: [] }],
  });
  turns++;
  record('turn-started', { sequence: turns, status: turn.status });
  return {
    from,
    matches: (m) =>
      m.params?.threadId === threadId &&
      (m.params.turnId ?? m.params.turn?.id) === turn.id,
    interrupt: () => request('turn/interrupt', { threadId, turnId: turn.id }),
  };
}
async function done(run, expected = 'completed') {
  const msg = await waitFor(
    'turn/completed',
    (m) => m.method === 'turn/completed' && run.matches(m),
    run.from,
  );
  record('turn-completed', { status: msg.params.turn.status });
  assert.equal(msg.params.turn.status, expected);
  return messages.slice(run.from, messages.indexOf(msg)).filter(run.matches);
}
async function document(threadId, prompt, filename) {
  const events = await done(
    await start(
      threadId,
      '도구 없이 문서의 Markdown 본문만 응답하세요. ' + prompt,
    ),
  );
  const text = events.findLast(
    (m) =>
      m.method === 'item/completed' && m.params.item.type === 'agentMessage',
  )?.params.item.text;
  assert(text, 'Markdown 본문 없음');
  for (const fact of [
    '픽셀서점',
    '샘플로 10',
    '10:00',
    '18:00',
    '독립출판물',
  ]) {
    assert(text.includes(fact), '문서에 필수 사실 누락: ' + fact);
  }
  const path = join(cwd, filename);
  writeFileSync(path, text + '\n', { flag: 'wx' });
  assert.equal(readFileSync(path, 'utf8'), text + '\n');
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  record('file-verified', { filename, sha256 });
  return { text, path, sha256 };
}
async function requestToolApproval(threadId, command) {
  const run = await start(
    threadId,
    '로컬 승인 검증입니다. exec_command를 한 번 호출하세요. ' +
      '명령은 정확히 "' +
      command +
      '"이고 workdir는 "' +
      cwd +
      '"입니다. ' +
      'yield_time_ms는 10000, sandbox_permissions는 require_escalated, justification은 "T01 가상 작업 검증"으로 설정하세요. ' +
      '요청이 거절되거나 실패하면 대체 명령이나 재시도를 하지 마세요.',
  );
  const approval = await waitFor(
    'command approval or completion',
    (m) =>
      run.matches(m) &&
      (m.method === 'item/commandExecution/requestApproval' ||
        m.method === 'turn/completed'),
    run.from,
  );
  assert.equal(
    approval.method,
    'item/commandExecution/requestApproval',
    'CLI 승인 요청 없음',
  );
  try {
    assert.equal(approval.params.cwd, cwd);
    const requested = approval.params.command;
    assert(
      [
        command,
        "/bin/zsh -lc '" + command + "'",
        "/bin/zsh -c '" + command + "'",
      ].includes(requested),
      '검증용 명령과 일치하지 않는 승인 요청',
    );
    assert.equal(approval.params.kind, 'command');
    assert(!approval.params.networkApprovalContext);
  } catch (error) {
    write({ id: approval.id, result: { decision: 'decline' } });
    throw error;
  }
  return { run, approval };
}

async function toolApproval(threadId, decision, filename) {
  const path = join(cwd, filename);
  const { run, approval } = await requestToolApproval(
    threadId,
    '/usr/bin/touch ' + filename,
  );
  await delay(350);
  assert(!existsSync(path), '승인 전 마커 파일 존재');
  record('tool-approval-pending', { filename, markerExists: false });
  write({ id: approval.id, result: { decision } });
  const events = await done(run);
  const item = events.findLast(
    (m) =>
      m.method === 'item/completed' &&
      m.params.item.id === approval.params.itemId,
  )?.params.item;
  assert.equal(existsSync(path), decision === 'accept');
  assert.equal(item?.status, decision === 'accept' ? 'completed' : 'declined');
  record('tool-approval-result', {
    decision,
    status: item.status,
    markerExists: existsSync(path),
  });
}

let failed = false;
try {
  await request('initialize', {
    clientInfo: { name: 'pixel_studio_t01', version: '0.1.0' },
  });
  write({ method: 'initialized' });
  const account = await request('account/read', { refreshToken: false });
  assert.equal(account.account?.type, 'chatgpt', '기존 ChatGPT 로그인 필요');
  record('account-verified', { type: 'chatgpt' });

  const writingThread = await thread();
  const draft = await document(
    writingThread,
    '다음 가상 자료로 매장 소개 한 문단을 쓰세요. 픽셀서점, 샘플로 10, 영업시간 10:00–18:00, 독립출판물 판매.',
    'draft.md',
  );
  const before = turns;
  await delay(350);
  assert.equal(turns, before);
  assert(!existsSync(join(cwd, 'revised.md')));
  async function review(decision) {
    if (decision === 'decline') return;
    assert.equal(decision, 'accept');
    assert.equal(readFileSync(draft.path, 'utf8'), draft.text + '\n');
    record('workflow-approved', {
      fixtureDecision: true,
      draftSha256: draft.sha256,
    });
    await document(
      writingThread,
      '아래 초안의 사실을 보존해 제목과 본문으로 수정하세요.\n' + draft.text,
      'revised.md',
    );
  }
  await review('decline');
  assert.equal(turns, before);
  assert(!existsSync(join(cwd, 'revised.md')));
  record('workflow-declined', { followupCalls: 0 });
  await review('accept');
  assert.equal(turns, before + 1);
  assert.equal(readFileSync(draft.path, 'utf8'), draft.text + '\n');
  record('workflow-followup-verified', {
    followupCalls: 1,
    draftPreserved: true,
  });

  const toolsThread = await thread();
  await toolApproval(toolsThread, 'decline', 'declined.marker');
  await toolApproval(toolsThread, 'accept', 'accepted.marker');

  const { run, approval } = await requestToolApproval(
    await thread(),
    '/bin/sleep 45',
  );
  function runningSleep(pidToCheck) {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
    }).split('\n');
    const parents = new Map();
    const sleepers = [];
    for (const row of rows) {
      const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/);
      if (!match) continue;
      const [, pid, ppid, command] = match;
      parents.set(Number(pid), Number(ppid));
      if (command === '/bin/sleep 45' || command === 'sleep 45')
        sleepers.push(Number(pid));
    }
    if (pidToCheck !== undefined)
      return parents.has(pidToCheck) ? pidToCheck : undefined;
    return sleepers.find((pid) => {
      for (let current = pid; current > 1; current = parents.get(current)) {
        if (current === child.pid) return true;
      }
      return false;
    });
  }
  assert.equal(runningSleep(), undefined);
  write({ id: approval.id, result: { decision: 'accept' } });
  const startDeadline = Date.now() + 5000;
  let sleeper;
  while (!sleeper && Date.now() < startDeadline) {
    sleeper = runningSleep();
    if (!sleeper) await delay(75);
  }
  assert(sleeper, 'Codex 하위 대기 프로세스 시작을 관측하지 못했습니다.');
  record('interrupt-target-running', { pid: sleeper });
  await run.interrupt();
  await done(run, 'interrupted');
  const stopDeadline = Date.now() + 5000;
  while (runningSleep(sleeper) && Date.now() < stopDeadline) await delay(75);
  assert.equal(
    runningSleep(sleeper),
    undefined,
    'Codex 하위 대기 프로세스 종료 미확인',
  );
  record('interrupt-verified', { childCommandExited: true });
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  child.stdin.end();
  const graceful = await Promise.race([
    closed,
    delay(2500, null, { ref: false }),
  ]);
  if (!graceful) child.kill('SIGTERM');
  const exited =
    graceful ??
    (await Promise.race([closed, delay(2500, null, { ref: false })]));
  if (exited) {
    const [code, signal] = exited;
    record('process-exit', { code, signal });
  } else {
    child.kill('SIGKILL');
    record('process-exit-unconfirmed');
    failed = true;
  }
  if (failed) process.exitCode = 1;
}
