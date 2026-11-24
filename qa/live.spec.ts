import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

type Action = '승인하고 계속' | '거절' | '작업 중단';
type Scenario = {
  name: string;
  actions: Action[];
  first?: number;
  interrupt?: 'draft' | 'revision';
  reopen?: boolean;
};
const scenarios: Scenario[] = [
  {
    name: 'Q01 검토 대기에서 다시 열고 승인',
    actions: ['승인하고 계속'],
    reopen: true,
  },
  { name: 'Q02 검토 거절', actions: ['거절'] },
  { name: 'Q03 초안 작성 중 중단', actions: [], interrupt: 'draft' },
  { name: 'Q04 검토 대기 중 중단', actions: ['작업 중단'] },
  {
    name: 'Q05 첫 탭 승인 후 수정 작성 중 둘째 탭 중단',
    actions: ['승인하고 계속'],
    interrupt: 'revision',
  },
  { name: 'Q06 두 탭 동시 승인', actions: ['승인하고 계속', '승인하고 계속'] },
  { name: 'Q07 두 탭 동시 거절', actions: ['거절', '거절'] },
  { name: 'Q08 승인과 거절 동시 요청', actions: ['승인하고 계속', '거절'] },
  {
    name: 'Q09 거절 직후 도착한 승인',
    actions: ['거절', '승인하고 계속'],
    first: 0,
  },
  {
    name: 'Q10 승인 직후 도착한 거절',
    actions: ['승인하고 계속', '거절'],
    first: 0,
  },
  {
    name: 'Q11 승인과 중단 동시 요청',
    actions: ['승인하고 계속', '작업 중단'],
  },
  {
    name: 'Q12 중단 직후 도착한 승인',
    actions: ['작업 중단', '승인하고 계속'],
    first: 0,
  },
  { name: 'Q13 두 탭 동시 중단', actions: ['작업 중단', '작업 중단'] },
];
const root = process.env.STUDIO_QA_DIR!;
const button = (p: Page, name: string) =>
  p.getByRole('button', { name, exact: true });
const jsonLines = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function present(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function decide(pages: Page[], id: string, scenario: Scenario) {
  const { actions, first } = scenario;
  const paths = actions.map(
    (a) => '/api/runs/' + id + (a === '작업 중단' ? '/stop' : '/decision'),
  );
  const replies = actions.map((_, i) =>
    pages[i]!.waitForResponse(
      (r) => r.url().endsWith(paths[i]!) && r.request().method() === 'POST',
    ),
  );
  const requests: { action: Action; gateId?: string; sent: number }[] = [];
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  for (const [i, action] of actions.entries()) {
    await pages[i]!.route(
      '**' + paths[i],
      async (route) => {
        const data = route.request().postDataJSON();
        requests[i] = { action, gateId: data?.gateId, sent: 0 };
        if (requests.filter(Boolean).length === actions.length) unblock();
        await barrier;
        if (first !== undefined && i !== first) {
          await replies[first];
          await delay(50);
        }
        requests[i]!.sent = performance.now();
        await route.continue();
      },
      { times: 1 },
    );
  }
  const [responses] = await Promise.all([
    Promise.all(replies),
    Promise.all(actions.map((a, i) => button(pages[i]!, a).click())),
  ]);
  expect(
    new Set(requests.flatMap((r) => (r.gateId ? [r.gateId] : []))).size,
  ).toBeLessThanOrEqual(1);
  return responses.map((r, i) => ({ ...requests[i]!, status: r.status() }));
}
for (const scenario of scenarios) {
  test(scenario.name, async ({ page, context }) => {
    const evidence: Record<string, unknown> = { scenario: scenario.name };
    await page.goto('/');
    await page.getByRole('link', { name: '흐름 설계' }).click();
    await page.getByRole('button', { name: '흐름 목록' }).click();
    await page
      .getByLabel('저장한 흐름')
      .selectOption({ label: '모퉁이서점 안내문 · Codex 승인 검증 · v1' });
    await button(page, '흐름 열기').click();
    const started = page.waitForResponse(
      (r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST',
    );
    if (scenario.first !== undefined && scenario.actions.includes('거절')) {
      let startRequests = 0;
      await page.route('**/api/runs', async (route) => {
        if (route.request().method() === 'POST') {
          startRequests++;
          await delay(350);
        }
        await route.continue();
      });
      await button(page, '저장한 버전 실행').evaluate((el) => {
        (el as HTMLButtonElement).click();
        (el as HTMLButtonElement).click();
      });
      await expect(button(page, '실행 접수 중…')).toBeDisabled();
      await started;
      expect(startRequests).toBe(1);
    } else await button(page, '저장한 버전 실행').click();
    const response = await started;
    expect(response.status()).toBe(200);
    const { summary } = await response.json();
    const id: string = summary.id;
    Object.assign(evidence, {
      id,
      cli: summary.cliVersion,
      version: summary.workflowVersion,
    });
    const dir = join(root, 'runs', id);
    const log = async () =>
      jsonLines(await readFile(join(dir, 'events.jsonl'), 'utf8'));
    const calls = async () =>
      jsonLines(await readFile(join(root, 'cli.jsonl'), 'utf8')).filter(
        (c) => c.run === id,
      );
    const tabs = [page];
    let before: Buffer | undefined;
    let verified = false;
    let approvedDuringStop = false;
    let completed = false,
      revisionStarted = false;
    const row = (p: Page) =>
      p.getByRole('row').filter({
        hasText: new Date(summary.recordedAt).toLocaleString('ko-KR'),
      });
    async function interrupt(p: Page, step: string) {
      let pid = 0;
      await expect
        .poll(
          async () => {
            pid =
              (await calls()).find(
                (c) => c.step === step && c.event === 'spawn',
              )?.pid ?? 0;
            return (
              pid > 0 &&
              present(pid) &&
              present(-pid) &&
              (await log()).at(-1)?.stepId === step
            );
          },
          { intervals: [25, 50], timeout: 15000 },
        )
        .toBe(true);
      const reply = p.waitForResponse(
        (r) =>
          r.url().endsWith('/' + id + '/stop') &&
          r.request().method() === 'POST',
      );
      await button(p, '작업 중단').click();
      expect((await reply).status()).toBe(200);
      expect(present(pid)).toBe(false);
      expect(present(-pid)).toBe(false);
      evidence.terminatedPid = pid;
    }
    try {
      expect(summary.provider).toBe('codex');
      expect(summary.workflowVersion).toBe(1);
      if (scenario.interrupt === 'draft') {
        await interrupt(page, 'draft');
      } else {
        await expect(button(page, '검토할 문서 열기')).toBeVisible({
          timeout: 145000,
        });
        if (scenario.reopen) await page.reload();
        before = await readFile(join(dir, 'draft.md'));
        expect(before.length).toBeGreaterThan(0);
        expect((await log()).at(-1)).toMatchObject({
          stepId: 'review',
          status: 'waiting',
          results: ['draft.md'],
          gate: 'review',
        });
        expect((await readdir(dir)).sort()).toEqual([
          'draft.md',
          'events.jsonl',
        ]);
        if (
          scenario.actions.length === 2 ||
          scenario.interrupt === 'revision'
        ) {
          const other = await context.newPage();
          tabs.push(other);
          await other.goto('/');
          await row(other).getByRole('button', { name: '검토 열기' }).click();
        }
        for (const tab of tabs) {
          await button(tab, '검토할 문서 열기').click();
          await expect(tab.locator('[data-markdown-source]')).toHaveText(
            before.toString().trim(),
          );
          expect(
            await tab.evaluate(() => sessionStorage.getItem('studio-run')),
          ).toBe(id);
        }
        if (scenario.reopen) {
          await expect(button(page, '승인하고 계속')).toBeEnabled();
          await page.screenshot({
            path: join(root, 'Q01-before-approval.png'),
          });
        }
        const decisions = await decide(tabs, id, scenario);
        evidence.decisions = decisions;
        if (
          scenario.first !== undefined &&
          scenario.actions.includes('거절') &&
          scenario.actions.includes('승인하고 계속')
        ) {
          for (const tab of tabs)
            await expect(
              tab.getByRole('status', { name: '최근 검토 결과' }),
            ).toHaveText(
              '사용자 검토 · ' +
                (scenario.actions[scenario.first] === '거절'
                  ? '거절됨'
                  : '승인 완료'),
            );
        }
        const codes = decisions.map((d) => d.status);
        const approved = decisions.some(
          (d) => d.action === '승인하고 계속' && d.status === 200,
        );
        const stop = scenario.actions.includes('작업 중단');
        if (
          scenario.actions.length === 1 ||
          scenario.actions[0] === scenario.actions[1]
        )
          expect(codes.every((n) => n === 200)).toBe(true);
        else if (scenario.first !== undefined)
          expect(codes).toEqual([200, 409]);
        else if (stop) {
          expect(codes[1]).toBe(200);
          expect([200, 409]).toContain(codes[0]);
        } else expect([...codes].sort()).toEqual([200, 409]);
        approvedDuringStop = approved && stop;
        if (scenario.interrupt === 'revision') {
          expect(approved).toBe(true);
          await interrupt(tabs[1]!, 'revision');
          revisionStarted = true;
        }
        completed = approved && !stop && !scenario.interrupt;
        revisionStarted ||= completed;
      }
      for (const tab of tabs) {
        await tab.getByRole('link', { name: '실행 현황' }).click();
        await expect(row(tab)).toContainText(completed ? '완료' : '중단됨', {
          timeout: 145000,
        });
        await tab.reload();
        await expect(row(tab)).toContainText(completed ? '완료' : '중단됨');
        await row(tab).getByRole('button', { name: '결과 열기' }).click();
        if (
          scenario.first !== undefined &&
          scenario.actions.includes('거절') &&
          scenario.actions.includes('승인하고 계속')
        ) {
          await tab.reload();
          await expect(
            tab.getByRole('status', { name: '최근 검토 결과' }),
          ).toHaveText('사용자 검토 · ' + (completed ? '승인 완료' : '거절됨'));
        }
        await expect(button(tab, '승인하고 계속')).toHaveCount(0);
        await expect(button(tab, 'draft.md')).toHaveCount(before ? 1 : 0);
        await expect(button(tab, 'revision.md')).toHaveCount(completed ? 1 : 0);
        if (before) {
          const name = completed ? 'revision.md' : 'draft.md';
          await button(tab, name).click();
          await expect(tab.locator('[data-markdown-source]')).toHaveText(
            (await readFile(join(dir, name), 'utf8')).trim(),
          );
        }
      }
      const events = await log(),
        final = events.at(-1);
      if (
        scenario.actions.includes('거절') &&
        !scenario.actions.includes('작업 중단')
      ) {
        expect(events.filter((e) => e.reviewDeclined)).toHaveLength(
          completed ? 0 : 1,
        );
        expect(events.filter((e) => e.reviewCompleted)).toHaveLength(
          completed ? 1 : 0,
        );
      }
      if (
        completed ||
        (scenario.actions[0] === '거절' && scenario.actions.length === 1)
      ) {
        const approvals = events.filter((e) => e.reviewCompleted);
        expect(approvals).toHaveLength(completed ? 1 : 0);
        if (completed) {
          const at = events.indexOf(approvals[0]);
          expect(approvals[0]).toMatchObject({
            stepId: 'review',
            status: 'running',
            gate: null,
          });
          expect(events[at - 1]).toMatchObject({
            stepId: 'review',
            status: 'waiting',
          });
          expect(events[at + 1]).toMatchObject({
            stepId: 'revision',
            status: 'running',
          });
        }
      }
      if (scenario.reopen) {
        await page.locator('summary').filter({ hasText: '실행 로그' }).click();
        const logList = page.getByRole('list', { name: '최근 실행 이벤트' });
        await expect(logList.getByText(/사용자 검토 · 승인 완료/)).toHaveCount(
          1,
        );
        await logList
          .locator('..')
          .screenshot({ path: join(root, 'Q01-after-approval.png') });
      }
      const results = completed
        ? ['draft.md', 'revision.md']
        : before
          ? ['draft.md']
          : [];
      expect(final).toMatchObject({
        status: completed ? 'completed' : 'stopped',
        results,
        gate: null,
      });
      expect((await readdir(dir)).sort()).toEqual(
        [...results, 'events.jsonl'].sort(),
      );
      const writes = (await calls())
        .filter((c) => c.event === 'write')
        .map((c) => c.step);
      if (approvedDuringStop) {
        revisionStarted = events.some(
          (e) => e.stepId === 'revision' && e.status === 'running',
        );
      }
      expect(writes).toEqual(
        revisionStarted ? ['draft', 'revision'] : ['draft'],
      );
      if (!revisionStarted)
        expect(events.some((e) => e.stepId === 'revision')).toBe(false);
      if (before) {
        expect(await readFile(join(dir, 'draft.md'))).toEqual(before);
        evidence.draftSha256 = sha(before);
      }
      if (completed) {
        const revised = await readFile(join(dir, 'revision.md'), 'utf8');
        expect(revised).not.toBe(before?.toString());
        for (const fact of [
          '방문 안내',
          '모퉁이서점',
          '느티로 12',
          '독립출판물',
        ])
          expect(revised).toContain(fact);
        expect(revised).toMatch(/10:00\s*[–~-]\s*18:00/);
      }
      await delay(1000);
      expect(await log()).toEqual(events);
      Object.assign(evidence, {
        dashboard: final.status,
        tabs: tabs.length,
        results,
        cliWrites: writes,
        final,
      });
      verified = true;
    } finally {
      await writeFile(
        join(root, scenario.name.split(' ')[0] + '.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
      if (!verified) {
        const stop = button(page, '작업 중단');
        if (await stop.isVisible()) await stop.click().catch(() => {});
      }
    }
  });
}

test('Q27 실제 Codex 변경안 취소·적용과 업무 미실행', async ({ page }) => {
  test.setTimeout(320_000);
  const request =
    '초안 뒤에 AI 검토를 넣고 수정본에는 초안과 검토 의견을 모두 전달해줘';
  await page.goto('/#/design');
  const saving = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/workflows') && r.request().method() === 'POST',
  );
  await button(page, '흐름 저장').click();
  const original = await (await saving).json();
  const get = async (path: string) =>
    (await page.request.get('/api/' + path)).json();
  const runFiles = async () =>
    (await readdir(join(root, 'runs')).catch(() => [])).sort();
  const calls = async () =>
    readFile(join(root, 'cli.jsonl'), 'utf8').catch(() => '');
  const before = {
    runs: await get('runs'),
    files: await runFiles(),
    cli: await calls(),
  };
  let starts = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/runs') && r.method() === 'POST') starts++;
  });
  const evidence = [];
  for (const action of ['취소', '변경안 적용']) {
    const dialog = page.getByRole('dialog');
    await page
      .getByRole('form', { name: '말로 흐름 수정' })
      .getByLabel('변경 요청')
      .fill(request);
    const waiting = page.waitForResponse(
      (r) => r.url().endsWith('/api/workflow-proposals'),
      { timeout: 145_000 },
    );
    await button(page, '변경안 만들기').click();
    const response = await waiting;
    expect(response.status()).toBe(200);
    const { definition } = await response.json();
    const extra = definition.steps.filter(
      (s: { id: string }) =>
        !original.definition.steps.some((o: { id: string }) => o.id === s.id),
    );
    expect(extra).toHaveLength(1);
    const [ai] = extra;
    expect(ai.kind).toBe('task');
    expect(ai.agent).toBe('codex');
    expect(ai.title + ' ' + ai.instructions).toMatch(/검토|검수|리뷰/);
    expect(ai.inputFrom).toEqual(['draft']);
    expect(definition.links).toEqual([
      { from: 'draft', to: ai.id },
      { from: ai.id, to: 'review' },
      { from: 'review', to: 'revision' },
    ]);
    const find = (id: string) =>
      definition.steps.find((s: { id: string }) => s.id === id);
    const oldGate = original.definition.steps.find(
      (s: { id: string; position: { x: number; y: number } }) =>
        s.id === 'review',
    )!;
    expect(ai.position).toEqual(oldGate.position);
    expect(find('review')).toEqual({
      ...oldGate,
      position: { x: oldGate.position.x + 240, y: oldGate.position.y },
    });
    expect(find('draft').position).toEqual(
      original.definition.steps[0]!.position,
    );
    expect([...find('revision').inputFrom].sort()).toEqual(
      ['draft', ai.id].sort(),
    );
    await expect(dialog.getByLabel('변경안 와이어')).toContainText(ai.title);
    const receiving = dialog
      .getByLabel('문서 연결 변경')
      .getByRole('listitem')
      .filter({ hasText: '수정본 작성' });
    await expect(receiving).toContainText('초안 작성');
    await expect(receiving).toContainText(ai.title);
    if (action === '변경안 적용')
      await dialog.screenshot({ path: join(root, 'Q27-wire.png') });
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await get('workflows/' + original.id)).toEqual(original);
    const graph = page.getByLabel('작업 흐름 노드');
    await expect(graph.locator('.react-flow__node')).toHaveCount(
      action === '취소' ? 3 : 4,
    );
    if (action === '취소')
      await expect(button(page, '흐름 저장')).toBeDisabled();
    else {
      await expect(button(page, '저장한 버전 실행')).toBeDisabled();
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/workflows/' + original.id) &&
          r.request().method() === 'PUT',
      );
      await button(page, '흐름 저장').click();
      const version = await (await saved).json();
      expect(version.version).toBe(2);
      expect(version.definition).toEqual(definition);
      expect(await get('workflows/' + original.id + '/versions/1')).toEqual(
        original,
      );
    }
    expect(await get('runs')).toEqual(before.runs);
    expect(await runFiles()).toEqual(before.files);
    expect(await calls()).toBe(before.cli);
    expect(starts).toBe(0);
    const design = jsonLines(
      await readFile(join(root, 'design-cli.jsonl'), 'utf8'),
    );
    const last = design.slice(-3);
    expect(last.map((item) => item.event)).toEqual([
      'request',
      'spawn',
      'response',
    ]);
    expect(last[0].request).toBe(request);
    expect(last[1].pid).toBeGreaterThan(0);
    evidence.push({
      action,
      definition,
      serverVersion: (await get('workflows/' + original.id)).version,
      designPid: last[1].pid,
      proposedEdits: last[2].edits,
      additionalBusinessCalls: 0,
      additionalRuns: 0,
    });
  }
  await writeFile(
    join(root, 'Q27.json'),
    JSON.stringify({ request, original, evidence }, null, 2),
  );
});

