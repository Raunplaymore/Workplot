import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import console from 'node:console';
import { URL } from 'node:url';
import { writeWeeklyEvidence } from './weekly-evidence.mjs';
import { chromium } from 'playwright';
import { buildApp } from '../apps/server/dist/app.js';

const dir = await mkdtemp(resolve('.local/weekly-routine-'));
const origin = 'http://127.0.0.1:45619';
const app = await buildApp(
  join(dir, 'qa.sqlite'),
  resolve('apps/web/dist'),
  undefined,
  undefined,
  undefined,
  undefined,
  { root: dir, port: 45619 },
);
const headers = {
  host: '127.0.0.1:45619',
  origin,
  'x-studio-client': 'browser',
};
const session = await app.inject({
  method: 'POST',
  url: '/api/session',
  headers,
});
headers.cookie = session.headers['set-cookie'].split(';')[0];
async function req(method, path, payload) {
  const res = await app.inject({
    method,
    url: '/api' + path,
    headers,
    payload,
  });
  assert.ok(res.statusCode < 300, res.body);
  return res.headers['content-type']?.includes('json') ? res.json() : res.body;
}
async function waitFor(id, status) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const view = await req('GET', '/runs/' + id + '/view');
    if (view.summary.status === status) return view;
    assert.ok(
      !['failed', 'unknown', 'stopped'].includes(view.summary.status),
      JSON.stringify(view),
    );
    await delay(350);
  }
  throw Error('대기 시간 초과 ' + id + ' ' + status);
}
const rule =
  '완료 항목 바로 아래에 “완료 근거”와 원문 한 문장을 그대로 인용한다. 완료 증거가 없는 항목은 “확인 대기” 소제목 아래에만 둔다.';
const weeks = [
  {
    source: '해오름 검색 배포가 완료됐다. 라일락 알림은 기획 회의에 올렸다.',
    done: '해오름 검색',
    pending: '라일락 알림',
    quote: '해오름 검색 배포가 완료됐다.',
  },
  {
    source: '솔바람 목록 배포가 완료됐다. 은하수 필터는 회의에서 제안했다.',
    done: '솔바람 목록',
    pending: '은하수 필터',
    quote: '솔바람 목록 배포가 완료됐다.',
  },
];
let browser, page;
try {
  const flow = await req('POST', '/workflows', {
    name: '주간 작업 기록 정리',
    input: '이번 주의 작업 기록',
    inputFields: [],
    steps: [
      {
        id: 'draft',
        kind: 'task',
        title: '주간 보고서 작성',
        instructions:
          '이번 주 입력으로 짧은 주간 보고서를 작성한다. 제목은 반드시 “# 주간 보고서”다. 완료한 일과 남은 일을 구분하고 기록에 없는 상태를 추측하지 않는다. 작업명은 그대로 쓴다.',
        position: { x: 0, y: 0 },
      },
      {
        id: 'review',
        kind: 'review',
        title: '공유 전 내용 승인',
        position: { x: 260, y: 0 },
      },
      {
        id: 'final',
        kind: 'task',
        title: '공유용 최종본 준비',
        instructions: '승인된 보고서를 본문 그대로 로컬 최종 문서로 반환한다.',
        position: { x: 520, y: 0 },
      },
    ],
    links: [
      { from: 'draft', to: 'review' },
      { from: 'review', to: 'final' },
    ],
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    const r = await app.inject({
      method: request.method(),
      url: url.pathname + url.search,
      headers: { ...(await request.allHeaders()), host: url.host },
      payload: request.postData() ?? undefined,
    });
    await route.fulfill({
      status: r.statusCode,
      headers: Object.fromEntries(
        Object.entries(r.headers).map(([k, v]) => [k, String(v)]),
      ),
      body: r.rawPayload,
    });
  });
  const records = [];
  for (const [index, week] of weeks.entries()) {
    const current = await req('GET', '/workflows/' + flow.id);
    assert.equal(current.version, index + 1);
    const id = randomUUID(),
      path = '/runs/' + id;
    await req('POST', '/runs', {
      id,
      workflowId: flow.id,
      workflowVersion: current.version,
      material: { name: '주간 기록 ' + (index + 1), source: week.source },
    });
    const waiting = await waitFor(id, 'waiting');
    assert.deepEqual(waiting.results, ['draft.md']);
    const original = await req('GET', path + '/results/draft.md');
    assert.ok(
      original.includes(week.done) && original.includes(week.pending),
      original,
    );
    await page.goto(origin + '/#' + path + '/review');
    if (index === 0) {
      await page
        .getByRole('button', { name: '문서 수정', exact: true })
        .click();
      assert.ok(
        await page.getByLabel('이번 결과만 수정', { exact: true }).isChecked(),
      );
      const edited =
        '# 주간 보고서\n\n## 완료\n' +
        week.done +
        '\n\n완료 근거 · “' +
        week.quote +
        '”\n\n## 확인 대기\n' +
        week.pending;
      await page.getByLabel('승인할 수정본', { exact: true }).fill(edited);
      await page.getByLabel('다음 실행에도 규칙 적용').check();
      await page.getByLabel('주간 보고서 작성에 추가할 규칙').fill(rule);
      await page.getByText('저장될 노드 지침 미리보기').click();
      assert.equal(await page.locator('ins').innerText(), rule);
      await page.getByRole('button', { name: '규칙 저장 후 승인' }).click();
    } else {
      assert.ok(current.definition.steps[0].instructions.endsWith(rule));
      const boundary = original.indexOf('확인 대기');
      assert.ok(
        boundary >= 0 &&
          original.slice(0, boundary).includes(week.quote) &&
          original.slice(0, boundary).includes('완료 근거') &&
          original.slice(boundary).includes(week.pending),
        original,
      );
      assert.ok(
        !original.includes(weeks[0].done) &&
          !original.includes(weeks[0].pending),
      );
      await req('POST', path + '/decision', {
        decision: 'accept',
        gateId: waiting.gate.id,
      });
    }
    const end = await waitFor(id, 'completed');
    assert.deepEqual(end.results, ['draft.md', 'final.md']);
    const accepted = await req('GET', path + '/results/draft.md');
    const final = await req('GET', path + '/results/final.md');
    assert.ok(final.includes(week.done) && final.includes(week.pending));
    const edits = end.editedFiles.includes('draft.md')
      ? (await req('GET', path + '/results/draft.md/reviews')).edits.length
      : 0;
    assert.equal(edits, index === 0 ? 1 : 0);
    records.push({
      id,
      version: current.version,
      source: week.source,
      original,
      accepted,
      final,
      edits,
      approved: end.summary.lastReview.at,
    });
  }
  await writeWeeklyEvidence(dir, records, rule, page);
  console.log(
    dir,
    records.map(({ id, version, edits }) => ({ id, version, edits })),
  );
} catch (error) {
  console.error(
    dir,
    await page
      ?.locator('aside[aria-label="실행 상세 패널"]')
      .innerText({ timeout: 3000 })
      .catch(() => ''),
  );
  throw error;
} finally {
  await browser?.close();
  await app.close();
}
