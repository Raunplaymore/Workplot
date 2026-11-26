import console from 'node:console';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';
import { codexRunner } from '../apps/server/dist/codex-runner.js';

await mkdir('.local/master-qa', { recursive: true });
const dir = await mkdtemp('.local/master-qa/pair-');
const calls = [];
const runner = {
  ready: codexRunner.ready,
  async write(prompt, signal, observe, ...args) {
    const { masterTask, retryHandoff } = JSON.parse(prompt);
    const call = { task: masterTask.taskId, retry: !!retryHandoff };
    calls.push(call);
    try {
      return await codexRunner.write(
        prompt,
        signal,
        (info) => {
          Object.assign(call, info);
          observe(info);
        },
        ...args,
      );
    } finally {
      call.finishedAt = Date.now();
    }
  },
};
const headers = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'x-studio-client': 'browser',
};
let app, cookie;
async function open() {
  app = await buildApp(
    join(dir, 'qa.sqlite'),
    resolve('apps/web/dist'),
    undefined,
    runner,
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers,
  });
  cookie = res.headers['set-cookie'].split(';')[0];
}
async function req(method, path, payload) {
  const res = await app.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { ...headers, cookie },
  });
  assert.ok(res.statusCode < 300, res.body);
  return res.json();
}
async function until(check) {
  for (let i = 0; i < 1200; i++) {
    const found = await check();
    if (found) return found;
    await delay(100);
  }
  throw Error('QA 상태 대기 시간 초과');
}
await open();
try {
  const wf = await req('POST', '/workflows', {
    name: '병렬 문서 QA',
    input: '격리 검증',
    inputFields: [],
    steps: [
      {
        id: 'write',
        kind: 'task',
        title: '확인',
        instructions:
          'masterTask의 taskId를 포함해 한국어 문서 두 문장을 작성한다.',
        position: { x: 0, y: 0 },
      },
    ],
    links: [],
  });
  const planId = randomUUID(),
    id = randomUUID();
  await req('PUT', '/master-plans/' + planId, {
    goal: '두 독립 문서 생성',
    tasks: ['a', 'b'].map((k) => ({
      id: k,
      workflow: { id: wf.id, version: wf.version },
      dependsOn: [],
      doneWhen: k + ' 문서 작성',
      documents: { needs: [], output: k + ' 결과' },
    })),
  });
  const start = () => req('PUT', '/master-plans/' + planId + '/runs/' + id);
  const [first, second] = await Promise.all([start(), start()]);
  assert.deepEqual(first, second);
  const [a, b] = first.children.map((c) => c.runId);
  assert.notEqual(a, b);
  const overlap = await until(() => {
    if (calls.length !== 2 || calls.some((c) => !c.pid || c.finishedAt)) return;
    for (const c of calls) process.kill(c.pid, 0);
    return { at: Date.now(), pids: calls.map((c) => c.pid) };
  });
  const overlapEnd = await until(() => {
    if (Date.now() - overlap.at < 150) return;
    for (const c of calls) process.kill(c.pid, 0);
    return Date.now();
  });
  process.kill(calls.find((c) => c.task === 'a').pid, 'SIGKILL');
  async function status(run, expected) {
    return until(async () => {
      const v = await req('GET', '/runs/' + run + '/view');
      return v.summary.status === expected && v;
    });
  }
  await status(a, 'failed');
  await status(b, 'completed');
  const hashB = async () =>
    createHash('sha256')
      .update(await readFile(join(dir, 'runs', b, 'write.md')))
      .digest('hex');
  const before = await hashB();
  await app.close();
  await open();
  assert.deepEqual(await start(), first);
  await status(a, 'failed');
  const browser = await chromium.launch();
  const replies = [];
  try {
    const context = await browser.newContext();
    let arrived = 0;
    let release;
    const both = new Promise((resolve) => {
      release = resolve;
    });
    await context.route('**/*', async (route) => {
      const r = route.request(),
        url = new globalThis.URL(r.url());
      if (url.origin !== 'http://127.0.0.1:4310') return route.abort();
      const retry =
        url.pathname === '/api/runs/' + a + '/retry' && r.method() === 'POST';
      if (retry) {
        if (++arrived === 2) release();
        await both;
      }
      const res = await app.inject({
        method: r.method(),
        url: url.pathname + url.search,
        headers: { ...(await r.allHeaders()), host: url.host },
        payload: r.postData() ?? undefined,
      });
      if (retry) replies.push(res.statusCode);
      await route.fulfill({
        status: res.statusCode,
        headers: Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
        ),
        body: res.rawPayload,
      });
    });
    const tabs = await Promise.all([context.newPage(), context.newPage()]);
    for (const [i, tab] of tabs.entries()) {
      await tab.setViewportSize({ width: i ? 390 : 1440, height: 900 });
      await tab.goto('http://127.0.0.1:4310/#/masters/' + id);
      await tab.getByText('a · 실패', { exact: true }).waitFor();
      await tab.getByText('b · 완료', { exact: true }).waitFor();
      assert.equal(
        await tab.getByRole('button', { name: 'Retry this task' }).count(),
        1,
      );
    }
    await Promise.all(
      tabs.map((tab) =>
        tab.getByRole('button', { name: 'Retry this task' }).click(),
      ),
    );
    await status(a, 'completed');
    for (const tab of tabs) {
      await tab.getByText('a · 완료', { exact: true }).waitFor();
      await tab.getByText('문서 작업 완료', { exact: false }).waitFor();
      assert.equal(
        await tab.getByRole('button', { name: 'Retry this task' }).count(),
        0,
      );
    }
    assert.equal(replies.length, 2);
    assert.equal(replies.filter((n) => n >= 200 && n < 300).length, 1);
    assert.ok(replies.includes(409));
  } finally {
    await browser.close();
  }
  assert.equal(await hashB(), before);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((c) => c.task === 'b').length, 1);
  assert.equal(calls.at(-1).retry, true);
  const result = await req('GET', '/master-runs/' + id);
  assert.ok(
    result.children.every((c) => c.view.summary.status === 'completed'),
  );
  await writeFile(
    join(dir, 'proof.json'),
    JSON.stringify(
      {
        result,
        overlap,
        overlapEnd,
        calls,
        retryResponses: replies,
        bSha256: before,
      },
      null,
      2,
    ),
  );
  console.log('PASS', dir, overlap, overlapEnd - overlap.at + 'ms');
} finally {
  await app.close();
}
