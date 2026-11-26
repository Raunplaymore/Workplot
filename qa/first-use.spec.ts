import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { type WorkflowVersion, comparisonSchema } from '@studio/contracts';

test('Q36 실제 Codex workplot 설계 와이어와 업무 미실행', async ({ page }) => {
  const root = process.env.STUDIO_QA_DIR!;
  const dir = join(root, 'first-use');
  const db = new Database(join(dir, 'studio.sqlite'), { readonly: true });
  const lines = async (file: string) =>
    existsSync(join(dir, file))
      ? (await readFile(join(dir, file), 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
      : [];
  const activity = async () => ({
    versions: db
      .prepare('SELECT count(*) FROM workflow_versions')
      .pluck()
      .get(),
    runs: db.prepare('SELECT count(*) FROM runs').pluck().get(),
    workCalls: (await lines('cli.jsonl')).length,
    files: existsSync(join(dir, 'runs'))
      ? await readdir(join(dir, 'runs'), { recursive: true })
      : [],
  });
  const goal = '매장 소개문을 만들어줘';
  try {
    const before = await activity();
    expect(before).toEqual({ versions: 0, runs: 0, workCalls: 0, files: [] });
    const start = (await lines('design-cli.jsonl')).length;
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Start with a goal', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('업무 목표', { exact: true }).fill(goal);
    const pending = page.waitForResponse(
      (r) =>
        r.url().endsWith('/workflow-proposals') &&
        r.request().method() === 'POST',
      { timeout: 130000 },
    );
    await dialog.getByRole('button', { name: 'Find workflow' }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const { definition } = await response.json();
    const wire = dialog.getByLabel('변경안 와이어');
    for (const step of definition.steps)
      await expect(wire).toContainText(step.title);
    expect(definition.steps.map((step: { kind: string }) => step.kind)).toEqual(
      ['task', 'review', 'task'],
    );
    const [draft, gate, revision] = definition.steps;
    expect(definition.links).toEqual([
      { from: draft.id, to: gate.id },
      { from: gate.id, to: revision.id },
    ]);
    expect(revision.inputFrom).toEqual([draft.id]);
    const records = (await lines('design-cli.jsonl'))
      .slice(start)
      .map((line) => JSON.parse(line));
    expect(records.map((row) => row.event)).toEqual([
      'request',
      'spawn',
      'response',
    ]);
    const skillSha256 = createHash('sha256')
      .update(await readFile('.agents/skills/workplot/SKILL.md'))
      .digest('hex');
    expect(records[0]).toMatchObject({ request: goal, skillSha256 });
    expect(records[1].pid).toBeGreaterThan(0);
    const preview = await activity();
    expect(preview).toEqual(before);
    await dialog.screenshot({ path: join(root, 'Q36-wire.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const cancelled = await activity();
    expect(cancelled).toEqual(before);
    await writeFile(
      join(root, 'Q36.json'),
      JSON.stringify(
        {
          goal,
          definition,
          skillSha256,
          designPid: records[1].pid,
          before,
          preview,
          cancelled,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
});

test('Q35 첫 방문에서 목표 한 줄로 설계·실행·승인·비교·선택 반영', async ({
  page,
  context,
}) => {
  const root = process.env.STUDIO_QA_DIR!,
    dir = join(root, 'first-use');
  const db = new Database(join(dir, 'studio.sqlite'), { readonly: true });
  const counts = () => ({
    workflows: db
      .prepare('SELECT count(*) FROM workflow_versions')
      .pluck()
      .get(),
    runs: db.prepare('SELECT count(*) FROM runs').pluck().get(),
  });
  const goal = '매장 소개문을 만들어줘';
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const events: { action: string; atMs: number }[] = [];
  const waits: { stage: string; ms: number }[] = [];
  const mark = (action: string) => events.push({ action, atMs: elapsed() });
  const btn = (name: string) => page.getByRole('button', { name, exact: true });
  const click = async (name: string) => {
    await btn(name).click();
    mark(name);
  };
  const settled = (stage: string, begin: number) => {
    waits.push({ stage, ms: elapsed() - begin });
    mark(stage);
  };
  const reply = (suffix: string) =>
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(suffix),
      { timeout: 130000 },
    );
  let id: string | undefined;
  let passed = false;
  try {
    expect(counts()).toEqual({ workflows: 0, runs: 0 });
    expect(await context.cookies()).toEqual([]);
    await page.goto('/');
    await expect(btn('목표로 시작')).toBeEnabled();
    mark('첫 화면 준비');
    await click('목표로 시작');
    const modal = page.getByRole('dialog');
    await modal.getByLabel('업무 목표', { exact: true }).fill(goal);
    mark('목표 입력');
    const plan = reply('/workflow-proposals');
    await click('흐름 찾기');
    let begin = elapsed();
    const proposal = await plan;
    expect(proposal.request().postDataJSON()).toEqual({
      mode: 'create',
      reviewBeforeRevision: true,
      request: goal,
    });
    expect(proposal.status()).toBe(200);
    await expect(modal.getByLabel('변경안 와이어')).toContainText(
      '사용자 승인',
    );
    settled('설계안 표시', begin);
    expect(counts()).toEqual({ workflows: 0, runs: 0 });
    const save = modal.getByRole('button', { name: 'Save workflow' });
    await expect(save).toBeDisabled();
    await click('가상 매장 자료로 연습');
    const source = await modal
      .getByRole('textbox', { name: '원본 자료', exact: true })
      .inputValue();
    expect(source).toContain('가상 매장');
    const saved = reply('/workflows');
    await save.click();
    mark('흐름 저장');
    const record = (await (await saved).json()) as WorkflowVersion;
    expect(record.definition.input).toBe(source);
    expect(record.definition.steps.map((s) => s.kind)).toEqual([
      'task',
      'review',
      'task',
    ]);
    expect(counts()).toEqual({ workflows: 1, runs: 0 });
    await expect(modal).toHaveCount(0);
    const started = reply('/runs');
    await click('저장한 버전 실행');
    begin = elapsed();
    const run = await (await started).json();
    id = String(run.summary.id);
    const gate = btn('검토할 문서 열기');
    await expect(gate).toBeVisible({ timeout: 140000 });
    settled('초안 작성과 승인 대기', begin);
    const [draft, , revision] = record.definition.steps;
    const file = (stepId: string) => join(dir, 'runs', id!, stepId + '.md');
    const original = await readFile(file(draft!.id), 'utf8');
    await expect(btn('승인하고 계속')).toBeEnabled();
    await expect(readFile(file(revision!.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(page.locator('[data-markdown-source]')).toHaveText(
      original.trim(),
    );
    const accepted = reply('/decision');
    await click('승인하고 계속');
    begin = elapsed();
    expect((await accepted).ok()).toBe(true);
    const compare = page.getByRole('link', { name: '원안과 수정안 비교' });
    await expect(compare).toBeVisible({ timeout: 140000 });
    settled('수정안 완료', begin);
    await compare.click();
    mark('원안과 수정안 비교');
    await expect(page.locator('article')).toHaveCount(2);
    const reviewed = reply('/comparison/review');
    await click('Codex로 근거 대조');
    begin = elapsed();
    const response = await reviewed;
    expect(response.ok()).toBe(true);
    const c = comparisonSchema.parse(await response.json());
    await expect(page.getByRole('table')).toBeVisible();
    settled('근거 비교 표시', begin);
    expect(c.source).toBe(source);
    expect(c.applied).toBeNull();
    expect(c.original.text).toBe(original);
    const changes = c
      .review!.parts.map((part, i) => ({ part, i }))
      .filter(({ part }) => part.before !== part.after);
    expect(changes.length).toBeGreaterThan(0);
    await expect(btn('선택한 변경 반영')).toBeDisabled();
    await page.getByRole('checkbox').first().check();
    mark('변경 하나 선택');
    const chosen = changes[0]!.i;
    const expected = c
      .review!.parts.map((part, i) => (i === chosen ? part.after : part.before))
      .join('');
    await expect(page.getByLabel('선택 결과 미리보기')).toHaveText(
      expected.trim(),
    );
    const applied = reply('/comparison/apply');
    await click('선택한 변경 반영');
    expect((await (await applied).json()).selected).toEqual([chosen]);
    await expect(
      page.getByRole('heading', { name: '저장한 반영본' }),
    ).toBeVisible();
    mark('반영본 저장 완료');
    await page.reload();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: '반영본 다운로드' }).click();
    const dest = join(dir, '선택한-반영본.md');
    await (await download).saveAs(dest);
    expect(await readFile(dest, 'utf8')).toBe(expected);
    expect(await readFile(file(draft!.id), 'utf8')).toBe(original);
    expect(await readFile(file(revision!.id), 'utf8')).toBe(c.revision.text);
    passed = true;
  } finally {
    db.close();
    const totalMs =
      events.find((e) => e.action === '반영본 저장 완료')?.atMs ?? elapsed();
    const waitingMs = waits.reduce((sum, w) => sum + w.ms, 0);
    await writeFile(
      join(root, 'Q35.json'),
      JSON.stringify(
        {
          id,
          caseDir: 'first-use',
          goal,
          method: '스크립트 기반 브라우저 검증 · 실제 Codex CLI',
          humanParticipants: 0,
          passed,
          firstVisit: { emptyDatabase: true, newBrowserContext: true },
          totalMs,
          waitingMs,
          remainingMs: totalMs - waitingMs,
          waitDefinition:
            '각 버튼 클릭 직후부터 결과가 화면에 표시될 때까지. CLI 실행, 서버 응답, 화면 갱신 포함.',
          events,
          waits,
        },
        null,
        2,
      ),
    );
  }
});

test('Q39 실제 Codex가 메타정보로 카페 흐름 하나를 추천하고 선택 후 새 자료를 연다', async ({
  page,
}) => {
  const root = process.env.STUDIO_QA_DIR!;
  const dir = join(root, 'first-use');
  const db = new Database(join(dir, 'studio.sqlite'), { readonly: true });
  const headers = { origin: 'http://127.0.0.1:5173' };
  const goal = '새 카페 소개문을 만들고 싶어';
  const name = '카페 소개문 작성';
  const fixture = JSON.parse(await readFile('qa/workflow.json', 'utf8'));
  const cafe = {
    ...fixture,
    name,
    goal: '새 카페의 매장명, 주소, 영업시간을 바탕으로 방문객용 카페 소개문을 작성하고 승인 뒤 다듬는다.',
    inputFields: ['매장명', '주소', '영업시간'],
    input: '기존 실행 자료 QA-PRIVATE-684',
  };
  const readLines = async (file: string) =>
    existsSync(join(dir, file))
      ? (await readFile(join(dir, file), 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
      : [];
  const activity = async () => ({
    versions: db
      .prepare('select count(*) from workflow_versions')
      .pluck()
      .get(),
    runs: db.prepare('select count(*) from runs').pluck().get(),
    workCalls: (await readLines('cli.jsonl')).length,
    designs: (await readLines('design-cli.jsonl')).length,
    files: existsSync(join(dir, 'runs'))
      ? (await readdir(join(dir, 'runs'), { recursive: true })).sort()
      : [],
  });
  try {
    expect(
      (
        await page.request.post('/api/session', {
          headers: { ...headers, 'X-Studio-Client': 'browser' },
        })
      ).ok(),
    ).toBe(true);
    const seed = async (definition: typeof cafe) => {
      const res = await page.request.post('/api/workflows', {
        headers,
        data: definition,
      });
      expect(res.ok()).toBe(true);
      return (await res.json()) as WorkflowVersion;
    };
    const saved = await seed({ ...cafe, name: '카페 소개문 이전 버전' });
    const update = await page.request.put('/api/workflows/' + saved.id, {
      headers,
      data: { baseVersion: 1, definition: cafe },
    });
    expect(update.ok()).toBe(true);
    await seed({
      ...fixture,
      name: '주간 재고 보고',
      goal: '주간 재고 수량 변동을 집계한다.',
      inputFields: ['재고표'],
    });
    const before = await activity();
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Start with a goal', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('업무 목표', { exact: true }).fill(goal);
    const pending = page.waitForResponse(
      (r) => r.url().endsWith('/workflow-matches'),
      { timeout: 130000 },
    );
    await dialog.getByRole('button', { name: 'Find workflow' }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const { match } = await response.json();
    expect(match).toMatchObject({ id: saved.id, version: 2, name });
    expect(match.reason).toMatch(/카페|소개문/);
    const card = dialog.getByRole('region', { name: '추천 흐름' });
    await expect(card.getByRole('heading')).toHaveCount(1);
    await expect(card.getByRole('heading')).toHaveText(name);
    await expect(card).toContainText(match.reason);
    await expect(page.getByLabel('이번 작업 자료')).toHaveCount(0);
    expect(await activity()).toEqual(before);
    const records = (await readLines('match-cli.jsonl'))
      .slice(-3)
      .map((line) => JSON.parse(line));
    expect(records.map((row) => row.event)).toEqual([
      'request',
      'spawn',
      'response',
    ]);
    expect(records[0].goal).toBe(goal);
    expect(records[1].pid).toBeGreaterThan(0);
    const candidates = records[0].catalog as Record<string, unknown>[];
    expect(candidates.filter((w) => w.id === saved.id)).toHaveLength(1);
    for (const w of candidates)
      expect(Object.keys(w).sort()).toEqual([
        'fields',
        'goal',
        'id',
        'name',
        'steps',
        'version',
      ]);
    expect(JSON.stringify(candidates)).not.toMatch(
      /QA-PRIVATE-684|모퉁이서점, 느티로/,
    );
    await dialog.screenshot({ path: join(root, 'Q39-match.png') });
    // A concurrent edit must not change the version the user actually chose.
    const otherTab = await page.context().newPage();
    await otherTab.goto('/');
    const updated = await otherTab.evaluate(
      async ({ id, definition }) => {
        const res = await fetch('/api/workflows/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseVersion: 2, definition }),
        });
        return res.status;
      },
      {
        id: saved.id,
        definition: { ...cafe, name: '새 버전', inputFields: ['다른 항목'] },
      },
    );
    expect(updated).toBe(200);
    await otherTab.close();
    const beforeSelect = await activity();
    await dialog.getByRole('button', { name: 'Use this workflow' }).click();
    const materials = page.getByRole('dialog', { name: '새 자료로 실행' });
    await expect(materials).toContainText(name + ' · v2');
    await expect(materials.getByLabel('이번 작업 자료')).toHaveValue('');
    await expect(materials.getByLabel('매장명', { exact: true })).toHaveValue(
      '',
    );
    await expect(
      materials.getByRole('button', { name: 'Start run' }),
    ).toBeDisabled();
    await materials.screenshot({ path: join(root, 'Q39-material.png') });
    await materials.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await activity()).toEqual(beforeSelect);
    await writeFile(
      join(root, 'Q39.json'),
      JSON.stringify(
        {
          goal,
          match,
          matchingPid: records[1].pid,
          candidateCount: candidates.length,
          before,
          afterSelection: await activity(),
          fixtureVersionsAddedDuringPreview: 1,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
});
