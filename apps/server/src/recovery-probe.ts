import { chromium, type Browser } from 'playwright';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveQaPort } from './qa-port.js';
import { openStudioStore } from './studio-store.js';

export async function probeRecovery(
  directory: string,
  evidence: string,
  signal: AbortSignal,
) {
  const scratch = await mkdtemp(join(tmpdir(), 'workplot-ui-recovery-'));
  const dbPath = join(scratch, 'studio.sqlite');
  let stage = 'QA 서버 기동',
    browser: Browser | undefined,
    app: Awaited<ReturnType<typeof import('./app.js').buildApp>> | undefined;
  let lease: Awaited<ReturnType<typeof reserveQaPort>> | undefined;
  const captures: string[] = [];
  const stop = () => {
    void browser?.close().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    lease = await reserveQaPort();
    const db = new Database(dbPath);
    let wid: string, rid: string;
    try {
      const store = openStudioStore(db);
      const flow = store.createWorkflow({
        name: '화면 검증용 작업',
        input: '검증 자료',
        steps: [
          {
            kind: 'task',
            id: 'draft',
            title: '작성',
            instructions: '자료를 정리한다.',
            position: { x: 0, y: 0 },
          },
          {
            kind: 'task',
            id: 'finish',
            title: '정리',
            instructions: '작성 결과를 확인한다.',
            inputFrom: ['draft'],
            position: { x: 260, y: 0 },
          },
        ],
        links: [{ from: 'draft', to: 'finish' }],
      });
      wid = flow.id;
      rid = store.recordRun({
        workflowId: wid,
        workflowVersion: flow.version,
        cliVersion: '0.166.0',
        sessionId: null,
        process: null,
        results: [],
        status: 'failed',
      }).id;
    } finally {
      db.close();
    }
    const { buildApp } = await import('./app.js');
    app = await buildApp(
      dbPath,
      fileURLToPath(new URL('../../web/dist', import.meta.url)),
      async () => [],
      undefined,
      undefined,
      undefined,
      { root: scratch, port: lease.port },
    );
    const origin = await app.listen({ host: '127.0.0.1', port: lease.port });
    stage = '브라우저 시작';
    browser = await chromium.launch({ chromiumSandbox: true });
    signal.addEventListener('abort', stop, { once: true });
    signal.throwIfAborted();
    const design = /흐름 설계|와이어 편집기/.test(evidence.slice(0, 180));
    const detail =
      !design && /실행 상세|문서 검토/.test(evidence.slice(0, 180));
    const route = design
      ? '#/design/' + wid
      : detail
        ? '#/runs/' + rid
        : '#/runs';
    const heading = design
      ? '와이어 편집기'
      : detail
        ? '실행 상세'
        : '실행 현황';
    for (const width of [1440, 390]) {
      stage = '페이지 접속';
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        serviceWorkers: 'block',
      });
      await page.route('**/*', (r) =>
        new URL(r.request().url()).origin === origin &&
        (r.request().method() === 'GET' ||
          new URL(r.request().url()).pathname === '/api/session')
          ? r.continue()
          : r.abort(),
      );
      await page.goto(origin + '/' + route, { timeout: 10000 });
      stage = '대상 요소 탐색';
      await (
        detail
          ? page.getByRole('region', { name: heading, exact: true })
          : page.getByRole('heading', { name: heading, exact: true })
      )
        .first()
        .waitFor({ timeout: 5000 });
      stage = '캡처';
      const file = width + '-recovery.png';
      await page.screenshot({ path: join(directory, file), timeout: 5000 });
      captures.push(file);
      await page.close();
    }
    return {
      stage: '캡처 완료',
      heading,
      captures,
      scope:
        '현재 서비스 빌드·격리 QA 데이터로 확인한 화면 진입. 실제 과제 조작 및 후보 전후 비교는 별도로 확인한다.',
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      stage,
      captures,
      error:
        error instanceof Error ? error.message.slice(0, 500) : String(error),
    };
  } finally {
    signal.removeEventListener('abort', stop);
    await browser?.close();
    await app?.close();
    lease?.release();
    await rm(scratch, { recursive: true, force: true });
  }
}
