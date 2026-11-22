import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStudioStore } from '../src/studio-store.js';
import { createRunService } from '../src/run-service.js';
import { createDelegation } from '../src/delegation.js';
import { RunnerError } from '../src/codex-runner.js';
import { repeatsUnchangedChecks } from '../src/repeated-checks.js';
test('only matching failed observations from unchanged workspaces indicate repetition', () => {
  const a =
    '# 구현·검증 기록\n변경 없음. 이유\n실제 검사: 빌드 통과\n브라우저 실측: 390px Enter · 미달 · 선택 누락';
  expect(repeatsUnchangedChecks(a, a.replace('이유', '다른 설명'))).toBe(true);
  for (const b of [
    a.replace('미달', '통과'),
    a.replace('변경 없음.', '변경 파일:'),
    a.replace('선택 누락', '본문 누락'),
  ])
    expect(repeatsUnchangedChecks(a, b)).toBe(false);
});
test('a delegated write and assessment resume at most once from their saved checkpoints', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workplot-quota-')),
    db = new Database(join(directory, 'qa.sqlite')),
    store = openStudioStore(db);
  const position = { x: 0, y: 0 };
  const f = store.createWorkflow({
    name: 'QA',
    steps: [
      {
        id: 'work',
        kind: 'task',
        title: '작업',
        instructions: '작성',
        tool: 'workplot-ui',
        position,
      },
      { id: 'approve', kind: 'review', title: '검토', position },
      {
        id: 'revise',
        kind: 'task',
        title: '수정',
        instructions: '수정',
        position,
      },
      {
        id: 'next',
        kind: 'review',
        title: '다음',
        startNextSession: true,
        position,
      },
    ],
    links: [
      { from: 'work', to: 'approve' },
      { from: 'approve', to: 'revise' },
      { from: 'revise', to: 'next' },
    ],
  });
  const id = randomUUID(),
    gateId = randomUUID(),
    dir = join(directory, 'runs', id),
    doc = '실제 검사: 빌드 통과\n';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'work.md'), doc);
  writeFileSync(join(dir, 'events.jsonl'), '');
  store.recordRun(
    {
      workflowId: f.id,
      workflowVersion: 1,
      cliVersion: '1.0.0',
      status: 'waiting',
      process: null,
      sessionId: null,
      results: ['work.md'],
    },
    id,
  );
  store.saveReview(id, {
    stepId: 'approve',
    gateId,
    documentHashes: [createHash('sha256').update(doc).digest('hex')],
  });
  let clock = Date.now();
  const time = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const quota = () => new RunnerError('quota', undefined, clock + 60_000);
  const writer = vi.fn(async () => ({
    kind: 'document' as const,
    text: '수정 완료',
  }));
  writer.mockImplementationOnce(async () => {
    throw quota();
  });
  const assess = vi.fn(async () => ({
    checks: [
      {
        criterion: '빌드 성공',
        status: 'met',
        proof: 'build',
        quote: '빌드 통과',
      },
    ],
  }));
  assess.mockImplementationOnce(async () => {
    throw quota();
  });
  function open() {
    const r = createRunService(
      store,
      { ready: async () => '1.0.0', write: writer },
      directory,
      () => false,
    );
    return { r, d: createDelegation(db, store, r, assess) };
  }
  let { r, d } = open();
  try {
    await r.restoreReview();
    d.enable(id, {
      goal: '검증',
      criteria: ['빌드 성공'],
      target: 100,
      maxSessions: 1,
      until: new Date(clock + 3600000).toISOString(),
    });
    r.decide(id, { gateId, decision: 'accept' });
    await vi.waitFor(() =>
      expect(r.view(id).quotaRetryAt).toBe(clock + 60_000),
    );
    await d.tick();
    expect(writer).toHaveBeenCalledTimes(1);
    await d.close();
    await r.close();
    ({ r, d } = open());
    clock += 60_000;
    await Promise.all([d.tick(), d.tick()]);
    await vi.waitFor(() =>
      expect(r.view(id).gate?.startNextSession).toBe(true),
    );
    const gate = r.view(id).gate!.id;
    await d.tick();
    expect(d.assessmentWait(id)?.gate).toBe(gate);
    await d.close();
    await r.close();
    ({ r, d } = open());
    await r.restoreReview();
    expect(r.view(id).gate!.id).toBe(gate);
    await d.tick();
    expect(assess).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await Promise.all([d.tick(), d.tick()]);
    await vi.waitFor(() => expect(r.view(id).summary.status).toBe('completed'));
    expect(writer).toHaveBeenCalledTimes(2);
    expect(assess).toHaveBeenCalledTimes(2);
    expect(r.view(id).results).toEqual(['work.md', 'revise.md']);
    expect(readFileSync(join(dir, 'work.md'), 'utf8')).toBe(doc);
    expect(readFileSync(join(dir, 'revise.md'), 'utf8')).toBe('수정 완료\n');
    expect(d.status(id)).toMatchObject({ used: 0, score: 100, enabled: false });
    expect(r.view(id).summary.nextSessionId).toBeUndefined();
  } finally {
    await d.close();
    await r.close();
    time.mockRestore();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