function designChecks(page: Page) {
  const get = async (path: string) => {
    const response = await page.request.get('/api/' + path);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const activity = async () => ({
    runs: await get('runs'),
    folders: existsSync(join(root, 'runs'))
      ? (await readdir(join(root, 'runs'))).sort()
      : [],
    cli: existsSync(join(root, 'cli.jsonl'))
      ? await readFile(join(root, 'cli.jsonl'), 'utf8')
      : '',
  });
  return { get, activity };
}

test('Q28 실제 Codex 목표 설계 취소·신규 저장과 업무 미실행', async ({
  page,
}) => {
  test.setTimeout(320_000);
  const goal = '매장 소개 초안을 쓰고 내 승인을 받은 뒤 수정본을 만들어줘';
  await page.goto('/#/design');
  await button(page, '흐름 목록').click();
  const library = page.getByLabel('저장한 흐름');
  await library.selectOption({
    label: '모퉁이서점 안내문 · Codex 승인 검증 · v1',
  });
  const oldId = await library.inputValue();
  await button(page, '흐름 열기').click();
  await expect(library).toBeHidden();
  const { get, activity } = designChecks(page);
  const original = await get('workflows/' + oldId);
  const workflows = await get('workflows');
  const before = await activity();
  const results = [];
  let runStarts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/runs')) runStarts++;
  });
  for (const action of ['취소', '새 흐름 적용']) {
    if (!(await library.isVisible())) await button(page, '흐름 목록').click();
    await button(page, '목표로 새 흐름 만들기').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('업무 목표').fill(goal);
    const responding = page.waitForResponse(
      (r) => r.url().endsWith('/api/workflow-proposals'),
      { timeout: 145_000 },
    );
    await button(page, '설계안 만들기').click();
    const response = await responding;
    expect(response.request().postDataJSON()).toEqual({
      mode: 'create',
      request: goal,
    });
    expect(response.status()).toBe(200);
    const { definition } = await response.json();
    expect(definition.goal).toBe(goal);
    const [draft, gate, revision] = definition.steps;
    expect(definition.steps.map((s: { kind: string }) => s.kind)).toEqual([
      'task',
      'review',
      'task',
    ]);
    expect(draft.title + ' ' + draft.instructions).toMatch(/초안/);
    expect(revision.title + ' ' + revision.instructions).toMatch(/수정/);
    expect(revision.inputFrom).toEqual([draft.id]);
    expect(definition.links).toEqual([
      { from: draft.id, to: gate.id },
      { from: gate.id, to: revision.id },
    ]);
    const wire = dialog.getByLabel('변경안 와이어');
    for (const step of definition.steps)
      await expect(wire).toContainText(step.title);
    await expect(wire).toContainText('사용자 승인');
    expect(await get('workflows')).toEqual(workflows);
    if (action === '새 흐름 적용')
      await dialog.screenshot({ path: join(root, 'Q28-wire.png') });
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await get('workflows')).toEqual(workflows);
    expect(await get('workflows/' + oldId)).toEqual(original);
    expect(await activity()).toEqual(before);
    let savedId = null;
    if (action === '취소') {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        original.definition.name,
      );
      await expect(button(page, '흐름 저장')).toBeDisabled();
    } else {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        definition.name,
      );
      await expect(button(page, '작업 실행 · 연결 준비 중')).toBeDisabled();
      const saving = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/workflows') && r.request().method() === 'POST',
      );
      await button(page, '흐름 저장').click();
      const created = await saving;
      expect(created.status()).toBe(201);
      const saved = await created.json();
      savedId = saved.id;
      expect(saved.id).not.toBe(oldId);
      expect(saved.version).toBe(1);
      expect(saved.definition).toEqual(definition);
      expect(await get('workflows/' + saved.id)).toEqual(saved);
      expect(await get('workflows')).toHaveLength(workflows.length + 1);
      expect(await get('workflows/' + oldId)).toEqual(original);
      expect(await activity()).toEqual(before);
    }
    expect(runStarts).toBe(0);
    const trace = jsonLines(
      await readFile(join(root, 'design-cli.jsonl'), 'utf8'),
    ).slice(-3);
    expect(trace.map((i) => i.event)).toEqual(['request', 'spawn', 'response']);
    expect(trace[0].request).toBe(goal);
    expect(trace[1].pid).toBeGreaterThan(0);
    results.push({
      action,
      definition,
      designPid: trace[1].pid,
      savedId,
      workflowsBefore: workflows.length,
      workflowsAfter: (await get('workflows')).length,
      additionalBusinessCalls: 0,
      additionalRuns: 0,
      additionalRunFolders: 0,
    });
  }
  await writeFile(
    join(root, 'Q28.json'),
    JSON.stringify({ goal, originalWorkflowId: oldId, results }, null, 2),
  );
});

