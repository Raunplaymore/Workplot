import { test, expect, type Page } from '@playwright/test';
import { execFileSync, fork } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.STUDIO_QA_DIR!;
function start(dir: string) {
  const child = fork(resolve('qa/server.mjs'), [], {
    env: { ...process.env, STUDIO_QA_DIR: dir, TMPDIR: join(dir, 'scratch') },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((res, rej) => {
    child.once('error', rej);
    child.once('exit', (code, signal) => res({ code, signal }));
  });
  const ready = Promise.race([
    new Promise<void>((res) =>
      child.once('message', (message) => {
        if (message === 'ready') res();
      }),
    ),
    exit.then((result) => {
      throw new Error('QA 서버 준비 중 종료 ' + JSON.stringify(result));
    }),
  ]);
  return { child, ready, exit };
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}
type Call = { run: string; step: string; event: string; pid?: number };
async function retryFromBothTabs(tabs: Page[], id: string, failureId: string) {
  const path = '/api/runs/' + id + '/retry';
  let release!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  return Promise.all(
    tabs.map(async (tab, i) => {
      await tab.route(
        '**' + path,
        async (route) => {
          // Both real clicks must have produced a request before either reaches the server.
          if (++waiting === tabs.length) release();
          await bothReady;
          await route.continue();
        },
        { times: 1 },
      );
      const [reply] = await Promise.all([
        tab.waitForResponse(
          (r) => r.url().endsWith(path) && r.request().method() === 'POST',
        ),
        tab
          .getByRole('button', { name: '실패한 단계 다시 실행', exact: true })
          .click(),
      ]);
      expect(reply.request().postDataJSON()).toEqual({ failureId });
      return { tab: i + 1, failureId, status: reply.status() };
    }),
  );
}
const cases = [
  ['Q14', '초안 작성', 'draft', 'server'],
  ['Q15', '사용자 검토 대기', 'review', 'server'],
  ['Q16', '수정본 작성', 'revision', 'server'],
  ['Q17', '초안 작성', 'draft', 'codex'],
  ['Q18', '수정본 작성', 'revision', 'codex'],
  ['Q19', '초안 작성', 'draft', 'retry'],
  ['Q20', '수정본 작성', 'revision', 'retry'],
  ['Q21', '수정본 작성', 'revision', 'concurrent-retry'],
  ['Q22', '수정본 작성', 'revision', 'edited-draft'],
  ['Q23', '수정본 작성', 'revision', 'restored-draft'],
  ['Q24', '수정본 작성', 'revision', 'restored-concurrent'],
  ['Q25', '수정본 작성', 'revision', 'restart-before-restore'],
  ['Q26', '수정본 작성', 'revision', 'retry-edited-after-restart'],
] as const;
for (const [code, title, step, target] of cases) {
  const retryEditedAfterRestart = target === 'retry-edited-after-restart';
  const restartBeforeRestore =
    target === 'restart-before-restore' || retryEditedAfterRestart;
  const restoresDraft =
    target === 'restored-draft' ||
    target === 'restored-concurrent' ||
    restartBeforeRestore;
  const concurrentRetry =
    target === 'concurrent-retry' ||
    target === 'restored-concurrent' ||
    restartBeforeRestore;
  const codexCrash = target !== 'server';
  const dashboard = codexCrash ? '실패' : '종료 상태 미확인';
  const status = codexCrash ? 'failed' : 'unknown';
  const scenario = {
    server: '서버 강제 종료 후 복구',
    codex: 'Codex 강제 종료',
    retry: '실패 후 한 단계 재실행',
    'concurrent-retry': '실패 후 두 탭 동시 재실행',
    'edited-draft': '실패 후 승인 초안 변경 시 재실행 차단',
    'restored-draft': '재실행 차단 후 승인 초안 복원 및 수정 단계 재시도',
    'restored-concurrent': '재실행 차단 후 승인 원본 복원 및 두 탭 동시 재실행',
    'restart-before-restore':
      '차단 후 서버 재시작·승인 원본 복원·두 탭 동시 재실행',
    'retry-edited-after-restart':
      '재시작 후 두 탭에서 변경본 차단 및 원본 복원 후 동시 재시도',
  }[target];
  test(code + ' ' + title + ' 중 ' + scenario, async ({ page }) => {
    const dir = join(root, code);
    await mkdir(join(dir, 'scratch'), { recursive: true });
    const evidence: Record<string, unknown> = {
      caseDir: code,
      stage: step,
      target,
    };
    let server = start(dir);
    async function restartServer() {
      const previousPid = server.child.pid;
      expect(server.child.kill('SIGTERM')).toBe(true);
      await server.exit;
      server = start(dir);
      await server.ready;
      expect(server.child.pid).not.toBe(previousPid);
      await page.reload();
      return { previousPid, currentPid: server.child.pid };
    }
    try {
      await server.ready;
      await page.goto('/');
      await page.getByRole('link', { name: '흐름 설계' }).click();
      await page.getByRole('button', { name: '흐름 목록' }).click();
      await page
        .getByLabel('저장한 흐름')
        .selectOption({ label: '모퉁이서점 안내문 · Codex 승인 검증 · v1' });
      const button = (name: string) =>
        page.getByRole('button', { name, exact: true });
      await button('흐름 열기').click();
      const started = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/api/runs'),
      );
      await button('저장한 버전 실행').click();
      const response = await started;
      expect(response.status()).toBe(200);
      const { summary } = await response.json(),
        id: string = summary.id;
      Object.assign(evidence, {
        id,
        version: summary.workflowVersion,
        cli: summary.cliVersion,
      });
      const runDir = join(dir, 'runs', id);
      async function calls(): Promise<Call[]> {
        try {
          return (await readFile(join(dir, 'cli.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((c) => c.run === id);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw e;
        }
      }
      // Include every file (also unexpected/partial artifacts) and the event journal.
      async function snapshot() {
        const files = await readdir(runDir);
        return Object.fromEntries(
          await Promise.all(
            files.sort().map(async (file) => [
              file,
              createHash('sha256')
                .update(await readFile(join(runDir, file)))
                .digest('hex'),
            ]),
          ),
        );
      }
      let reviewedDraft: string | undefined;
      if (step !== 'draft') {
        await expect(button('검토할 문서 열기')).toBeVisible({
          timeout: 145000,
        });
        await button('검토할 문서 열기').click();
        reviewedDraft = await readFile(join(runDir, 'draft.md'), 'utf8');
        await expect(page.locator('[data-markdown-source]')).toHaveText(
          reviewedDraft.trim(),
        );
        if (step === 'revision') await button('승인하고 계속').click();
      }
      let writer: number | undefined;
      if (step !== 'review') {
        await expect
          .poll(
            async () => {
              writer = (await calls()).find(
                (c) => c.step === step && c.event === 'spawn',
              )?.pid;
              return writer !== undefined && alive(writer);
            },
            { intervals: [20, 40], timeout: 15000 },
          )
          .toBe(true);
      }
      const before = await snapshot(),
        beforeCalls = await calls();
      const readLog = async () =>
        (await readFile(join(runDir, 'events.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      const log = await readLog();
      const results = step === 'draft' ? [] : ['draft.md'];
      expect(log.at(-1)).toMatchObject({
        stepId: step,
        status: step === 'review' ? 'waiting' : 'running',
        results,
        gate: step === 'review' ? 'review' : null,
      });
      expect(Object.keys(before)).toEqual([...results, 'events.jsonl'].sort());
      const steps = step === 'revision' ? ['draft', 'revision'] : ['draft'];
      for (const kind of ['write', 'spawn'])
        expect(
          beforeCalls.filter((c) => c.event === kind).map((c) => c.step),
        ).toEqual(steps);
      const oldPid = server.child.pid;
      let executable: string | undefined;
      if (writer) {
        // Wait past the npm launcher so the crash hits the native Codex executable.
        await expect
          .poll(() => {
            executable = execFileSync(
              'ps',
              ['-p', String(writer), '-o', 'comm='],
              { encoding: 'utf8' },
            ).trim();
            return executable.split('/').at(-1);
          })
          .toBe('codex');
        expect(alive(writer) && alive(-writer)).toBe(true);
      }
      const sentAt = performance.now();
      if (codexCrash) {
        if (!writer || writer === oldPid)
          throw new Error('Codex PID 확인 실패');
        expect(process.kill(writer, 'SIGKILL')).toBe(true);
      } else {
        expect(server.child.kill('SIGKILL')).toBe(true);
        expect(await server.exit).toEqual({ code: null, signal: 'SIGKILL' });
      }
      const cliAliveAfterKill = writer ? alive(writer) : null;
      Object.assign(evidence, {
        oldPid,
        signal: 'SIGKILL',
        writer,
        cliAliveAfterKill,
        executable,
        before,
        stageAtKill: log.at(-1),
        beforeCalls,
      });
      if (writer) {
        const pid = writer;
        await expect
          .poll(() => alive(pid) || alive(-pid), {
            timeout: 2000,
            intervals: [10, 20, 50],
          })
          .toBe(false);
        Object.assign(evidence, {
          ...(codexCrash
            ? { cliPidGone: true }
            : { pidGoneBeforeRestart: true, groupGoneBeforeRestart: true }),
          observedGoneMs: Math.ceil(performance.now() - sentAt),
        });
      }
      const row = page.getByRole('row').filter({ hasText: '모퉁이서점' });
      if (codexCrash) {
        await page.getByRole('link', { name: '실행 현황' }).click();
        await expect(
          row.getByRole('cell', { name: dashboard, exact: true }),
        ).toBeVisible();
        expect(server.child.exitCode).toBeNull();
        expect(server.child.signalCode).toBeNull();
        expect(alive(oldPid!)).toBe(true);
      } else {
        server = start(dir);
        await server.ready;
        expect(server.child.pid).not.toBe(oldPid);
      }
      await page.reload();
      await page.getByRole('link', { name: '실행 현황' }).click();
      await expect(row).toHaveCount(1);
      await expect(
        row.getByRole('cell', { name: dashboard, exact: true }),
      ).toBeVisible();
      await row.getByRole('button').click();
      await expect(page.getByText('버전 1 · ' + dashboard)).toBeVisible();
      expect(
        await page.evaluate(() => sessionStorage.getItem('studio-run')),
      ).toBe(id);
      await expect(button('승인하고 계속')).toHaveCount(0);
      await expect(button('revision.md')).toHaveCount(0);
      const viewResponse = await page.request.get('/api/runs/' + id + '/view');
      expect(viewResponse.status()).toBe(200);
      const recovered = await viewResponse.json();
      expect(recovered).toMatchObject({
        summary: { ...summary, status },
        ...(codexCrash ? { stepId: step } : {}),
        gate: null,
        results,
      });
      if (results.length) {
        await button('draft.md').click();
        await expect(page.locator('[data-markdown-source]')).toHaveText(
          (await readFile(join(runDir, 'draft.md'), 'utf8')).trim(),
        );
      }
      const replay = await page.request.post('/api/runs', {
        headers: { origin: 'http://127.0.0.1:5173' },
        data: {
          id,
          workflowId: summary.workflowId,
          workflowVersion: summary.workflowVersion,
        },
      });
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({
        summary: { id, status },
        gate: null,
        results,
      });
      await delay(2000);
      const after = await snapshot(),
        afterCalls = await calls();
      if (codexCrash) {
        const events = await readLog();
        const final = events.at(-1);
        expect(final).toMatchObject({
          status,
          stepId: step,
          gate: null,
          results,
        });
        expect(events).toEqual([...log, final]);
        expect(after).toEqual({
          ...before,
          'events.jsonl': expect.any(String),
        });
        if (reviewedDraft !== undefined) {
          expect(await readFile(join(runDir, 'draft.md'), 'utf8')).toBe(
            reviewedDraft,
          );
        }
        Object.assign(evidence, { final, serverPidAfter: server.child.pid });
      } else expect(after).toEqual(before);
      expect(afterCalls).toEqual(beforeCalls);
      Object.assign(evidence, {
        ...(!codexCrash && { newPid: server.child.pid }),
        dashboard,
        results,
        after,
        afterCalls,
        replayedRunId: id,
        cliGroupGone: writer ? true : null,
      });
      const tabs = [page];
      async function openOtherTab() {
        const other = await page.context().newPage();
        await other.goto('/');
        await other
          .getByRole('row')
          .filter({ hasText: '모퉁이서점' })
          .getByRole('button', { name: '실패 상세 열기' })
          .click();
        await expect(other.getByText('버전 1 · 실패')).toBeVisible();
        expect(
          await other.evaluate(() => sessionStorage.getItem('studio-run')),
        ).toBe(id);
        return other;
      }
      async function clickRetry() {
        const [reply] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              r.url().endsWith('/runs/' + id + '/retry'),
          ),
          button('실패한 단계 다시 실행').click(),
        ]);
        expect(reply.request().postDataJSON()).toEqual({
          failureId: recovered.failureId,
        });
        return reply;
      }
      if (target === 'edited-draft' || restoresDraft) {
        const path = join(runDir, 'draft.md');
        if (!reviewedDraft || !recovered.failureId)
          throw new Error('승인 초안 또는 실패 기록 없음');
        const edited = reviewedDraft + '\n승인 이후 변경한 QA 문장입니다.\n';
        await writeFile(path, edited);
        const editedFiles = await snapshot();
        expect(editedFiles['draft.md']).not.toBe(after['draft.md']);
        expect(editedFiles['events.jsonl']).toBe(after['events.jsonl']);
        const cliLog = join(dir, 'cli.jsonl');
        const cliBefore = await readFile(cliLog, 'utf8');
        const reply = await clickRetry();
        expect(reply.status()).toBe(409);
        const conflict = await reply.json();
        expect(conflict).toEqual({ error: 'retry_conflict' });
        const alert = page.getByRole('alert');
        await expect(alert).toContainText('재실행 조건이 달라졌습니다.');
        const dashboardMessage = await alert.innerText();
        await page.reload();
        await page.getByRole('link', { name: '실행 현황' }).click();
        await expect(
          row.getByRole('cell', { name: '실패', exact: true }),
        ).toBeVisible();
        await row.getByRole('button').click();
        await expect(
          page.getByText('실패 단계 revision', { exact: false }),
        ).toBeVisible();
        await expect(button('revision.md')).toHaveCount(0);
        await button('draft.md').click();
        await expect(page.locator('[data-markdown-source]')).toHaveText(
          edited.trim(),
        );
        await delay(2000);
        const finalView = await (
          await page.request.get('/api/runs/' + id + '/view')
        ).json();
        expect(finalView).toEqual(recovered);
        const finalFiles = await snapshot();
        expect(Object.keys(finalFiles).sort()).toEqual([
          'draft.md',
          'events.jsonl',
        ]);
        expect(finalFiles).toEqual(editedFiles);
        const cliAfter = await readFile(cliLog, 'utf8');
        expect(cliAfter).toBe(cliBefore);
        Object.assign(evidence, {
          retryResponse: { status: reply.status(), ...conflict },
          dashboardMessage,
          finalView,
          approvedDraftSha256: after['draft.md'],
          editedFiles,
          filesAfterBlockedRetry: finalFiles,
          cliLogBeforeRetry: cliBefore
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
          cliLogAfterRetry: cliAfter
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        });
        if (restartBeforeRestore) {
          const restart = await restartServer();
          await page.getByRole('link', { name: '실행 현황' }).click();
          await expect(
            row.getByRole('cell', { name: '실패', exact: true }),
          ).toBeVisible();
          await row.getByRole('button').click();
          await expect(button('실패한 단계 다시 실행')).toBeEnabled();
          const reopened = await (
            await page.request.get('/api/runs/' + id + '/view')
          ).json();
          expect(reopened).toMatchObject({
            summary: recovered.summary,
            stepId: step,
            failureId: recovered.failureId,
            gate: null,
            results: ['draft.md'],
          });
          const filesAfterRestart = await snapshot();
          expect(filesAfterRestart).toEqual(editedFiles);
          expect(await readFile(cliLog, 'utf8')).toBe(cliAfter);
          evidence.restart = { ...restart, view: reopened, filesAfterRestart };
          if (retryEditedAfterRestart) {
            tabs.push(await openOtherTab());
            const replies = await retryFromBothTabs(
              tabs,
              id,
              reopened.failureId,
            );
            expect(replies.map((r) => r.status)).toEqual([409, 409]);
            for (const tab of tabs) {
              await expect(tab.getByRole('alert')).toContainText(
                '재실행 조건이 달라졌습니다.',
              );
              await expect(tab.getByText('버전 1 · 실패')).toBeVisible();
              await expect(
                tab.getByRole('button', { name: 'revision.md', exact: true }),
              ).toHaveCount(0);
            }
            const blockedView = await (
              await page.request.get('/api/runs/' + id + '/view')
            ).json();
            expect(blockedView).toEqual(reopened);
            const blockedFiles = await snapshot();
            expect(blockedFiles).toEqual(filesAfterRestart);
            const blockedCalls = await readFile(cliLog, 'utf8');
            expect(blockedCalls).toBe(cliAfter);
            evidence.blockedAfterRestart = {
              replies,
              view: blockedView,
              files: blockedFiles,
              cliLog: blockedCalls
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line)),
            };
          }
        }
        if (restoresDraft) {
          await writeFile(path, reviewedDraft);
          const restoredFiles = await snapshot();
          expect(restoredFiles).toEqual(after);
          await button('draft.md').click();
          await expect(page.locator('[data-markdown-source]')).toHaveText(
            reviewedDraft.trim(),
          );
          evidence.restoredDraftSha256 = restoredFiles['draft.md'];
        }
      }
      if (target === 'retry' || concurrentRetry || restoresDraft) {
        // Reopen the failed run from durable storage before retrying the approved revision.
        if (target === 'retry' && step === 'revision') {
          await restartServer();
        }
        await page.getByRole('link', { name: '실행 현황' }).click();
        await row.getByRole('button', { name: '실패 상세 열기' }).click();
        if (concurrentRetry) {
          if (tabs.length === 1) tabs.push(await openOtherTab());
          expect(recovered.failureId).toBeTruthy();
          const replies = await retryFromBothTabs(
            tabs,
            id,
            recovered.failureId,
          );
          evidence.retryResponses = replies;
          expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
        } else {
          const accepted = await clickRetry();
          expect(accepted.status()).toBe(200);
          evidence.acceptedRetryStatus = accepted.status();
        }
        const expected = step === 'draft' ? '승인 대기' : '완료';
        await page.getByRole('link', { name: '실행 현황' }).click();
        await expect(
          row.getByRole('cell', { name: expected, exact: true }),
        ).toBeVisible({ timeout: 145000 });
        if (concurrentRetry) {
          for (const tab of tabs) {
            await tab.getByRole('link', { name: '실행 현황' }).click();
            const completedRow = tab
              .getByRole('row')
              .filter({ hasText: '모퉁이서점' });
            await expect(
              completedRow.getByRole('cell', { name: '완료', exact: true }),
            ).toBeVisible();
            await completedRow.getByRole('button').click();
            await expect(tab.getByText('버전 1 · 완료')).toBeVisible();
            await expect(
              tab.getByRole('button', { name: '실패한 단계 다시 실행' }),
            ).toHaveCount(0);
            await tab
              .getByRole('button', { name: 'revision.md', exact: true })
              .click();
            await expect(tab.locator('[data-markdown-source]')).toHaveText(
              (await readFile(join(runDir, 'revision.md'), 'utf8')).trim(),
            );
          }
          evidence.tabDashboards = ['완료', '완료'];
        }
        const finalView = await (
          await page.request.get('/api/runs/' + id + '/view')
        ).json();
        const finalResults =
          step === 'draft' ? ['draft.md'] : ['draft.md', 'revision.md'];
        expect(finalView).toMatchObject({
          summary: {
            id,
            workflowVersion: 1,
            status: step === 'draft' ? 'waiting' : 'completed',
          },
          results: finalResults,
          stepId: step === 'draft' ? 'review' : 'revision',
          gate: step === 'draft' ? { kind: 'review' } : null,
        });
        const finalCalls = await calls();
        const extra = finalCalls.slice(afterCalls.length);
        expect(extra.map((c) => [c.step, c.event])).toEqual([
          [step, 'write'],
          [step, 'spawn'],
        ]);
        expect(finalCalls.slice(0, afterCalls.length)).toEqual(afterCalls);
        const events = (await readLog()).slice(log.length + 1);
        expect(events.filter((e) => e.status === 'queued')).toHaveLength(1);
        expect(events[0]).toMatchObject({ status: 'queued', stepId: step });
        expect(events.at(-1)).toMatchObject({
          status: finalView.summary.status,
          stepId: finalView.stepId,
          results: finalResults,
        });
        expect(
          events.every(
            (e) =>
              e.stepId === step ||
              (step === 'draft' &&
                e.stepId === 'review' &&
                e.status === 'waiting'),
          ),
        ).toBe(true);
        const files = await snapshot();
        expect(Object.keys(files)).toEqual(
          [...finalResults, 'events.jsonl'].sort(),
        );
        if (step === 'revision') {
          expect(files['draft.md']).toBe(before['draft.md']);
          expect(extra[0]).toMatchObject({
            priorDocumentSha256: before['draft.md'],
          });
          expect(await readFile(join(runDir, 'revision.md'), 'utf8')).toContain(
            '모퉁이서점',
          );
        } else {
          await row.getByRole('button').click();
          await button('검토할 문서 열기').click();
          await expect(page.locator('[data-markdown-source]')).toHaveText(
            (await readFile(join(runDir, 'draft.md'), 'utf8')).trim(),
          );
        }
        Object.assign(evidence, {
          dashboard: expected,
          results: finalResults,
          retryCalls: extra,
          filesAfterRetry: files,
          eventsAfterRetry: events,
        });
      }
    } finally {
      if (server.child.exitCode === null && server.child.signalCode === null)
        server.child.kill('SIGTERM');
      await server.exit;
      await writeFile(
        join(root, code + '.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
    }
  });
}

test('정상 업데이트 후 같은 인계문을 두 탭에서 승인해 후속 세션을 하나만 만든다', async ({
  page,
  context,
}) => {
  const dir = join(root, 'review-update');
  await mkdir(join(dir, 'scratch'), { recursive: true });
  let server = start(dir);
  try {
    await server.ready;
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-studio-client': 'browser',
    };
    await page.request.post('/api/session', { headers });
    const fixture = JSON.parse(await readFile('qa/workflow.json', 'utf8'));
    const response = await page.request.post('/api/workflows', {
      headers,
      data: {
        ...fixture,
        steps: [
          fixture.steps[0],
          { ...fixture.steps[1], startNextSession: true },
        ],
        links: fixture.links.slice(0, 1),
      },
    });
    expect(response.status()).toBe(201);
    const flow = await response.json();
    const id = crypto.randomUUID(),
      path = '/api/runs/' + id;
    expect(
      (
        await page.request.post('/api/runs', {
          headers,
          data: { id, workflowId: flow.id, workflowVersion: flow.version },
        })
      ).ok(),
    ).toBe(true);
    const link = '/#/runs/' + id + '/review';
    await page.goto(link);
    const view = async () => (await page.request.get(path + '/view')).json();
    const accept = (p: Page) =>
      p.getByRole('button', { name: '승인하고 다음 세션 시작' });
    await expect(accept(page)).toBeEnabled({ timeout: 120000 });
    const before = await view();
    const body = (await page.locator('[data-markdown-source]').textContent())!;
    expect(body.trim()).not.toBe('');
    const doc = join(dir, 'runs', id, 'draft.md');
    const digest = async () =>
      createHash('sha256')
        .update(await readFile(doc))
        .digest('hex');
    const sha = await digest();
    const calls = () => readFile(join(dir, 'cli.jsonl'), 'utf8');
    const previousCalls = await calls();
    const oldPid = server.child.pid;
    server.child.kill('SIGTERM');
    expect(await server.exit).toEqual({ code: 0, signal: null });
    server = start(dir);
    await server.ready;
    expect(server.child.pid).not.toBe(oldPid);
    const second = await context.newPage();
    const tabs = [page, second];
    await Promise.all(
      tabs.map(async (tab) => {
        await tab.goto(link);
        await tab.reload();
        await expect(accept(tab)).toBeEnabled();
        await expect(tab.locator('[data-markdown-source]')).toHaveText(
          body.trim(),
        );
      }),
    );
    expect(await view()).toEqual(before);
    expect(await digest()).toBe(sha);
    expect(await calls()).toBe(previousCalls);
    await page.screenshot({ path: join(dir, 'restored-review.png') });
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const responses = await Promise.all(
      tabs.map(async (tab) => {
        await tab.route(
          '**' + path + '/decision',
          async (route) => {
            if (++count === 2) release();
            await together;
            await route.continue();
          },
          { times: 1 },
        );
        const [r] = await Promise.all([
          tab.waitForResponse(
            (r) =>
              r.url().endsWith(path + '/decision') &&
              r.request().method() === 'POST',
          ),
          accept(tab).click(),
        ]);
        expect(r.request().postDataJSON().gateId).toBe(before.gate.id);
        return r.status();
      }),
    );
    expect(responses.some((s) => s === 200)).toBe(true);
    expect(responses.every((s) => s === 200 || s === 409)).toBe(true);
    await expect
      .poll(async () => (await view()).summary.status)
      .toBe('completed');
    const successor = (await view()).summary.nextSessionId;
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get('/api/runs/' + successor + '/view')
            ).json()
          ).summary.status,
        { timeout: 120000 },
      )
      .toBe('waiting');
    const runs = await (await page.request.get('/api/runs')).json();
    expect(runs.map((r: { id: string }) => r.id).sort()).toEqual(
      [id, successor].sort(),
    );
    const writes = (await calls())
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s))
      .filter((c) => c.event === 'write');
    expect(writes.map((c) => c.run)).toEqual([id, successor]);
    expect(await digest()).toBe(sha);
    const restoredPid = server.child.pid;
    const childPath = '/api/runs/' + successor;
    const gate = (await (await page.request.get(childPath + '/view')).json())
      .gate;
    const callsBeforeTamper = await calls();
    server.child.kill('SIGTERM');
    await server.exit;
    await writeFile(join(dir, 'runs', successor, 'draft.md'), '승인 문서 변경');
    server = start(dir);
    await server.ready;
    await page.reload();
    await page.request.post('/api/session', { headers });
    const invalid = await (await page.request.get(childPath + '/view')).json();
    expect(invalid).toMatchObject({
      summary: { status: 'failed' },
      gate: null,
    });
    expect(invalid.note).toContain('문서와 일치하지 않아');
    expect(
      (
        await page.request.post(childPath + '/decision', {
          headers,
          data: { gateId: gate.id, decision: 'accept' },
        })
      ).status(),
    ).toBe(409);
    expect(await calls()).toBe(callsBeforeTamper);
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify(
        {
          id,
          successor,
          sha,
          oldPid,
          newPid: restoredPid,
          changedDocumentBlocked: true,
          responses,
          callsBeforeApproval: 0,
          successors: 1,
        },
        null,
        2,
      ),
    );
  } finally {
    server.child.kill('SIGTERM');
    await server.exit;
  }
});
