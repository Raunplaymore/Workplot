import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { buildApp } from '../apps/server/dist/app.js';

const [source, negative] = process.argv.slice(2);
if (!source || !negative)
  throw Error('양성 QA 실행 폴더와 음성 proof.json 경로가 필요합니다.');
const root = await mkdtemp(resolve('.local/master-wire-'));
const original = new Database(join(source, 'qa.sqlite'), { readonly: true });
await original.backup(join(root, 'qa.sqlite'));
original.close();
await cp(join(source, 'runs'), join(root, 'runs'), { recursive: true });
const db = new Database(join(root, 'qa.sqlite'));
const { id, integration } = JSON.parse(
  await readFile(join(source, 'evidence.json'), 'utf8'),
);
const [conflict] = JSON.parse(await readFile(negative, 'utf8'));
const app = await buildApp(
  join(root, 'qa.sqlite'),
  resolve('apps/web/dist'),
  async () => [],
);
const browser = await chromium.launch();
try {
  for (const report of [integration, conflict]) {
    const dir = join(root, 'master-integrations', basename(report.directory));
    await mkdir(dir, { recursive: true });
    const stage = join(dir, basename(report.verifiedStage));
    await cp(report.verifiedStage, stage, { recursive: true });
    db.prepare('UPDATE master_ui_sources SET report=? WHERE id=?').run(
      JSON.stringify({ ...report, directory: dir, verifiedStage: stage }),
      id,
    );
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({
          viewport: { width, height: 900 },
        }),
        page = await ctx.newPage();
      await ctx.route('**/*', async (route) => {
        const req = route.request(),
          url = new globalThis.URL(req.url());
        if (url.origin !== 'http://127.0.0.1:4310') return route.abort();
        const res = await app.inject({
          method: req.method(),
          url: url.pathname + url.search,
          headers: { ...(await req.allHeaders()), host: url.host },
          payload: req.postData() ?? undefined,
        });
        const headers = Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
        );
        await route.fulfill({
          status: res.statusCode,
          headers,
          body: res.rawPayload,
        });
      });
      await page.goto('http://127.0.0.1:4310/#/runs');
      await page
        .locator('a[href="#/masters/' + id + '"]')
        .first()
        .click();
      const wire = page.getByLabel('병렬 실행 와이어');
      await wire.getByRole('link').first().waitFor();
      assert.equal(await wire.getByRole('link').count(), 2);
      await wire.getByRole('link').first().press('Enter');
      await page.getByRole('link', { name: '마스터 실행으로' }).click();
      await page.getByRole('heading', { name: '통합 결과' }).waitFor();
      if (report.status === 'conflict')
        await page.getByRole('heading', { name: '충돌 파일' }).waitFor();
      await page
        .getByText('마지막 통과본 보기', { exact: true })
        .press('Enter');
      await page.getByLabel('검증 화면').selectOption('390-editor.png');
      await page.waitForFunction(() => {
        const img = globalThis.document.querySelector('details[open] img');
        return img?.complete && img.naturalWidth > 0;
      });
      assert.ok(
        await page.evaluate(() =>
          [
            ...globalThis.document.querySelectorAll(
              'section[aria-label="마스터 실행 상세"]',
            ),
          ].every((el) => el.scrollWidth <= el.clientWidth + 1),
        ),
      );
      await page.screenshot({
        path: join(root, report.status + '-' + width + '.png'),
      });
      await ctx.close();
    }
  }
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify({
      id,
      widths: [1440, 390],
      cases: ['verified', 'conflict'],
      passed: 4,
    }),
  );
  console.log('PASS', root);
} finally {
  await browser.close();
  await app.close();
  db.close();
}