for (const scenario of [
  {
    code: 'Q29',
    title: '모호한 목표는 문서 종류를 묻고 답변 뒤에만 와이어를 제안',
    request: '매장 일을 도와줘',
    answer: '매장 소개 초안을 쓰고 승인 뒤 수정해줘',
  },
  {
    code: 'Q30',
    title: 'Slack 발송 미지원 안내 후 문서 작성만 제안',
    request: '매장 소개를 작성하고 Slack으로 발송해줘',
    answer: '발송용 문서까지만 만들어줘',
  },
]) {
  test(scenario.code + ' ' + scenario.title, async ({ page }) => {
    test.setTimeout(320_000);
    const { request, answer, code } = scenario;
    await page.goto('/#/design');
    await button(page, '흐름 목록').click();
    await expect(
      page.getByLabel('저장한 흐름').locator('option').nth(1),
    ).toBeAttached();
    await button(page, '목표로 새 흐름 만들기').click();
    const dialog = page.getByRole('dialog');
    const { get, activity } = designChecks(page);
    const workflows = await get('workflows');
    const before = await activity();
    const writes: string[] = [];
    const externalRequests: string[] = [];
    const localOrigin = new URL(page.url()).origin;
    page.context().on('request', (r) => {
      const url = new URL(r.url());
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        url.origin !== localOrigin
      )
        externalRequests.push(url.origin);
    });
    page.on('request', (r) => {
      if (
        r.method() !== 'GET' &&
        /\/api\/(?:workflows|runs)(?:\/|$)/.test(r.url())
      )
        writes.push(r.method() + ' ' + r.url());
    });
    const trace = async () =>
      existsSync(join(root, 'design-cli.jsonl'))
        ? jsonLines(await readFile(join(root, 'design-cli.jsonl'), 'utf8'))
        : [];
    const offset = (await trace()).length;
    async function unchanged() {
      expect(await get('workflows')).toEqual(workflows);
      expect(await activity()).toEqual(before);
      expect(writes).toEqual([]);
      expect(externalRequests).toEqual([]);
    }
    async function submit(label: string) {
      const responding = page.waitForResponse(
        (r) => r.url().endsWith('/api/workflow-proposals'),
        { timeout: 145_000 },
      );
      await dialog.getByRole('button', { name: label, exact: true }).click();
      const response = await responding;
      expect(response.status()).toBe(200);
      return response.json();
    }
    await dialog.getByLabel('업무 목표').fill(request);
    const first = await submit('설계안 만들기');
    expect(first.kind).toBe('question');
    if (code === 'Q30') {
      expect(first.text).toMatch(/Slack|슬랙/i);
      expect(first.text).toMatch(
        /지원.{0,12}(않|못|되지|안)|미지원|수\s*없|불가|불가능|제공.{0,8}않/,
      );
      expect(first.text).toMatch(
        /문서|메시지|원고|초안|소개\s*(?:글|문|내용)|문안|문구/,
      );
      expect(first.text).toContain('?');
    } else {
      expect(first.text).toMatch(/어떤|무엇|종류|필요|무슨/);
      expect(first.text).toMatch(/문서|자료|초안|안내문|소개글|작성물/);
    }
    await expect(dialog.getByText(first.text, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('변경안 와이어')).toHaveCount(0);
    await expect(button(page, '새 흐름 적용')).toHaveCount(0);
    await expect(button(page, '답변 보내기')).toBeDisabled();
    await dialog.screenshot({ path: join(root, code + '-question.png') });
    await unchanged();
    const entry = dialog.getByLabel('내 답변');
    await entry.fill('   ');
    await expect(button(page, '답변 보내기')).toBeDisabled();
    await entry.fill(answer);
    await expect(dialog.getByLabel('변경안 와이어')).toHaveCount(0);
    await unchanged();
    const firstTrace = (await trace()).slice(offset);
    expect(firstTrace.map((i) => i.event)).toEqual([
      'request',
      'spawn',
      'response',
    ]);
    expect(firstTrace[0].request).toBe(request);
    expect(firstTrace[1].pid).toBeGreaterThan(0);
    expect(firstTrace[2].edits.steps).toEqual([]);
    const second = await submit('답변 보내기');
    expect(second.kind).toBe('proposal');
    const { definition } = second;
    if (code === 'Q30') {
      const tasks = definition.steps.filter(
        (s: { kind: string }) => s.kind === 'task',
      );
      expect(tasks.length).toBeGreaterThan(0);
      expect(definition.goal).toMatch(/매장|점포/);
      expect(definition.goal).toMatch(/작성|준비|완성|소개문|문서/);
      for (const step of definition.steps) {
        if (step.kind === 'review') {
          expect(step.title).toMatch(/문서|소개|검토|확인|승인|초안/);
        } else {
          expect(step).toMatchObject({ kind: 'task', agent: 'codex' });
          expect(step.title).toMatch(
            /작성|초안|문안|편집|교정|검토|완성|정리|다듬/,
          );
        }
        // A publication-ready document may mention Slack. Reject an instruction to deliver it.
        const action =
          /(?:발송|전송|게시|업로드)(?:하기|하세요|하라|한다|합니다|해\s*주세요)|(?:채널|Slack|슬랙)(?:에|으로)[^.!?\n]{0,35}(?:보내(?:기|세요)|전달(?:하기|하세요|한다|합니다))|(?:문서|소개문|문안|파일|메시지)[을를]\s*전달(?:하기|하세요|한다|합니다)|(?:발송|전송|게시|업로드)\s*$/i;
        expect(step.title).not.toMatch(action);
        expect(step.instructions ?? '').not.toMatch(action);
      }
    } else {
      const [draft, gate, revision] = definition.steps;
      expect(definition.steps.map((s: { kind: string }) => s.kind)).toEqual([
        'task',
        'review',
        'task',
      ]);
      expect(draft.title + ' ' + draft.instructions).toMatch(/매장|점포/);
      expect(draft.title + ' ' + draft.instructions).toContain('초안');
      expect(revision.title + ' ' + revision.instructions).toMatch(/수정|개정/);
      expect(revision.inputFrom).toEqual([draft.id]);
      expect(definition.links).toEqual([
        { from: draft.id, to: gate.id },
        { from: gate.id, to: revision.id },
      ]);
      expect(definition.goal).toMatch(/승인/);
    }
    const wire = dialog.getByLabel('변경안 와이어');
    for (const s of definition.steps) await expect(wire).toContainText(s.title);
    if (code === 'Q29') await expect(wire).toContainText('사용자 승인');
    await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
    await dialog.screenshot({ path: join(root, code + '-wire.png') });
    const secondTrace = (await trace()).slice(offset + 3);
    expect(secondTrace.map((i) => i.event)).toEqual([
      'request',
      'spawn',
      'response',
    ]);
    expect(secondTrace[0]).toMatchObject({
      request,
      clarifications: [{ question: first.text, answer }],
    });
    expect(secondTrace[1].pid).toBeGreaterThan(0);
    const designItems = [firstTrace[2].itemTypes, secondTrace[2].itemTypes];
    for (const items of designItems) {
      expect(items).toContain('agent_message');
      expect(
        items.filter(
          (type: string) => !['agent_message', 'reasoning'].includes(type),
        ),
      ).toEqual([]);
    }
    await unchanged();
    await writeFile(
      join(root, code + '.json'),
      JSON.stringify(
        {
          request,
          question: first.text,
          answer,
          definition,
          designPids: [firstTrace[1].pid, secondTrace[1].pid],
          designItems,
          externalBrowserRequests: externalRequests,
          beforeAnswer: {
            workflowCount: workflows.length,
            workflowWrites: 0,
            businessCalls: 0,
            newRuns: 0,
            newRunFolders: 0,
            wireShown: false,
          },
          afterAnswer: {
            workflowCount: workflows.length,
            workflowWrites: 0,
            businessCalls: 0,
            newRuns: 0,
            newRunFolders: 0,
            wireShown: true,
          },
        },
        null,
        2,
      ),
    );
  });
}

