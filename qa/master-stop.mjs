import console from 'node:console';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/dist/app.js';
import { codexRunner } from '../apps/server/dist/codex-runner.js';

await mkdir('.local/master-qa', { recursive: true });
const dir = await mkdtemp('.local/master-qa/stop-');
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
const browser = await chromium.launch();
const results = [];
try {
  const steps = ['first', 'next'].map((id, i) => ({
    id,
    kind: 'task',
    title: id,
    instructions: '작업 단계의 목적과 확인 기준을 한국어 문장 8개로 설명해라.',
    position: { x: i * 160, y: 0 },
  }));
  const wf = await req('POST', '/workflows', {
    name: '중단 검증',
    input: '격리 문서',
    inputFields: [],
    steps,
    links: [{ from: 'first', to: 'next' }],
  });
  const planId = randomUUID();
  await req('PUT', '/master-plans/' + planId, {
    goal: '중단 동작 검증',
    tasks: ['a', 'b'].map((id) => ({
      id,
      workflow: { id: wf.id, version: wf.version },
      dependsOn: [],
      doneWhen: id + ' 문서 완료',
      documents: { needs: [], output: id + ' 결과' },
    })),
  });
  const page = await browser.newPage();
  await page.route('**/*', async (route) => {
    const r = route.request(),
      url = new globalThis.URL(r.url());
    if (url.origin !== 'http://127.0.0.1:4310') return route.abort();
    const res = await app.inject({
      method: r.method(),
      url: url.pathname + url.search,
      headers: { ...(await r.allHeaders()), host: url.host },
      payload: r.postData() ?? undefined,
    });
    await route.fulfill({
      status: res.statusCode,
      headers: Object.fromEntries(
        Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
      ),
      body: res.rawPayload,
    });
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      if (e.code === 'ESRCH') return false;
      throw e;
    }
  };
  for (const mode of ['individual', 'all']) {
    const id = randomUUID(),
      offset = calls.length;
    const start = '/master-plans/' + planId + '/runs/' + id;
    const master = await req('PUT', start);
    const [a, b] = master.children;
    await page.goto('http://127.0.0.1:4310/#/masters/' + id);
    const button =
      mode === 'all'
        ? page.getByRole('button', { name: 'Stop all tasks' })
        : page
            .getByRole('listitem')
            .filter({ hasText: 'a 결과' })
            .getByRole('button', { name: 'Stop this task' });
    await button.waitFor();
    const first = await until(() => {
      const pair = calls.slice(offset);
      return (
        pair.length === 2 && pair.every((c) => c.pid && alive(c.pid)) && pair
      );
    });
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/stop') && r.request().method() === 'POST',
    );
    await button.click();
    assert.equal((await response).status(), 200);
    assert.equal(alive(first.find((c) => c.task === 'a').pid), false);
    const bAliveAfterStop = alive(first.find((c) => c.task === 'b').pid);
    assert.equal(bAliveAfterStop, mode === 'individual');
    if (mode === 'all') {
      await app.close();
      await open();
      const duplicate = await app.inject({
        method: 'PUT',
        url: '/api' + start,
        headers: { ...headers, cookie },
      });
      assert.equal(duplicate.statusCode, 409);
      await page.reload();
    }
    const expected = mode === 'all' ? 'stopped' : 'completed';
    const result = await until(async () => {
      const r = await req('GET', '/master-runs/' + id);
      return (
        r.children[0].view.summary.status === 'stopped' &&
        r.children[1].view.summary.status === expected &&
        r
      );
    });
    await page
      .getByText(mode === 'all' ? '전체 중단됨' : '일부 작업 중단', {
        exact: true,
      })
      .waitFor();
    const files = async (child) =>
      (await readdir(join(dir, 'runs', child.runId)))
        .filter((n) => n.endsWith('.md'))
        .sort();
    const filesA = await files(a),
      filesB = await files(b);
    assert.deepEqual(filesA, []);
    assert.deepEqual(filesB, mode === 'all' ? [] : ['first.md', 'next.md']);
    const observed = calls.slice(offset);
    assert.equal(observed.filter((c) => c.task === 'a').length, 1);
    assert.equal(
      observed.filter((c) => c.task === 'b').length,
      mode === 'all' ? 1 : 2,
    );
    assert.ok(observed.every((c) => !alive(c.pid)));
    await page.screenshot({ path: join(dir, mode + '.png') });
    results.push({
      mode,
      id,
      calls: observed,
      bAliveAfterStop,
      filesA,
      filesB,
      children: result.children.map((c) => c.view.summary.status),
    });
  }
  await writeFile(
    join(dir, 'stop-proof.json'),
    JSON.stringify(results, null, 2),
  );
  console.log('PASS', dir);
} finally {
  await browser.close();
  await app.close();
}
