import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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
    await button(page, '저장한 버전 실행').click();
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
          await expect(tab.locator('pre')).toHaveText(before.toString().trim());
          expect(
            await tab.evaluate(() => sessionStorage.getItem('studio-run')),
          ).toBe(id);
        }
        const decisions = await decide(tabs, id, scenario);
        evidence.decisions = decisions;
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
        await expect(button(tab, '승인하고 계속')).toHaveCount(0);
        await expect(button(tab, 'draft.md')).toHaveCount(before ? 1 : 0);
        await expect(button(tab, 'revision.md')).toHaveCount(completed ? 1 : 0);
        if (before) {
          const name = completed ? 'revision.md' : 'draft.md';
          await button(tab, name).click();
          await expect(tab.locator('pre')).toHaveText(
            (await readFile(join(dir, name), 'utf8')).trim(),
          );
        }
      }
      const events = await log(),
        final = events.at(-1);
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
    await button(page, '말로 흐름 수정').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('변경 요청').fill(request);
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
    expect(find('review')).toEqual(
      original.definition.steps.find((s: { id: string }) => s.id === 'review'),
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

test('Q29 모호한 목표는 문서 종류를 묻고 답변 뒤에만 와이어를 제안', async ({
  page,
}) => {
  test.setTimeout(320_000);
  const request = '매장 일을 도와줘';
  const answer = '매장 소개 초안을 쓰고 승인 뒤 수정해줘';
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
  expect(first.text).toMatch(/어떤|무엇|종류|필요|무슨/);
  expect(first.text).toMatch(/문서|자료|초안|안내문|소개글|작성물/);
  await expect(dialog.getByText(first.text, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('변경안 와이어')).toHaveCount(0);
  await expect(button(page, '새 흐름 적용')).toHaveCount(0);
  await expect(button(page, '답변 보내기')).toBeDisabled();
  await dialog.screenshot({ path: join(root, 'Q29-question.png') });
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
  const wire = dialog.getByLabel('변경안 와이어');
  for (const s of definition.steps) await expect(wire).toContainText(s.title);
  await expect(wire).toContainText('사용자 승인');
  await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
  await dialog.screenshot({ path: join(root, 'Q29-wire.png') });
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
  await unchanged();
  await writeFile(
    join(root, 'Q29.json'),
    JSON.stringify(
      {
        request,
        question: first.text,
        answer,
        definition,
        designPids: [firstTrace[1].pid, secondTrace[1].pid],
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