test('Q31 완료한 흐름의 AI 검토 지침을 바꾸고 새 승인 뒤 수정', async ({
  page,
}) => {
  test.setTimeout(360000);
  const instructions = '주소와 영업시간을 원본 자료와 대조해줘';
  const definition = JSON.parse(await readFile('qa/workflow.json', 'utf8'));
  const [draft, review, revision] = definition.steps;
  const critique = {
    ...draft,
    id: 'critique',
    title: 'AI 검토',
    instructions: '초안에 매장 이름과 취급 품목이 담겼는지 확인하세요.',
    inputFrom: ['draft'],
  };
  definition.steps = [
    draft,
    critique,
    review,
    { ...revision, inputFrom: ['draft', 'critique'] },
  ];
  definition.links = [
    { from: 'draft', to: 'critique' },
    { from: 'critique', to: 'review' },
    { from: 'review', to: 'revision' },
  ];
  await page.goto('/');
  const api = async (path: string, body?: unknown) =>
    page.evaluate(
      async ({ path, body }) => {
        const r = await fetch(
          '/api' + path,
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
        );
        return { status: r.status, data: await r.json() };
      },
      { path, body },
    );
  await page.evaluate(() =>
    fetch('/api/session', {
      method: 'POST',
      headers: { 'X-Studio-Client': 'browser' },
    }).then((r) => r.status),
  );
  const saved = await api('/workflows', definition);
  expect(saved.status).toBe(201);
  const oldId = crypto.randomUUID();
  expect(
    (
      await api('/runs', {
        id: oldId,
        workflowId: saved.data.id,
        workflowVersion: 1,
      })
    ).status,
  ).toBe(200);
  await page.goto('/#/runs/' + oldId);
  const pathFor = (id: string, file: string) => join(root, 'runs', id, file);
  const snapshot = async (id: string) => {
    const names = (await readdir(join(root, 'runs', id))).sort();
    return Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name,
          sha(await readFile(pathFor(id, name))),
        ]),
      ),
    );
  };
  const calls = async (id: string) =>
    jsonLines(await readFile(join(root, 'cli.jsonl'), 'utf8')).filter(
      (c) => c.run === id,
    );
  async function readReview(id: string) {
    await expect(button(page, '검토할 문서 열기')).toBeVisible({
      timeout: 150000,
    });
    const gate = (await api('/runs/' + id + '/view')).data.gate;
    expect(gate.kind).toBe('review');
    await expect(button(page, '승인하고 계속')).toBeEnabled();
    await expect(page.locator('[data-markdown-source]')).toHaveText(
      (await readFile(pathFor(id, 'critique.md'), 'utf8')).trim(),
    );
    return gate.id;
  }
  const oldGate = await readReview(oldId);
  await button(page, '승인하고 계속').click();
  const restart = page.getByText('단계 지침 저장 또는 다시 실행', {
    exact: true,
  });
  await expect(restart).toBeVisible({ timeout: 150000 });
  const before = await snapshot(oldId);
  const oldCalls = await calls(oldId);
  await restart.click();
  await page.getByLabel('변경할 단계').selectOption('critique');
  await page.getByLabel('새 작업 지침').fill(instructions);
  const started = page.waitForResponse((r) =>
    r.url().endsWith('/' + oldId + '/rerun'),
  );
  await button(page, '지침 저장하고 이 단계부터 다시 실행').click();
  const response = await started;
  expect(response.status()).toBe(200);
  const { summary } = await response.json();
  const id = summary.id;
  expect(id).not.toBe(oldId);
  expect(summary).toMatchObject({
    workflowVersion: 2,
    origin: { runId: oldId, stepId: 'critique' },
  });
  const version = async (v: number) =>
    (await api('/workflows/' + saved.data.id + '/versions/' + v)).data
      .definition;
  const expected = structuredClone(saved.data.definition);
  expected.steps[1].instructions = instructions;
  expect(await version(1)).toEqual(saved.data.definition);
  expect(await version(2)).toEqual(expected);
  const gate = await readReview(id);
  const checked = await readFile(pathFor(id, 'critique.md'), 'utf8');
  expect(checked).toMatch(/주소|느티로/);
  expect(checked).toMatch(/영업\s*시간|10:00|18:00/);

  expect(gate).not.toBe(oldGate);
  expect(
    (
      await api('/runs/' + id + '/decision', {
        gateId: oldGate,
        decision: 'accept',
      })
    ).status,
  ).toBe(409);
  const atGate = await snapshot(id);
  expect(Object.keys(atGate)).toEqual([
    'critique.md',
    'draft.md',
    'events.jsonl',
  ]);
  expect(atGate['draft.md']).toBe(before['draft.md']);
  expect(
    (await calls(id)).filter((c) => c.event === 'write').map((c) => c.step),
  ).toEqual(['critique']);
  const approval = page.waitForResponse((r) =>
    r.url().endsWith('/' + id + '/decision'),
  );
  await button(page, '승인하고 계속').click();
  expect((await approval).status()).toBe(200);
  await expect(page.getByText('버전 2 · 완료', { exact: true })).toBeVisible({
    timeout: 150000,
  });
  const after = await snapshot(id);
  expect(Object.keys(after)).toEqual([
    'critique.md',
    'draft.md',
    'events.jsonl',
    'revision.md',
  ]);
  expect(after['draft.md']).toBe(before['draft.md']);
  const trace = await calls(id);
  const writes = trace.filter((c) => c.event === 'write');
  expect(writes.map((c) => c.step)).toEqual(['critique', 'revision']);
  expect(writes[0]).toMatchObject({
    instructions,
    sourceSha256: sha(Buffer.from(definition.input)),
    inputs: [{ filename: 'draft.md', sha256: before['draft.md'] }],
  });
  expect(writes[1].inputs).toEqual([
    { filename: 'draft.md', sha256: before['draft.md'] },
    { filename: 'critique.md', sha256: after['critique.md'] },
  ]);
  expect(trace.filter((c) => c.event === 'spawn').map((c) => c.step)).toEqual([
    'critique',
    'revision',
  ]);
  const events = (await api('/runs/' + id + '/events')).data;
  const waitIndex = events.findIndex(
    (e: { status: string; stepId: string }) =>
      e.status === 'waiting' && e.stepId === 'review',
  );
  expect(waitIndex).toBeGreaterThan(0);
  expect(
    events.findIndex((e: { stepId: string }) => e.stepId === 'revision'),
  ).toBeGreaterThan(waitIndex);
  expect(events.at(-1).status).toBe('completed');
  await page.getByRole('link', { name: '이전 실행 보기' }).click();
  await expect(page.getByText('버전 1 · 완료', { exact: true })).toBeVisible();
  await button(page, 'revision.md').click();
  await expect(page.locator('[data-markdown-source]')).toHaveText(
    (await readFile(pathFor(oldId, 'revision.md'), 'utf8')).trim(),
  );
  const oldAfter = await snapshot(oldId);
  expect(oldAfter).toEqual(before);
  expect(await calls(oldId)).toEqual(oldCalls);
  await writeFile(
    join(root, 'Q31.json'),
    JSON.stringify(
      {
        id,
        oldId,
        cli: summary.cliVersion,
        instructions,
        dashboard: 'v1·v2 완료',
        oldGate,
        gate,
        before,
        oldAfter,
        atGate,
        after,
        trace,
        results: Object.keys(after).filter((n) => n.endsWith('.md')),
      },
      null,
      2,
    ),
  );
});

for (const [code, title, detail, status, field] of [
  [
    'Q32',
    '명시',
    '안내문과 전표 공통 영업시간: 10:00–18:00.',
    'known',
    'address',
  ],
  ['Q33', '누락', '취급 품목: 독립출판물.', 'missing', 'hours'],
  [
    'Q34',
    '충돌',
    '같은 매장, 같은 날짜에 적용되는 공지 A의 영업시간: 10:00–18:00. 공지 B의 영업시간: 12:00–20:00. 어느 공지가 최신인지는 알 수 없음.',
    'conflict',
    'address',
  ],
] as const) {
  test(
    code + ' 매장 영업시간 ' + title + ' 근거 비교와 선택 반영',
    async ({ page }) => {
      test.setTimeout(300000);
      const source = '가상 매장 모퉁이서점. 주소: 느티로 12. ' + detail;
      const legacy =
        '# 방문 안내\n주소: 느티로 1\n영업시간: 09:00–17:00\n안내: 방문 환영';
      const originalTask =
        '비교 실습용 이전 안내문입니다. 제공 자료와 차이를 남겨야 합니다. 질문이나 설명 없이 다음 다섯 줄 이내의 원문을 document 본문으로 한 글자도 바꾸지 말고 그대로 출력하세요.\n' +
        legacy;
      const revisionTask =
        '원본 자료의 주소와 영업시간으로 갱신한 방문 안내문을 작성하세요. 자료에 영업시간이 없으면 값에 미기재, 자료가 충돌하면 값에 확인 필요만 적으세요. 추측하거나 질문하지 마세요. 정확히 네 줄: # 방문 안내, 주소: (값), 영업시간: (값), 안내: 새 안내. 각 줄을 줄바꿈으로 구분하세요.';
      await page.goto('/');
      await page.evaluate(() =>
        fetch('/api/session', {
          method: 'POST',
          headers: { 'X-Studio-Client': 'browser' },
        }).then((r) => r.status),
      );
      const api = async (path: string, body?: unknown) =>
        page.evaluate(
          async ({ path, body }) => {
            const r = await fetch(
              '/api' + path,
              body === undefined
                ? {}
                : {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  },
            );
            return { status: r.status, data: await r.json() };
          },
          { path, body },
        );
      const created = await api('/workflows', {
        name: '비교 실습 · ' + title,
        input: source,
        steps: [
          {
            id: 'notice',
            kind: 'task',
            title: '방문 안내',
            agent: 'codex',
            position: { x: 0, y: 0 },
            instructions: originalTask,
            inputFrom: [],
          },
        ],
        links: [],
      });
      expect(created.status).toBe(201);
      const oldId = crypto.randomUUID();
      expect(
        (
          await api('/runs', {
            id: oldId,
            workflowId: created.data.id,
            workflowVersion: 1,
          })
        ).status,
      ).toBe(200);
      const completed = async (id: string) =>
        expect
          .poll(
            async () =>
              (await api('/runs/' + id + '/view')).data.summary.status,
            { timeout: 130000 },
          )
          .toBe('completed');
      await completed(oldId);
      const branch = await api('/runs/' + oldId + '/rerun', {
        stepId: 'notice',
        instructions: revisionTask,
      });
      expect(branch.status).toBe(200);
      const id = branch.data.summary.id;
      await completed(id);
      const snapshots = async () =>
        Promise.all(
          [oldId, id].map(async (run) => {
            const dir = join(root, 'runs', run);
            return Object.fromEntries(
              await Promise.all(
                (await readdir(dir))
                  .sort()
                  .map(async (name) => [
                    name,
                    sha(await readFile(join(dir, name))),
                  ]),
              ),
            );
          }),
        );
      const before = await snapshots();
      await page.goto('/#/runs');
      const row = page
        .getByRole('row')
        .filter({ hasText: '비교 실습 · ' + title })
        .filter({ hasText: 'v2' });
      await row.getByRole('link', { name: '문서 비교' }).click();
      const box = page.getByRole('region', { name: '원안과 수정안 비교' });
      const docs = box.locator('article');
      await expect(docs).toHaveCount(2);
      const rects = await docs.evaluateAll((nodes) =>
        nodes.map((n) => ({
          x: n.getBoundingClientRect().left,
          y: n.getBoundingClientRect().top,
        })),
      );
      expect(rects[0]!.x).toBeLessThan(rects[1]!.x);
      expect(rects[0]!.y).toBe(rects[1]!.y);
      const path = '/runs/' + id + '/comparison';
      const initial = (await api(path)).data;
      expect(initial.review).toBeNull();
      expect(initial.applied).toBeNull();
      expect(initial.source).toBe(source);
      expect(initial.original.text.trim()).toBe(legacy);
      await expect(docs.nth(0).locator('pre')).toHaveText(
        initial.original.text.trim(),
      );
      await expect(docs.nth(1).locator('pre')).toHaveText(
        initial.revision.text.trim(),
      );
      const analyzed = page.waitForResponse(
        (r) => r.url().endsWith(path + '/review'),
        { timeout: 130000 },
      );
      await button(page, 'Codex로 근거 대조').click();
      const response = await analyzed;
      expect(response.status()).toBe(200);
      const c = await response.json();
      expect(c.review.facts.address).toMatchObject({
        status: 'known',
        original: { verdict: 'mismatch' },
        revision: { verdict: 'match' },
      });
      const hours = c.review.facts.hours;
      expect(hours.status).toBe(status);
      for (const side of ['original', 'revision'] as const) {
        expect(hours[side].verdict).toBe(
          status === 'known'
            ? side === 'original'
              ? 'mismatch'
              : 'match'
            : 'uncertain',
        );
      }
      expect(hours.evidence.every((q: string) => source.includes(q))).toBe(
        true,
      );
      if (status === 'missing') expect(hours.evidence).toEqual([]);
      if (status === 'conflict')
        expect(hours.evidence.join(' ')).toMatch(/12:00/);
      await expect(
        box
          .getByRole('row')
          .filter({ has: page.getByRole('rowheader', { name: '영업시간' }) }),
      ).toContainText(
        {
          known: '근거 있음',
          missing: '원본에 없음',
          conflict: '원본끼리 충돌',
        }[status],
      );
      const apply = button(page, '선택한 변경 반영');
      await expect(apply).toBeDisabled();
      const label = field === 'address' ? '주소' : '영업시간';
      await box
        .getByRole('checkbox', { name: new RegExp('^' + label) })
        .check();
      const expected = c.original.text.replace(
        c.review.facts[field].original.quote,
        c.review.facts[field].revision.quote,
      );
      expect(expected).not.toBe(c.revision.text);
      await expect(box.getByLabel('선택 결과 미리보기')).toHaveText(
        expected.trim(),
      );
      expect((await api(path)).data.applied).toBeNull();
      await box.evaluate((el) => (el.scrollTop = 0));
      await box.screenshot({ path: join(root, code + '-comparison.png') });
      const applied = page.waitForResponse((r) =>
        r.url().endsWith(path + '/apply'),
      );
      await apply.click();
      expect((await applied).status()).toBe(200);
      await page.reload();
      await expect(
        box.getByRole('heading', { name: '저장한 반영본' }),
      ).toBeVisible();
      const saved = (await api(path)).data;
      expect(saved.version).toBe(1);
      expect(saved.selected).toHaveLength(1);
      expect(saved.applied).toBe(expected);
      const stale = await api(path + '/apply', {
        version: 0,
        fingerprint: saved.fingerprint,
        selected: [],
      });
      expect(stale.status).toBe(409);
      const injected = await api(path + '/apply', {
        version: 1,
        fingerprint: saved.fingerprint,
        selected: saved.selected,
        applied: '임의의 본문',
      });
      expect(injected.status).toBe(400);
      expect((await api(path)).data.applied).toBe(expected);
      expect(saved.applied).toContain('방문 환영');
      const download = await box
        .getByRole('link', { name: '반영본 다운로드' })
        .getAttribute('href');
      expect(decodeURIComponent(download!.split(',').slice(1).join(','))).toBe(
        expected,
      );
      expect(await snapshots()).toEqual(before);
      const writes = jsonLines(
        await readFile(join(root, 'cli.jsonl'), 'utf8'),
      ).filter((c) => [id, oldId].includes(c.run) && c.event === 'write');
      expect(writes.map((c) => c.sourceSha256)).toEqual([
        sha(Buffer.from(source)),
        sha(Buffer.from(source)),
      ]);
      const trace = jsonLines(
        await readFile(join(root, 'comparison-cli.jsonl'), 'utf8'),
      ).filter((e) => e.sourceSha256 === sha(Buffer.from(source)));
      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        originalSha256: before[0]!['notice.md'],
        revisionSha256: before[1]!['notice.md'],
      });
      expect(trace[0].pid).toBeGreaterThan(0);
      await writeFile(
        join(root, code + '.json'),
        JSON.stringify(
          {
            id,
            oldId,
            source,
            facts: c.review.facts,
            selected: label,
            before,
            after: await snapshots(),
            applied: saved.applied,
            trace,
            writes,
            dashboard: '선택 반영 확인',
          },
          null,
          2,
        ),
      );
    },
  );
}

