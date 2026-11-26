import { URL, URLSearchParams } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import console from 'node:console';
import { buildApp } from '../apps/server/dist/app.js';
const dir = await mkdtemp(resolve('.local/run-navigation-'));
const runner = {
  ready: async () => '0.166.0',
  write: async () => ({ kind: 'document', text: '검증 문서 ' + randomUUID() }),
};
const app = await buildApp(
  join(dir, 'qa.sqlite'),
  resolve('apps/web/dist'),
  async () => [],
  runner,
);
const origin = 'http://127.0.0.1:4310';
const headers = {
  host: '127.0.0.1:4310',
  origin,
  'x-studio-client': 'browser',
};
const session = await app.inject({
  method: 'POST',
  url: '/api/session',
  headers,
});
const cookie = session.headers['set-cookie'].split(';')[0];
async function req(method, url, payload) {
  const r = await app.inject({
    method,
    url: '/api' + url,
    headers: { ...headers, cookie },
    payload,
  });
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
const browser = await chromium.launch();
try {
  const steps = ['draft', 'edit', 'removed'].map((id, i) => ({
    id,
    kind: 'task',
    title: id,
    instructions: '최초 지침 ' + id,
    position: { x: i * 160, y: 0 },
  }));
  const wf = await req('POST', '/workflows', {
    name: '이동 검증',
    input: '동일 자료',
    inputFields: [],
    steps,
    links: [
      { from: 'draft', to: 'edit' },
      { from: 'edit', to: 'removed' },
    ],
  });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    ids.push(id);
    await req('POST', '/runs', {
      id,
      workflowId: wf.id,
      workflowVersion: wf.version,
    });
    for (let n = 0; n < 100; n++) {
      const view = await req('GET', '/runs/' + id + '/view');
      if (view.summary.status === 'completed') break;
      assert.ok(n < 99, JSON.stringify(view));
      await delay(50);
    }
  }
  const linked = await req('POST', '/workflows', {
    ...wf.definition,
    name: '화면 개선',
    steps: [{ ...steps[0], instructions: '하위 작업 지침입니다.' }],
    links: [],
  });
  const updated = await req('PUT', '/workflows/' + wf.id, {
    baseVersion: wf.version,
    definition: {
      ...wf.definition,
      steps: [
        steps[0],
        { ...steps[1], title: '새 단계명', instructions: '최신 지침' },
        {
          ...steps[0],
          id: 'screen-design',
          title: '화면 개선',
          workflowRef: { id: linked.id, version: linked.version },
        },
      ],
      links: [
        { from: 'draft', to: 'edit' },
        { from: 'edit', to: 'screen-design' },
      ],
    },
  });
  const documents = new Map();
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    await req('POST', '/runs', {
      id,
      workflowId: wf.id,
      workflowVersion: updated.version,
    });
    for (let n = 0; n < 100; n++) {
      const v = await req('GET', '/runs/' + id + '/view');
      if (v.summary.status === 'completed') break;
      assert.ok(n < 99, JSON.stringify(v));
      await delay(50);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/' + id + '/results/screen-design.md',
      headers: { ...headers, cookie },
    });
    assert.equal(res.statusCode, 200);
    documents.set(id, res.body.trim());
  }
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await ctx.route('**/*', async (route) => {
      const req = route.request(),
        url = new globalThis.URL(req.url());
      if (url.origin !== origin) return route.abort();
      const res = await app.inject({
        method: req.method(),
        url: url.pathname + url.search,
        headers: { ...(await req.allHeaders()), host: url.host },
        payload: req.postData() ?? undefined,
      });
      await route.fulfill({
        status: res.statusCode,
        headers: Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
        ),
        body: res.rawPayload,
      });
    });
    const runUrl = origin + '/#/runs/' + ids[0];
    await page.goto(runUrl);
    const entry = (title) =>
      page.locator('details').filter({
        has: page
          .locator('summary strong')
          .filter({ hasText: new RegExp('^' + title + '$') }),
      });
    const edit = entry('edit');
    const summary = edit.locator('summary');
    await summary.getByText('Task · Completed', { exact: true }).waitFor();
    assert.equal(await summary.locator('strong').innerText(), 'edit');
    assert.ok(
      await summary.evaluate((element) => {
        const row = element.getBoundingClientRect();
        return (
          row.height <=
            Math.ceil(
              parseFloat(globalThis.getComputedStyle(element).lineHeight),
            ) &&
          globalThis.getComputedStyle(element.closest('ol')).listStyleType ===
            'decimal'
        );
      }),
      '접힌 실행 단계에는 한 줄과 기본 순번 하나만 표시',
    );
    await edit.locator('summary').click();
    await edit.getByText('최초 지침 edit', { exact: true }).waitFor();
    await edit.getByText('draft → edit → removed').waitFor();
    await page.screenshot({ path: join(dir, 'steps-' + width + '.png') });
    await edit
      .getByRole('button', { name: 'Edit step in latest version' })
      .click();
    await page.waitForURL(origin + '/#/design/' + wf.id);
    assert.equal(await page.getByLabel('단계 제목').inputValue(), '새 단계명');
    assert.equal(await page.getByLabel('Prompt').inputValue(), '최신 지침');
    const resultButton = page
      .getByRole('button', {
        name: /^screen-design\.md · Open · Latest result · Session 4 · /,
      })
      .filter({ visible: true })
      .first();
    await resultButton.waitFor();
    const latestLabel = await resultButton.locator('small').textContent();
    await resultButton.click();
    await page
      .getByRole('article')
      .getByText('하위 작업 지침입니다.', { exact: true })
      .waitFor();
    const dialog = page.getByRole('dialog', { name: 'screen-design.md' });
    await dialog.waitFor();
    assert.ok((await dialog.boundingBox()).width > width * 0.85);
    const selector = page.getByLabel(/문서를 생성한 실행/);
    await selector.waitFor();
    assert.equal(await selector.inputValue(), [...documents.keys()].at(-1));
    assert.equal(
      await selector.locator('option:checked').textContent(),
      latestLabel,
    );
    assert.match(
      await selector.locator('option').nth(1).textContent(),
      /이전 결과 · 3회차 · .*\d{2}:\d{2}/,
    );
    assert.equal(await selector.locator('option').count(), 2);
    await dialog
      .getByRole('button', { name: 'Compare with previous session' })
      .click();
    const diff = dialog.getByRole('table', { name: '회차별 문서 변경' });
    await diff.getByRole('columnheader', { name: '직전 · 3회차' }).waitFor();
    await diff.getByRole('columnheader', { name: '선택 · 4회차' }).waitFor();
    await dialog.getByText('추가 0줄 · 수정 1줄 · 삭제 0줄').waitFor();
    assert.ok(await diff.locator('del').count());
    assert.ok(await diff.locator('ins').count());
    await selector.selectOption([...documents.keys()][0]);
    await dialog
      .getByText('이 버전에서 비교할 이전 결과가 없습니다.')
      .waitFor();
    await dialog.getByRole('button', { name: 'View document' }).click();
    for (const [id, body] of documents) {
      await selector.selectOption(id);
      await page
        .getByRole('article')
        .getByText(body, { exact: true })
        .waitFor();
    }
    const copied = page.url();
    const query = new URLSearchParams(new URL(copied).hash.split('?')[1]);
    const runInUrl = query.get('run');
    assert.equal(query.get('node'), 'screen-design');
    assert.equal(runInUrl, await selector.inputValue());
    const checkDocument = async (tab) => {
      const modal = tab.getByRole('dialog', { name: 'screen-design.md' });
      await modal
        .getByRole('article')
        .getByText(documents.get(runInUrl), { exact: true })
        .waitFor();
      assert.equal(await modal.getByRole('combobox').inputValue(), runInUrl);
    };
    await page.reload();
    await checkDocument(page);
    const fresh = await ctx.newPage();
    await fresh.goto(copied);
    await checkDocument(fresh);
    await fresh.goto(copied.replace(runInUrl, 'unavailable'));
    await fresh
      .getByText('이 실행 회차의 결과 문서를 찾을 수 없습니다.')
      .waitFor();
    await fresh.close();
    await page
      .getByRole('button', { name: 'Edit child instructions', exact: true })
      .click();
    const instruction = page.getByLabel('draft 지침', { exact: true });
    await instruction.fill('결과 문서를 참고해 수정한 지침');
    const selectedRun = await selector.inputValue();
    const body = documents.get(selectedRun);
    await page.getByRole('article').getByText(body, { exact: true }).waitFor();
    await page.screenshot({
      path: join(dir, 'design-document-' + width + '.png'),
    });
    if (width === 390) {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page
        .getByRole('article')
        .getByText('결과 문서를 참고해 수정한 지침', { exact: true })
        .waitFor();
      await page
        .getByRole('article')
        .getByText(body, { exact: true })
        .waitFor();
      await dialog.waitFor();
      assert.equal(await selector.inputValue(), selectedRun);
      for (let i = 0; i < 100; i++) {
        const stored = await req('GET', '/workflows/' + wf.id);
        if (stored.definition.steps.at(-1).workflowRef.version === 2) break;
        assert.ok(i < 99);
        await delay(50);
      }
      assert.equal(
        (await req('GET', '/workflows/' + linked.id + '/versions/1')).definition
          .steps[0].instructions,
        '하위 작업 지침입니다.',
      );
      assert.equal(
        (await req('GET', '/workflows/' + linked.id + '/versions/2')).definition
          .steps[0].instructions,
        '결과 문서를 참고해 수정한 지침',
      );
      await page
        .getByRole('article')
        .getByText(body, { exact: true })
        .waitFor();
    } else {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal((await req('GET', '/workflows/' + linked.id)).version, 1);
    }
    await dialog.getByRole('button', { name: 'Close' }).click();
    if (width === 390) {
      const stale = await app.inject({
        method: 'PUT',
        url:
          '/api/workflows/' +
          wf.id +
          '/steps/screen-design/linked-instructions',
        headers: { ...headers, cookie },
        payload: {
          baseVersion: updated.version,
          definition: {
            ...updated.definition,
            steps: updated.definition.steps.map((s) =>
              s.workflowRef
                ? { ...s, workflowRef: { id: linked.id, version: 2 } }
                : s,
            ),
          },
          childDefinition: linked.definition,
        },
      });
      assert.equal(stale.statusCode, 409);
      assert.equal((await req('GET', '/workflows/' + linked.id)).version, 2);
      assert.equal(
        (await req('GET', '/workflows/' + wf.id)).version,
        updated.version + 1,
      );
    }
    await page.goto(runUrl);
    const removed = entry('removed');
    await removed.locator('summary').click();
    await removed
      .getByRole('button', { name: 'Edit step in latest version' })
      .click();
    await page
      .getByText('선택한 단계는 최신 저장 워크플로에서 삭제되었습니다.')
      .waitFor();
    assert.equal(page.url(), runUrl);
    for (const id of ids) {
      await page.goto(origin + '/#/runs/' + id + '/compare');
      await page
        .getByRole('article')
        .first()
        .getByText(new RegExp(id))
        .waitFor();
    }
    await page.reload();
    const history = page.getByRole('navigation', { name: '최근 문서 비교' });
    const back = history.getByRole('link');
    await back.waitFor();
    assert.equal(await back.count(), 1);
    await page.screenshot({ path: join(dir, 'history-' + width + '.png') });
    await back.click();
    await page.waitForURL(runUrl + '/compare');
    await page
      .getByRole('article')
      .first()
      .getByText(new RegExp(ids[0]))
      .waitFor();
    assert.equal(await history.getByRole('link').count(), 1);
    await page.goto(origin + '/#/library');
    await page.getByRole('button', { name: '화면 개선', exact: true }).click();
    await page.waitForURL(origin + '/#/library/' + linked.id);
    await page.reload();
    await page
      .getByRole('heading', { name: '화면 개선', exact: true })
      .waitFor();
    await page.getByRole('button', { name: /^Edit saved v\d+$/ }).click();
    const address = origin + '/#/design/' + linked.id;
    await page.waitForURL(address);
    await page.reload();
    await page.getByRole('heading', { level: 1, name: '화면 개선' }).waitFor();
    await page.getByLabel('Prompt', { exact: true }).fill('주소별 미저장 지침');
    await page.reload();
    assert.equal(
      await page.getByLabel('Prompt', { exact: true }).inputValue(),
      '주소별 미저장 지침',
    );
    await page.goto(origin + '/#/design/' + wf.id);
    await page.getByRole('heading', { level: 1, name: '이동 검증' }).waitFor();
    assert.notEqual(
      await page.getByLabel('Prompt', { exact: true }).inputValue(),
      '주소별 미저장 지침',
    );
    await page.goBack();
    await page.waitForURL(address);
    await page.getByRole('heading', { level: 1, name: '화면 개선' }).waitFor();
    assert.equal(
      await page.getByLabel('Prompt', { exact: true }).inputValue(),
      '주소별 미저장 지침',
    );
    await page.goto(origin + '/#/design/' + randomUUID());
    await page
      .getByRole('alert')
      .filter({ hasText: '찾을 수 없습니다' })
      .waitFor();
    assert.equal(await page.getByLabel('Prompt', { exact: true }).count(), 0);
    await ctx.close();
  }
  console.log('PASS', dir);
} finally {
  await browser.close();
  await app.close();
}