test('Q37 한 줄 제안은 선택한 때만 Codex 변경안을 만들고 승인 추가 뒤 숨긴다', async ({
  page,
}) => {
  await page.goto('/#/design');
  const composer = page.getByRole('form', { name: '말로 흐름 수정' });
  const suggestion = composer.getByRole('button', {
    name: '[Quick response] 초안을 내가 확인한 뒤 수정해줘',
    exact: true,
  });
  let requests = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/workflow-proposals'))
      requests++;
  });
  await expect(composer).toBeVisible();
  await expect(suggestion).toHaveCount(0);
  await page.getByLabel('편집할 단계').selectOption('review');
  await button(page, '단계 삭제').click();
  await expect(suggestion).toBeVisible();
  await composer.getByRole('textbox').fill('내가 입력하는 요청');
  await expect(suggestion).toHaveCount(0);
  await composer.getByRole('textbox').fill('');
  const { get, activity } = designChecks(page);
  const before = await activity();
  const versions = await get('workflows');
  expect(requests).toBe(0);
  await composer.screenshot({ path: join(root, 'Q37-suggestion.png') });
  for (const action of ['취소', '변경안 적용']) {
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/workflow-proposals'),
      { timeout: 130000 },
    );
    await suggestion.click();
    const reply = await response;
    expect(reply.ok()).toBe(true);
    const { definition } = await reply.json();
    expect(definition.steps.map((s: { kind: string }) => s.kind)).toEqual([
      'task',
      'review',
      'task',
    ]);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('변경안 와이어')).toContainText(
      '사용자 승인',
    );
    if (action === '변경안 적용')
      await dialog.screenshot({ path: join(root, 'Q37-wire.png') });
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await activity()).toEqual(before);
    expect(await get('workflows')).toEqual(versions);
  }
  expect(requests).toBe(2);
  await expect(suggestion).toHaveCount(0);
  await expect(page.getByLabel('편집할 단계').locator('option')).toHaveCount(3);
});

test('Q38 새 자료로 실행하고 예전 결과의 버전을 다시 사용한다', async ({
  page,
}) => {
  test.setTimeout(300000);
  await page.goto('/#/library');
  const headers = {
    origin: 'http://127.0.0.1:5173',
    'x-studio-client': 'browser',
  };
  await page.request.post('/api/session', { headers });
  const base = JSON.parse(await readFile('qa/workflow.json', 'utf8'));
  base.name = '재사용 검증 안내문';
  base.goal = '첫 방문자에게 매장을 소개';
  base.input = '기존예제상호, 예전길 901';
  base.inputFields = ['매장명', '주소', '영업시간'];
  base.steps[0].instructions =
    '이번 원본 자료의 매장명, 주소, 영업시간을 정확히 담은 짧은 목록을 작성하세요.';
  base.steps[2].instructions =
    '승인된 초안의 상호, 주소, 영업시간을 보존해 한 문단으로 작성하세요.';
  const post = await page.request.post('/api/workflows', {
    headers,
    data: base,
  });
  expect(post.status()).toBe(201);
  const v1 = await post.json();
  await page.reload();
  await page.getByRole('searchbox').fill('첫 방문자');
  const panel = page.getByRole('region', { name: '워크플로 보관함' });
  await expect(panel.getByRole('heading', { name: base.name })).toBeVisible();
  const fav = panel.getByRole('button', { name: base.name + ' 즐겨찾기' });
  await fav.click();
  await expect(fav).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: '새 자료로 실행' }).click();
  const dialog = page.getByRole('dialog');
  const records = [];
  for (const [i, shop] of ['달빛서점', '봄날카페'].entries()) {
    if (i === 1)
      await page.getByRole('button', { name: '이 버전으로 다시 사용' }).click();
    await expect(dialog).toContainText('v1');
    await expect(dialog.getByLabel('이번 작업 자료')).toHaveValue('');
    await expect(dialog.getByLabel('매장명', { exact: true })).toHaveValue('');
    const address = i ? '솔길 22' : '달길 11',
      hours = i ? '11:00–20:00' : '09:00–18:00';
    await dialog
      .getByLabel('이번 작업 이름', { exact: false })
      .fill(shop + ' 소개');
    await dialog
      .getByLabel('이번 작업 자료')
      .fill('매장명: ' + shop + '\n주소: ' + address);
    await expect(dialog.getByLabel('주소', { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: '실행 시작' }),
    ).toBeDisabled();
    await dialog.getByLabel('영업시간', { exact: true }).fill(hours);
    const started = page.waitForResponse(
      (r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: '실행 시작' }).click();
    const state = await (await started).json();
    expect(state.summary.workflowVersion).toBe(1);
    const id = state.summary.id;
    await expect(
      page.getByRole('button', { name: '검토할 문서 열기' }),
    ).toBeVisible({ timeout: 135000 });
    await page.getByRole('link', { name: '내 워크플로', exact: true }).click();
    await page.getByRole('searchbox').fill('재사용 검증');
    await panel
      .getByRole('link', { name: '검토 이어가기 · ' + shop + ' 소개' })
      .click();
    await expect(page.locator('[data-markdown-body]')).toContainText(shop);
    await page.getByRole('button', { name: '승인하고 계속' }).click();
    await expect(
      page.getByRole('button', { name: '이 버전으로 다시 사용' }),
    ).toBeVisible({ timeout: 135000 });
    const artifacts = await Promise.all(
      ['draft.md', 'revision.md'].map((f) =>
        readFile(join(root, 'runs', id, f), 'utf8'),
      ),
    );
    for (const doc of artifacts) {
      expect(doc).toContain(shop);
      expect(doc).toContain(address);
      expect(doc).toContain(hours);
      expect(doc).not.toMatch(/기존예제상호|예전길 901/);
      if (i) expect(doc).not.toContain('달빛서점');
    }
    const comp = await (
      await page.request.get('/api/runs/' + id + '/comparison')
    ).json();
    expect(comp.source).toBe(
      '매장명: ' + shop + '\n주소: ' + address + '\n영업시간: ' + hours,
    );
    records.push({ id, version: 1, shop, artifacts });
    if (!i) {
      const res = await page.request.put('/api/workflows/' + v1.id, {
        headers,
        data: {
          baseVersion: 1,
          definition: {
            ...base,
            name: base.name + ' v2',
            inputFields: ['매장명', '주소', '영업시간', '전화번호'],
          },
        },
      });
      expect(res.status()).toBe(200);
    }
  }
  expect(records[0]!.id).not.toBe(records[1]!.id);
  expect(
    await readFile(join(root, 'runs', records[0]!.id, 'revision.md'), 'utf8'),
  ).toBe(records[0]!.artifacts[1]);
  await page.getByRole('link', { name: '내 워크플로', exact: true }).click();
  await page.getByRole('searchbox').fill('재사용 검증');
  await expect(panel.getByLabel('마지막 결과 미리보기')).toContainText(
    '봄날카페',
  );
  await expect(
    panel.getByRole('button', { name: base.name + ' v2 즐겨찾기' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await panel.screenshot({ path: join(root, 'Q38-library.png') });
  await writeFile(
    join(root, 'Q38.json'),
    JSON.stringify({ workflowId: v1.id, records }, null, 2),
  );
});

test('Q40 설계 스킬 탐색·지침 확인 후 실제 Codex 변경안 미리보기', async ({
  page,
}) => {
  const logs = async (name: string) =>
    existsSync(join(root, name))
      ? jsonLines(await readFile(join(root, name), 'utf8'))
      : [];
  await page.goto('/#/design');
  const saving = page.waitForResponse(
    (r) => r.url().endsWith('/workflows') && r.request().method() === 'POST',
  );
  await button(page, '흐름 저장').click();
  const original = await (await saving).json();
  const observed: string[] = [];
  page.on('request', (r) => {
    if (['POST', 'PUT'].includes(r.method()) && !r.url().endsWith('/session'))
      observed.push(new URL(r.url()).pathname);
  });
  const composer = page.getByRole('form', { name: '말로 흐름 수정' });
  const field = composer.getByRole('textbox', { name: '변경 요청' });
  const request = '주소와 영업시간만 확인해줘';
  const designStart = (await logs('design-cli.jsonl')).length;
  const businessStart = (await logs('cli.jsonl')).length;
  const runsBefore = await (await page.request.get('/api/runs')).json();
  await expect(composer.getByRole('listbox')).toHaveCount(0);
  await field.fill('$');
  await expect(
    composer.getByRole('option', { name: /\$workplot-review / }),
  ).toBeVisible();
  await field.press('Escape');
  await expect(composer.getByRole('listbox')).toHaveCount(0);
  await field.fill('$없는스킬');
  await expect(composer.getByRole('status')).toHaveText(
    '일치하는 스킬이 없습니다.',
  );
  await field.fill('$workplot-goals');
  await composer.getByRole('option', { name: /workplot-goals/ }).click();
  await composer
    .getByRole('button', { name: 'workplot-goals 스킬 해제' })
    .click();
  await field.fill('$workplot-review');
  await expect(composer.getByRole('option')).toHaveCount(1);
  await page.screenshot({ path: join(root, 'Q40-picker.png') });
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await composer.locator('summary').click();
  const instructions = (await composer.locator('details p').textContent())!;
  expect(instructions).toContain('원본 자료와 대조');
  await field.fill(request);
  await page.screenshot({ path: join(root, 'Q40-instructions.png') });
  expect(observed).toEqual([]);
  expect((await logs('design-cli.jsonl')).length).toBe(designStart);
  const waiting = page.waitForResponse(
    (r) => r.url().endsWith('/workflow-proposals'),
    { timeout: 135000 },
  );
  await composer.getByRole('button', { name: '변경안 만들기' }).click();
  const response = await waiting;
  expect(response.status()).toBe(200);
  const payload = response.request().postDataJSON();
  expect(payload.designSkill.digest).toBe(
    createHash('sha256').update(instructions).digest('hex'),
  );
  expect(payload.request).toBe(request);
  const { kind, definition } = await response.json();
  expect(kind).toBe('proposal');
  expect(definition.links).toEqual(original.definition.links);
  const gate = original.definition.steps.find(
    (s: { kind: string }) => s.kind === 'review',
  );
  expect(definition.steps).toContainEqual(gate);
  expect(
    definition.steps.every((s: { codexSkill?: unknown }) => !s.codexSkill),
  ).toBe(true);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('변경안 와이어')).toBeVisible();
  const change = dialog.locator('[class*="changedInstruction"]');
  await expect(change.filter({ hasText: '주소' }).first()).toContainText(
    /영업\s*시간/,
  );
  const changes = await change.allInnerTexts();
  const events = (await logs('design-cli.jsonl')).slice(designStart);
  expect(events.map((e) => e.event)).toEqual(['request', 'spawn', 'response']);
  expect(events[1].pid).toBeGreaterThan(0);
  expect(events[0].selectedDesignSkill).toEqual({
    id: payload.designSkill.id,
    digest: payload.designSkill.digest,
    instructionsSha256: createHash('sha256').update(instructions).digest('hex'),
  });
  const originalRead = async () =>
    (await page.request.get('/api/workflows/' + original.id)).json();
  expect(await originalRead()).toEqual(original);
  await page.screenshot({ path: join(root, 'Q40-proposal.png') });
  await dialog.getByRole('button', { name: '변경안 적용' }).click();
  await expect(button(page, '흐름 저장')).toBeEnabled();
  expect(await originalRead()).toEqual(original);
  expect(await (await page.request.get('/api/runs')).json()).toEqual(
    runsBefore,
  );
  expect((await logs('cli.jsonl')).length).toBe(businessStart);
  expect(observed).toEqual(['/api/workflow-proposals']);
  const stale = await page.request.post('/api/workflow-proposals', {
    headers: { origin: 'http://127.0.0.1:5173' },
    data: {
      ...payload,
      designSkill: { ...payload.designSkill, digest: '0'.repeat(64) },
    },
  });
  expect(stale.status()).toBe(409);
  expect((await logs('design-cli.jsonl')).length).toBe(designStart + 3);
  await writeFile(
    join(root, 'Q40.json'),
    JSON.stringify(
      {
        skill: payload.designSkill,
        request,
        designPid: events[1].pid,
        changes,
        additionalRuns: 0,
        additionalSaves: 0,
        staleStatus: stale.status(),
      },
      null,
      2,
    ),
  );
});

test('Q41 실행 스킬 적용 범위를 확인하고 저장 후 지정한 노드에서만 실제 Codex에 전달한다', async ({
  page,
}) => {
  const get = async (path: string) =>
    (await page.request.get('/api/' + path)).json();
  await page.goto('/#/design');
  const save = page.waitForResponse(
    (r) => r.url().endsWith('/workflows') && r.request().method() === 'POST',
  );
  await button(page, '흐름 저장').click();
  const initial = await (await save).json();
  const readSaved = () => get('workflows/' + initial.id);
  const originalRuns = await get('runs');
  const skillName = 'workplot-review';
  const field = page.getByLabel('변경 요청');
  await field.fill('$workplot-review 써줘');
  await button(page, '변경안 만들기').click();
  const dialog = page.getByRole('dialog');
  const answer = dialog.getByLabel('내 답변');
  await expect(answer).toBeVisible({ timeout: 120000 });
  expect(await readSaved()).toEqual(initial);
  expect(await get('runs')).toEqual(originalRuns);
  await answer.fill(
    '수정본 작성 노드에만 연결해서 매번 실행할 때 써줘. 기존 작업 지침은 그대로 유지해.',
  );
  await button(page, '답변 보내기').click();
  await expect(dialog.getByLabel('변경안 와이어')).toContainText(
    '$' + skillName,
    { timeout: 120000 },
  );
  await dialog.screenshot({ path: join(root, 'Q41-proposal.png') });
  await button(page, '변경안 적용').click();
  expect(await readSaved()).toEqual(initial);
  const saving = page.waitForResponse(
    (r) =>
      r.url().endsWith('/workflows/' + initial.id) &&
      r.request().method() === 'PUT',
  );
  await button(page, '흐름 저장').click();
  const version = await (await saving).json();
  const expected = structuredClone(initial.definition);
  const ref = version.definition.steps.find(
    (s: { id: string }) => s.id === 'revision',
  ).codexSkill;
  expect(ref.title).toBe(skillName);
  expect(ref.digest).toBe(
    sha(
      await readFile(
        join(process.cwd(), '.agents/skills', skillName, 'SKILL.md'),
      ),
    ),
  );
  expected.steps.find((s: { id: string }) => s.id === 'revision').codexSkill =
    ref;
  expect(version.definition).toEqual(expected);
  await page.reload();
  await button(page, '흐름 목록').click();
  await page.getByLabel('저장한 흐름').selectOption(initial.id);
  await button(page, '흐름 열기').click();
  await expect(
    page.locator('.react-flow__node[data-id="revision"]'),
  ).toContainText('$' + skillName);
  const starting = page.waitForResponse(
    (r) => r.url().endsWith('/runs') && r.request().method() === 'POST',
  );
  await button(page, '저장한 버전 실행').click();
  const { summary } = await (await starting).json();
  const writes = async () =>
    jsonLines(await readFile(join(root, 'cli.jsonl'), 'utf8')).filter(
      (e) => e.run === summary.id && e.event === 'write',
    );
  await expect(button(page, '검토할 문서 열기')).toBeVisible({
    timeout: 120000,
  });
  expect((await writes()).map((e) => [e.step, e.skillDigest])).toEqual([
    ['draft', undefined],
  ]);
  await button(page, '검토할 문서 열기').click();
  await button(page, '승인하고 계속').click();
  await expect
    .poll(
      async () => (await get('runs/' + summary.id + '/view')).summary.status,
      {
        timeout: 120000,
      },
    )
    .toBe('completed');
  const calls = await writes();
  expect(calls.map((e) => [e.step, e.taskSkill, e.skillDigest])).toEqual([
    ['draft', undefined, undefined],
    ['revision', skillName, ref.digest],
  ]);
  const { results } = await get('runs/' + summary.id + '/view');
  expect(results).toEqual(['draft.md', 'revision.md']);
  await writeFile(
    join(root, 'Q41.json'),
    JSON.stringify(
      {
        workflowId: initial.id,
        version: version.version,
        run: summary.id,
        skill: ref,
        writes: calls,
        results,
      },
      null,
      2,
    ),
  );
});

test('Q42 보관함에서 개인 스킬 등록 후 명시적 업데이트로만 고정 버전을 바꾼다', async ({
  page,
}) => {
  await page.goto('/#/design');
  await page.getByLabel('변경 요청').waitFor();
  const headers = { origin: 'http://127.0.0.1:5173' };
  await page.request.post('/api/session', {
    headers: { ...headers, 'X-Studio-Client': 'browser' },
  });
  const definition = JSON.parse(
    await readFile(new URL('./workflow.json', import.meta.url), 'utf8'),
  );
  definition.name = '보관함 스킬 검증';
  const made = await page.request.post('/api/workflows', {
    headers,
    data: definition,
  });
  expect(made.status()).toBe(201);
  const flow = await made.json();
  const before = await (await page.request.get('/api/runs')).json();
  await page.getByRole('link', { name: '내 워크플로', exact: true }).click();
  await page.getByRole('searchbox').fill(definition.name);
  await button(page, 'Codex 스킬로 등록').click();
  const alias = 'workplot-qa-' + flow.id.slice(0, 8);
  await page.getByLabel('Codex 스킬 이름').fill(alias);
  await button(page, '등록').click();
  const panel = page.getByRole('region', { name: '개인 Codex 스킬' });
  await expect(panel).toContainText('등록된 v1');
  const file = join(root, 'skills', alias, 'SKILL.md');
  const original = await readFile(file, 'utf8');
  expect(original).toContain(flow.id + ' 1 5173');
  const changed = await page.request.put('/api/workflows/' + flow.id, {
    headers,
    data: {
      baseVersion: 1,
      definition: { ...definition, goal: '두 번째 버전' },
    },
  });
  expect(changed.ok()).toBe(true);
  await page.reload();
  await page.getByRole('searchbox').fill(definition.name);
  await expect(panel).toContainText('등록된 v1');
  expect(await readFile(file, 'utf8')).toBe(original);
  await button(page, '등록한 스킬 관리').click();
  await button(page, 'v2로 업데이트').click();
  await expect(panel).toContainText('등록된 v2');
  expect(await readFile(file, 'utf8')).toContain(flow.id + ' 2 5173');
  expect(await (await page.request.get('/api/runs')).json()).toEqual(before);
  await panel.screenshot({ path: join(root, 'Q42-registration.png') });
});

test('Q43 예약 시각에 최신 파일로 한 번 실행하고 사용자 승인 후 수정본을 만든다', async ({
  page,
}) => {
  test.setTimeout(200000);
  await page.goto('/#/design');
  await page.getByLabel('변경 요청').waitFor();
  const headers = { origin: 'http://127.0.0.1:5173' };
  await page.request.post('/api/session', {
    headers: { ...headers, 'X-Studio-Client': 'browser' },
  });
  const definition = JSON.parse(
    await readFile(new URL('./workflow.json', import.meta.url), 'utf8'),
  );
  definition.name = '예약 검증 문서';
  const made = await page.request.post('/api/workflows', {
    headers,
    data: definition,
  });
  const { id } = await made.json();
  const state = async () =>
    (await page.request.get('/api/workflows/' + id + '/schedule')).json();
  const runList = async () =>
    (
      (await (await page.request.get('/api/runs')).json()) as {
        workflowId: string;
        id: string;
      }[]
    ).filter((r) => r.workflowId === id);
  const { folder } = await state();
  const file = join(folder, 'weekly.md');
  const previous =
    '매장명: 이전카페\n주소: 봄길 8\n영업시간: 09:00–18:00\n취급 품목: 커피';
  const source = previous.replace('이전카페', '예약연습카페');
  await writeFile(file, previous);
  await page.getByRole('link', { name: '내 워크플로', exact: true }).click();
  await page.getByRole('searchbox').fill(definition.name);
  const panel = page.getByRole('region', { name: '예약 실행' });
  await panel.getByRole('button', { name: '예약 추가' }).click();
  await panel.getByLabel('반복').selectOption('daily');
  const target = Math.ceil((Date.now() + 15000) / 60000) * 60000;
  const time = new Date(target + 9 * 3600000).toISOString().slice(11, 16);
  await panel.getByLabel('시각 (서울)').fill(time);
  await panel.getByLabel('자료 방식').selectOption('file');
  await panel.getByLabel('자료 파일명').fill('weekly.md');
  await panel.getByRole('button', { name: '예약 저장' }).click();
  await expect(panel).toContainText('사용 중');
  expect((await state()).schedule.nextAt).toBe(target);
  expect(await runList()).toEqual([]);
  await writeFile(file, source);
  await expect
    .poll(async () => (await runList()).length, { timeout: 90000 })
    .toBe(1);
  const rid = (await runList())[0]!.id;
  const view = async () =>
    (await page.request.get('/api/runs/' + rid + '/view')).json();
  await expect
    .poll(async () => (await view()).summary.status, { timeout: 60000 })
    .toBe('waiting');
  const before = await view();
  expect(before.results).toEqual(['draft.md']);
  const dir = join(root, 'runs', rid);
  const draft = await readFile(join(dir, 'draft.md'), 'utf8');
  expect(draft).toContain('예약연습카페');
  // Advance only this isolated QA schedule to emulate its next occurrence during review.
  const db = new Database(join(root, 'studio.sqlite'));
  try {
    db.prepare('UPDATE workflow_schedules SET nextAt=? WHERE id=?').run(
      Date.now(),
      id,
    );
  } finally {
    db.close();
  }
  await expect
    .poll(async () => (await state()).schedule.note, { timeout: 10000 })
    .toContain('건너뜀');
  expect(await runList()).toHaveLength(1);
  await panel.getByRole('button', { name: '일시정지' }).click();
  await expect(panel.getByRole('button', { name: '재개' })).toBeVisible();
  await page.goto('/#/runs/' + rid + '/review');
  await button(page, '검토할 문서 열기').click();
  await button(page, '승인하고 계속').click();
  await expect
    .poll(async () => (await view()).summary.status, { timeout: 60000 })
    .toBe('completed');
  const after = await view();
  expect(after.results).toEqual(['draft.md', 'revision.md']);
  expect(await readFile(join(dir, 'draft.md'), 'utf8')).toBe(draft);
  await writeFile(
    join(root, 'Q43.json'),
    JSON.stringify(
      {
        id,
        run: rid,
        version: after.summary.workflowVersion,
        scheduledAt: new Date(target).toISOString(),
        before: before.results,
        after: after.results,
        overlapRuns: (await runList()).length,
      },
      null,
      2,
    ),
  );
});

test('Q44 개인 슬롯의 검토 노드를 실제 Codex로 맞추고 취소·적용·저장을 분리한다', async ({
  page,
}) => {
  await page.goto('/#/design');
  const api = async (path: string) =>
    page.evaluate(async (p) => {
      const res = await fetch('/api/' + p);
      if (!res.ok) throw Error('status ' + res.status);
      return res.json();
    }, path);
  const picker = page.getByLabel('편집할 단계');
  await picker.selectOption('revision');
  const runsBefore = await api('runs');
  const priorIds = new Set(
    (await api('workflows')).map((w: { id: string }) => w.id),
  );
  await page
    .getByRole('button', { name: '내 노드로 저장', exact: true })
    .click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('노드 이름').fill('문장 리뷰 QA');
  await modal
    .getByLabel('재사용할 지침')
    .fill(
      '초안에서 불분명한 문장 한 곳을 찾아 이유와 개선안을 검토 의견으로 작성한다.',
    );
  await modal
    .getByLabel('필요한 자료', { exact: false })
    .fill('초안 작성\n시설 점검 보고서');
  await modal.getByLabel('결과 문서').fill('문장 검토 의견');
  await modal.getByRole('button', { name: '슬롯에 저장' }).click();
  await expect(
    modal.getByRole('button', { name: /문장 리뷰 QA v1/ }),
  ).toBeFocused();
  await expect(modal.getByRole('status')).toContainText('슬롯에 저장했습니다');
  await modal.getByRole('button', { name: '문장 리뷰 QA 즐겨찾기' }).click();
  await expect(
    modal.getByRole('button', { name: '문장 리뷰 QA 즐겨찾기' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await modal.getByRole('button', { name: '닫기' }).click();
  await picker.selectOption('draft');
  async function preview() {
    await page.getByRole('button', { name: '내 노드함', exact: true }).click();
    await modal.getByLabel('내 노드 검색').fill('문장 리뷰');
    await modal.getByRole('button', { name: /문장 리뷰 QA v1/ }).click();
    await expect(
      modal.getByRole('heading', { name: '흐름 맞춤 미리보기' }),
    ).toBeVisible({ timeout: 90000 });
    await expect(
      modal.getByRole('heading', { name: '흐름 맞춤 미리보기' }),
    ).toBeFocused();
    await modal
      .getByRole('combobox', { name: '시설 점검 보고서', exact: true })
      .selectOption('@source');
    await expect(modal.getByLabel('적용할 지침')).not.toHaveValue('');
    await expect(
      modal.getByRole('combobox', { name: '초안 작성', exact: true }),
    ).toHaveValue('draft');
  }
  await preview();
  await modal.getByRole('button', { name: '취소' }).click();
  await expect(picker.locator('option')).toHaveCount(3);
  await preview();
  await modal.getByRole('button', { name: '와이어에 적용' }).click();
  await expect(picker.locator('option')).toHaveCount(4);
  expect((await api('workflows')).length).toBe(priorIds.size);
  await page.getByRole('button', { name: '흐름 저장', exact: true }).click();
  await expect(page.getByText('저장된 버전 1', { exact: true })).toBeVisible();
  const list = await api('workflows');
  const row = list.find((x: { id: string }) => !priorIds.has(x.id));
  const v = await api('workflows/' + row.id);
  const nodes = v.definition.steps;
  expect(nodes.map((n: { kind: string }) => n.kind)).toEqual([
    'task',
    'task',
    'review',
    'task',
  ]);
  expect(nodes[1].templateOrigin.version).toBe(1);
  expect(nodes[3].inputFrom).toEqual(['draft', nodes[1].id]);
  await picker.selectOption(nodes[1].id);
  await page
    .getByRole('button', { name: '내 노드로 저장', exact: true })
    .click();
  await expect(modal.getByLabel('필요한 자료', { exact: false })).toHaveValue(
    '초안 작성\n시설 점검 보고서',
  );
  await expect(modal.getByLabel('결과 문서')).toHaveValue('문장 검토 의견');
  await modal
    .getByLabel('재사용할 지침')
    .fill('다음 사용부터 표현의 일관성도 확인한다.');
  await modal.getByRole('button', { name: '기존 슬롯 갱신' }).click();
  await expect(
    modal.getByRole('button', { name: /문장 리뷰 QA v2/ }),
  ).toBeVisible();
  const versionTwo = (await api('node-shelf')).find(
    (s: { id: string }) => s.id === nodes[1].templateOrigin.id,
  );
  expect(versionTwo.template).toMatchObject({
    needs: ['초안 작성', '시설 점검 보고서'],
    output: '문장 검토 의견',
  });
  await modal
    .getByRole('button', { name: '문장 리뷰 QA 노드함에서 삭제' })
    .click();
  await modal.getByRole('button', { name: '삭제 확인' }).click();
  await expect(
    modal.getByRole('button', { name: /문장 리뷰 QA v2/ }),
  ).toHaveCount(0);
  expect((await api('workflows/' + row.id)).definition).toEqual(v.definition);
  expect(await api('runs')).toEqual(runsBefore);
});

test('Q45 미저장 편집을 같은 탭에서 복원하고 저장과 취소 후 임시본을 지운다', async ({
  page,
}) => {
  await page.goto('/#/design');
  const picker = page.getByLabel('편집할 단계');
  const button = (name: string) =>
    page.getByRole('button', { name, exact: true });
  const prompt = page.getByRole('textbox', { name: /작업 지침/ });
  const cache = () =>
    page.evaluate(() => sessionStorage.getItem('workplot.editor-draft.v1'));
  await picker.selectOption('revision');
  await prompt.fill('');
  await page.reload();
  await expect(picker).toHaveValue('revision');
  await expect(prompt).toHaveValue('');
  await expect(page.getByText(/이 탭의 편집 내용 복원됨/)).toBeVisible();
  await button('변경 취소').click();
  expect(await cache()).toBeNull();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/workflows') && r.request().method() === 'POST',
  );
  await button('흐름 저장').click();
  const original = await (await created).json();
  await picker.selectOption('revision');
  await prompt.fill('휴관일의 대체 이용 방법을 적으세요. ');
  await page.reload();
  await expect(picker).toHaveValue('revision');
  await expect(prompt).toHaveValue('휴관일의 대체 이용 방법을 적으세요. ');
  await expect(button('저장한 버전 실행')).toBeDisabled();
  expect(
    (await (await page.request.get('/api/workflows/' + original.id)).json())
      .version,
  ).toBe(1);
  const updated = page.waitForResponse(
    (r) =>
      r.url().endsWith('/workflows/' + original.id) &&
      r.request().method() === 'PUT',
  );
  await button('흐름 저장').click();
  expect((await (await updated).json()).version).toBe(2);
  await expect.poll(cache).toBeNull();
});

test('보관함에서 마지막 완료 버전과 저장 자료를 구분해 실행한다', async ({
  page,
}) => {
  const headers = {
    origin: 'http://127.0.0.1:5173',
    'x-studio-client': 'browser',
  };
  await page.goto('/#/library');
  await page.request.post('/api/session', { headers });
  const flow = {
    name: '보관함 자료 선택 QA',
    inputFields: ['방문지'],
    steps: [
      {
        id: 'plan',
        title: '방문지 확인',
        kind: 'task',
        agent: 'codex',
        position: { x: 0, y: 0 },
        instructions: '자료의 방문지를 정확하게 한 줄로 적으세요.',
      },
    ],
    links: [],
  };
  const created = await page.request.post('/api/workflows', {
    headers,
    data: flow,
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await page.reload();
  const library = page.getByRole('region', { name: '워크플로 보관함' });
  const detail = library.locator('article');
  await page.getByRole('searchbox').fill(flow.name);
  await expect(detail.getByText('실행 전', { exact: true })).toBeVisible();
  await expect(
    detail.getByRole('button', { name: '저장된 자료로 실행' }),
  ).toHaveCount(0);
  await detail.getByRole('button', { name: '새 자료로 실행' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('이번 작업 자료').fill('방문지: 우에노 공원');
  await dialog.getByRole('button', { name: '실행 시작' }).click();
  const result = page.getByRole('button', { name: 'plan.md', exact: true });
  await result.click({ timeout: 120000 });
  await expect(page.locator('[data-markdown-body]')).toContainText(
    '우에노 공원',
  );
  const first = page.url();
  const updated = await page.request.put('/api/workflows/' + id, {
    headers,
    data: {
      baseVersion: 1,
      definition: { ...flow, input: '방문지: 긴자 거리' },
    },
  });
  expect(updated.ok()).toBe(true);
  await page.getByRole('link', { name: '내 워크플로', exact: true }).click();
  await page.getByRole('searchbox').fill(flow.name);
  const status = '저장 v2 · 마지막 완료 v1 · 최신 버전 실행 전';
  await expect(library.getByText(status, { exact: true })).toHaveCount(1);
  await expect(
    detail.getByRole('button', { name: '저장 v2 편집' }),
  ).toBeVisible();
  await expect(
    detail.getByText('마지막 완료 v1 · 최신 버전 실행 전', { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole('link', { name: /v1 결과 열기/ }),
  ).toHaveAttribute('href', new URL(first).hash);
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/api/runs') && r.method() === 'POST',
  );
  await detail.getByRole('button', { name: '저장된 자료로 실행' }).click();
  expect((await request).postDataJSON()).toMatchObject({
    workflowId: id,
    workflowVersion: 2,
  });
  await result.click({ timeout: 120000 });
  await expect(page.locator('[data-markdown-body]')).toContainText('긴자 거리');
  await expect(page.locator('[data-markdown-body]')).not.toContainText(
    '우에노 공원',
  );
  const second = page.url();
  expect(second).not.toBe(first);
  await page.getByRole('link', { name: '내 워크플로', exact: true }).click();
  await page.getByRole('searchbox').fill(flow.name);
  await expect(
    detail.getByText('마지막 완료 v2', { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole('link', { name: /v2 결과 열기/ }),
  ).toHaveAttribute('href', new URL(second).hash);
  const restarted = page.waitForResponse(
    (r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST',
  );
  await detail.getByRole('button', { name: '저장된 자료로 실행' }).click();
  const failedId = (await (await restarted).json()).summary.id;
  let pid = 0;
  await expect
    .poll(
      async () => {
        const events = jsonLines(
          await readFile(join(root, 'cli.jsonl'), 'utf8'),
        );
        pid =
          events.find(
            (e) =>
              e.run === failedId && e.step === 'plan' && e.event === 'spawn',
          )?.pid ?? 0;
        return pid;
      },
      { intervals: [50, 100, 200] },
    )
    .toBeGreaterThan(0);
  process.kill(pid, 'SIGKILL');
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get('/api/runs/' + failedId + '/view')
          ).json()
        ).summary.status,
    )
    .toBe('failed');
  await page.getByRole('link', { name: '내 워크플로', exact: true }).click();
  await page.getByRole('searchbox').fill(flow.name);
  const failureHash = '#/runs/' + failedId + '/log';
  const recorded = jsonLines(
    await readFile(join(root, 'runs', failedId, 'events.jsonl'), 'utf8'),
  ).at(-1);
  expect(recorded).toMatchObject({
    status: 'failed',
    stepId: 'plan',
    failureReason: 'Codex 프로세스가 SIGKILL 신호로 종료됐습니다.',
  });
  for (const area of ['list', 'detail'] as const) {
    for (const input of ['mouse', 'keyboard'] as const) {
      const section =
        area === 'list'
          ? library.getByRole('listitem').filter({ hasText: flow.name }).first()
          : detail.locator('header');
      const failure = section.getByRole('link', {
        name: '최근 실행 실패 로그 열기',
      });
      await expect(failure).toHaveAttribute('href', failureHash);
      await expect(section.locator('small')).toHaveText(
        (area === 'list' ? '저장 v2 · ' : '') +
          '최근 실행 실패 · 마지막 완료 v2',
      );
      await expect(
        detail.getByRole('link', { name: /v2 결과 열기/ }),
      ).toHaveAttribute('href', new URL(second).hash);
      const logRequest = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/runs/' + failedId + '/events' &&
          r.ok(),
      );
      if (input === 'mouse') await failure.click();
      else {
        await failure.focus();
        await page.keyboard.press('Enter');
      }
      const response = await logRequest;
      expect((await response.json()).at(-1).failureReason).toBe(
        recorded.failureReason,
      );
      expect(new URL(page.url()).hash).toBe(failureHash);
      const log = page.getByRole('list', { name: '최근 실행 이벤트' });
      await expect(log).toBeVisible();
      await expect(log.getByRole('listitem').last()).toContainText(
        '실패 사유 ' + recorded.failureReason,
      );
      if (area === 'list' && input === 'mouse')
        await log
          .locator('..')
          .screenshot({ path: join(root, 'failure-reason.png') });
      await expect(
        page.locator('summary').filter({ hasText: '실행 로그' }),
      ).toBeFocused();
      await page.goBack();
      await page.getByRole('searchbox').fill(flow.name);
    }
  }
  await detail.getByRole('link', { name: /v2 결과 열기/ }).click();
  await result.click();
  await expect(page.locator('[data-markdown-body]')).toContainText('긴자 거리');
  await page.goto('/' + failureHash);
  await expect(
    page
      .getByRole('list', { name: '최근 실행 이벤트' })
      .getByRole('listitem')
      .last(),
  ).toContainText(recorded.failureReason);
  // Earlier versions stored only the status on a failed event.
  await page.route('**/api/runs/' + failedId + '/events', async (route) => {
    const result = await route.fetch();
    const events = await result.json();
    delete events.at(-1).failureReason;
    await route.fulfill({ response: result, json: events });
  });
  await page.reload();
  await expect(
    page.getByRole('list', { name: '최근 실행 이벤트' }),
  ).toContainText('저장된 실패 사유가 없습니다.');
});

test('세션 승인으로 인계문이 연결되고 다음 승인에서 루프가 멈춘다', async ({
  page,
}) => {
  const headers = {
    origin: 'http://127.0.0.1:5173',
    'x-studio-client': 'browser',
  };
  await page.goto('/#/library');
  await page.request.post('/api/session', { headers });
  const fixture = JSON.parse(await readFile('qa/workflow.json', 'utf8'));
  const [draft, review] = fixture.steps;
  const response = await page.request.post('/api/workflows', {
    headers,
    data: {
      ...fixture,
      name: '세션 인계 QA',
      steps: [
        {
          ...draft,
          instructions:
            '다음 세션의 개선 과제 한 가지와 완료 기준을 3줄로 적으세요.',
        },
        { ...review, title: '다음 세션 승인', startNextSession: true },
      ],
      links: fixture.links.slice(0, 1),
    },
  });
  expect(response.status()).toBe(201);
  await page.reload();
  await page.getByRole('searchbox').fill('세션 인계 QA');
  await page.getByRole('button', { name: '저장된 자료로 실행' }).click();
  const accept = page.getByRole('button', { name: '승인하고 다음 세션 시작' });
  await expect(accept).toBeEnabled({ timeout: 120000 });
  const first = page.url();
  const parentPath = '/api/runs/' + new URL(first).hash.split('/')[2];
  const pending = await (await page.request.get(parentPath + '/view')).json();
  expect(pending.summary.nextSessionId).toBeUndefined();
  const plan = await (
    await page.request.get(parentPath + '/results/draft.md')
  ).text();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '다음 세션 계획', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-markdown-source]')).toHaveText(plan.trim());
  await expect(accept).toBeEnabled();
  await accept.click();
  await page.getByRole('link', { name: '다음 세션', exact: true }).click();
  expect(page.url()).not.toEqual(first);
  await expect(accept).toBeVisible({ timeout: 120000 });
  await expect(
    page.getByRole('link', { name: '이전 세션', exact: true }),
  ).toHaveAttribute('href', new URL(first).hash);
  await page.getByRole('button', { name: '거절', exact: true }).click();
  await expect(page.getByText(/버전 1 · 중단됨/).first()).toBeVisible();
  await expect(
    page.getByRole('link', { name: '다음 세션', exact: true }),
  ).toHaveCount(0);

  const workflow = await response.json();
  const id = crypto.randomUUID();
  const path = '/api/runs/' + id;
  const created = await page.request.post('/api/runs', {
    headers,
    data: { id, workflowId: workflow.id, workflowVersion: workflow.version },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/#/runs/' + id + '/review');
  const finish = page.getByRole('button', {
    name: '이번 세션 마치기',
    exact: true,
  });
  await expect(finish).toBeEnabled({ timeout: 120000 });
  const before = await (await page.request.get(path + '/view')).json();
  const body = await (
    await page.request.get(path + '/results/draft.md')
  ).text();
  const rows = async () =>
    (await (await page.request.get('/api/runs')).json()) as {
      id: string;
      status: string;
    }[];
  const ids = (await rows()).map((r) => r.id);
  const calls = () => readFile(join(root, 'cli.jsonl'), 'utf8');
  const beforeCalls = await calls();
  await finish.click();
  await expect(page.getByText(/버전 1 · 완료/).first()).toBeVisible();
  const after = await (await page.request.get(path + '/view')).json();
  expect(after.summary.status).toBe('completed');
  expect(after.summary.nextSessionId).toBeUndefined();
  expect(after.results).toEqual(before.results);
  expect(
    await (await page.request.get(path + '/results/draft.md')).text(),
  ).toBe(body);
  expect(
    (
      await page.request.post(path + '/decision', {
        headers,
        data: { gateId: before.gate.id, decision: 'accept' },
      })
    ).status(),
  ).toBe(409);
  const finalRows = await rows();
  expect(finalRows.map((r) => r.id)).toEqual(ids);
  expect(finalRows.find((r) => r.id === id)?.status).toBe('completed');
  expect((await calls()).trim()).toBe(beforeCalls.trim());
  expect(
    (await (await page.request.get(path + '/events')).json()).at(-1).status,
  ).toBe('completed');
  await page.reload();
  await expect(page.getByText(/버전 1 · 완료/).first()).toBeVisible();
  await expect(
    page.getByRole('link', { name: '다음 세션', exact: true }),
  ).toHaveCount(0);
});
