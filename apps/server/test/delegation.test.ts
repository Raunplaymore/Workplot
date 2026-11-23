import { test, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { type RunView } from '@studio/contracts';
import { openStudioStore } from '../src/studio-store.js';
import { createDelegation } from '../src/delegation.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
  vi.useRealTimers();
});
function fixture() {
  const db = new Database(':memory:'),
    store = openStudioStore(db);
  const position = { x: 0, y: 0 },
    workflow = store.createWorkflow({
      name: '개선',
      steps: [
        {
          id: 'work',
          title: '구현',
          position,
          kind: 'task',
          tool: 'workplot-ui',
          instructions: '검사',
        },
        {
          id: 'gate',
          title: '인계',
          position,
          kind: 'review',
          startNextSession: true,
        },
      ],
      links: [{ from: 'work', to: 'gate' }],
    });
  const id = randomUUID(),
    summary = store.recordRun(
      {
        workflowId: workflow.id,
        workflowVersion: 1,
        status: 'waiting',
        cliVersion: '1.0.0',
        sessionId: null,
        process: null,
        results: ['work.md'],
      },
      id,
    );
  const v: RunView = {
    summary,
    gate: {
      id: randomUUID(),
      kind: 'review',
      text: '시작?',
      startNextSession: true,
    },
    note: null,
    stepId: 'gate',
    results: ['work.md'],
  };
  const config = {
    goal: '검토',
    criteria: ['본문 일치'],
    target: 100,
    maxSessions: 1,
    until: new Date(Date.now() + 60000).toISOString(),
  };
  const evidence =
    '실제 검사: 빌드 통과\n브라우저 실측: 390px Enter B · 통과 · 본문 일치';
  const runs = {
    view: () => v,
    artifact: async () => evidence,
    hasRetrySlot: vi.fn(() => true),
    retry: vi.fn(),
    preserveQuotaReview: vi.fn(),
    reviewedArtifact: vi.fn(async () => evidence),
    decide: vi.fn(() => v),
  };
  const generate = vi.fn(async (prompt: string): Promise<unknown> =>
    JSON.parse(prompt).task === 'completion_goal'
      ? { goal: config.goal, criteria: config.criteria, target: 100 }
      : {
          checks: [
            {
              criterion: '본문 일치',
              status: 'met',
              proof: 'interaction',
              quote: '390px Enter B',
            },
          ],
        },
  );
  const d = createDelegation(db, store, runs, generate);
  cleanups.push(async () => {
    await d.close();
    db.close();
  });
  return { id, v, runs, d, config, generate, db, store };
}
test('a redirected round inherits the completed branch and refuses outstanding changes', () => {
  const { store, v } = fixture();
  const task = randomUUID(),
    base = 'a'.repeat(40),
    head = 'b'.repeat(40);
  const parent = store.recordRun({
    workflowId: v.summary.workflowId,
    workflowVersion: 1,
    cliVersion: '1.0.0',
    isolatedGit: true,
    developmentTaskId: task,
    status: 'waiting',
    process: null,
    sessionId: null,
    results: [],
  });
  store.planWorktree(task, {
    base,
    path: '/qa',
    directory: '/qa',
    branch: 'workplot/' + task,
  });
  store.finishWorktree(task, head);
  store.saveWorktreeChanges(task, 'pending-edit');
  const finish = vi.fn();
  for (const redirect of [true, false])
    expect(() =>
      store.recordNextSession(parent.id, '인계', finish, redirect),
    ).toThrow('미커밋');
  expect(finish).not.toHaveBeenCalled();
  store.finishWorktree(task, head);
  const child = store.recordNextSession(parent.id, '인계', finish, true);
  expect(child.sessionGit).toEqual({ sourceRun: parent.id, base: head, head });
  expect(child.developmentTaskId).not.toBe(task);
  expect(finish).toHaveBeenCalledTimes(1);
});
test('a third session proposes against the original user material while keeping its own approved brief', async () => {
  const { store, v, d, generate } = fixture();
  const root = store.recordRun({
    workflowId: v.summary.workflowId,
    workflowVersion: 1,
    status: 'waiting',
    cliVersion: '1.0.0',
    material: { name: '첫 목표', source: '전체 사용자 여정을 개선한다' },
    sessionId: null,
    process: null,
    results: [],
  });
  const child = store.recordNextSession(root.id, '첫 인계', () => {});
  store.updateRun(child.id, {
    status: 'waiting',
    sessionId: null,
    process: null,
    results: [],
  });
  const last = store.recordNextSession(child.id, '문서 전환 검사', () => {});
  v.summary = last;
  const suggestion = await d.suggest(last.id, new AbortController().signal);
  expect(suggestion.originalMission).toBe('전체 사용자 여정을 개선한다');
  expect(JSON.parse(generate.mock.calls[0]![0])).toMatchObject({
    originalMission: suggestion.originalMission,
    sessionHandoff: '문서 전환 검사',
  });
});
test('refinement uses the edited objective and does not delegate or advance the run', async () => {
  const { id, d, generate, runs } = fixture();
  const editedGoal = '검토 담당자와 다음 행동을 노드를 열기 전에 구별하게 한다';
  await d.suggest(id, new AbortController().signal, editedGoal);
  expect(JSON.parse(generate.mock.calls[0]![0])).toMatchObject({ editedGoal });
  expect(d.status(id).config).toBeNull();
  expect(runs.decide).not.toHaveBeenCalled();
});
test('goal suggestion leaves the loop off; measured goal finishes once even when polled concurrently', async () => {
  const { id, d, config, runs } = fixture();
  await d.suggest(id, new AbortController().signal);
  await d.tick();
  expect(d.status(id).config).toBeNull();
  expect(runs.decide).not.toHaveBeenCalled();
  d.enable(id, config);
  await Promise.all([d.tick(), d.tick()]);
  expect(d.status(id)).toMatchObject({ enabled: false, score: 100, used: 0 });
  expect(runs.decide).toHaveBeenCalledTimes(1);
});
test.each(['question', 'review'] as const)(
  'delegation never answers a regular %s',
  async (kind) => {
    const { id, v, d, config, runs } = fixture();
    v.gate = { id: randomUUID(), kind, text: '확인' };
    d.enable(id, config);
    await d.tick();
    expect(runs.decide).not.toHaveBeenCalled();
    expect(d.status(id)).toMatchObject({ enabled: true, used: 0 });
    const gateId = randomUUID();
    v.gate = {
      id: gateId,
      kind: 'review',
      text: '다음 회차',
      startNextSession: true,
    };
    await d.tick();
    expect(runs.decide).toHaveBeenCalledWith(id, {
      gateId,
      decision: 'finish',
    });
  },
);
test('changed evidence fails closed before a decision', async () => {
  const { id, d, config, runs } = fixture();
  runs.reviewedArtifact
    .mockResolvedValueOnce('실제 검사: 빌드 통과')
    .mockRejectedValueOnce(Error('changed'));
  d.enable(id, config);
  await d.tick();
  expect(runs.decide).not.toHaveBeenCalled();
  expect(d.status(id).enabled).toBe(false);
});
test('elapsed deadline finishes at the handoff without an additional session', async () => {
  const { id, d, config, runs, v, generate } = fixture();
  d.enable(id, config);
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(config.until) + 1);
  await d.tick();
  expect(runs.decide).toHaveBeenCalledWith(id, {
    decision: 'finish',
    gateId: v.gate!.id,
  });
  expect(generate).not.toHaveBeenCalled();
});
test('unverified claim can advance one session within the cap and cannot advance another', async () => {
  const { id, d, config, runs, v } = fixture();
  runs.reviewedArtifact.mockResolvedValue('실제 검사: 빌드 통과');
  d.enable(id, config);
  await d.tick();
  expect(d.status(id).score).toBe(0);
  const child = randomUUID();
  v.summary.nextSessionId = child;
  await d.tick();
  v.summary.id = child;
  delete v.summary.nextSessionId;
  await d.tick();
  expect(d.status(child)).toMatchObject({ enabled: false, score: 0, used: 1 });
  expect(runs.decide).toHaveBeenCalledTimes(2);
  expect(runs.decide).toHaveBeenLastCalledWith(child, {
    gateId: v.gate!.id,
    decision: 'finish',
  });
});
test('revoking while the assessment is in flight preserves manual control', async () => {
  const { id, d, config, runs, generate } = fixture();
  let markStarted!: () => void;
  let respond!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const reply = new Promise<unknown>((resolve) => {
    respond = resolve;
  });
  generate.mockImplementationOnce(async () => {
    markStarted();
    return reply;
  });
  d.enable(id, config);
  const poll = d.tick();
  await started;
  d.disable(id);
  respond({ checks: [] });
  await poll;
  expect(runs.decide).not.toHaveBeenCalled();
  expect(d.status(id).enabled).toBe(false);
});

test.each(['unchanged', 'patch', 'deadline', 'cap'] as const)(
  'stalled delegation handles %s within the original mandate',
  async (scenario) => {
    const { d, id, v, runs, generate, config } = fixture();
    v.gate!.repeatsSession = randomUUID();
    generate.mockResolvedValue({
      checks: [
        {
          criterion: config.criteria[0],
          status: 'unknown',
          quote: '',
          proof: 'none',
        },
      ],
    });
    d.enable(id, { ...config, maxSessions: scenario === 'cap' ? 1 : 4 });
    await d.tick();
    expect(runs.decide).toHaveBeenCalledWith(
      id,
      { gateId: v.gate!.id, decision: 'accept' },
      expect.stringMatching(/^자율 화면 탐색/),
      true,
    );
    const child = randomUUID();
    v.summary.nextSessionId = child;
    await d.tick();
    v.summary.id = child;
    delete v.summary.nextSessionId;
    if (scenario === 'deadline') {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse(config.until) + 1);
    }
    await Promise.all([d.tick(), d.tick()]);
    if (scenario === 'deadline' || scenario === 'cap') {
      expect(runs.decide).toHaveBeenLastCalledWith(child, {
        gateId: v.gate!.id,
        decision: 'finish',
      });
      expect(d.status(child).enabled).toBe(false);
      return;
    }
    expect(runs.decide).toHaveBeenCalledTimes(2);
    expect(runs.decide).toHaveBeenLastCalledWith(
      child,
      { gateId: v.gate!.id, decision: 'accept' },
      expect.stringMatching(/^자율 화면 탐색/),
      true,
    );
    const lastBrief = (
      runs.decide.mock.lastCall as unknown as [string, unknown, string]
    )[2];
    expect(lastBrief).toContain('우선 살펴볼 화면: 흐름 설계');
    const discovery = randomUUID();
    v.summary.nextSessionId = discovery;
    await d.tick();
    v.summary.previousSessionId = child;
    v.summary.id = discovery;
    delete v.summary.nextSessionId;
    delete v.gate!.repeatsSession;
    const freshFinding = '이전 세션이 발견한 첫 번째 화면 문제';
    const artifact =
      '## 결과\n실제 검사: 빌드 통과\n' +
      (scenario === 'patch' ? '```diff\n-old\n+fixed\n```\n' : '') +
      '\n## 자율 화면 탐색\n\n' +
      freshFinding;
    runs.reviewedArtifact.mockResolvedValue(artifact);
    await Promise.all([d.tick(), d.tick()]);
    expect(d.status(discovery)).toMatchObject({ enabled: true, used: 2 });
    expect(runs.decide).toHaveBeenCalledTimes(3);
    expect(runs.decide).toHaveBeenLastCalledWith(
      discovery,
      { gateId: v.gate!.id, decision: 'accept' },
      expect.stringContaining('이미 시도한 과제 · ' + freshFinding),
      true,
    );
    v.summary.nextSessionId = randomUUID();
    await d.tick();
    v.summary.previousSessionId = discovery;
    v.summary.id = v.summary.nextSessionId;
    delete v.summary.nextSessionId;
    runs.reviewedArtifact.mockResolvedValue(
      artifact.replace(freshFinding, '다른 장면에서 찾은 두 번째 문제'),
    );
    v.gate!.repeatsSession = discovery;
    await d.tick();
    const handoff = vi.mocked(runs.decide).mock.lastCall as unknown as [
      string,
      unknown,
      string,
    ];
    expect(handoff[2]).toContain(freshFinding);
    expect(handoff[2]).toContain('두 번째 문제');
    expect(handoff[2]).toContain('우선 살펴볼 화면: 실행 현황');
    expect(d.status(v.summary.id)).toMatchObject({ enabled: true, used: 3 });
  },
);
test('resuming a system failure preserves the original limits and rejects a revoked delegation', async () => {
  const { d, id, config, generate } = fixture();
  d.enable(id, config);
  generate.mockRejectedValueOnce(Error('judge unavailable'));
  await d.tick();
  expect(d.status(id).enabled).toBe(false);
  const before = d.status(id);
  const after = await d.resume(id);
  expect(after.config).toEqual(before.config);
  expect(after.used).toBe(before.used);
  d.disable(id);
  await expect(d.resume(id)).rejects.toThrow();
});
test.each(['expires', 'revoked'] as const)(
  'a quota checkpoint never dispatches a write after delegation is %s',
  async (reason) => {
    const { d, v, id, runs, config } = fixture();
    d.enable(id, config);
    v.gate = null;
    v.summary.status = 'failed';
    v.failureId = randomUUID();
    v.quotaRetryAt = Date.now() + 5000;
    await d.tick();
    expect(runs.retry).not.toHaveBeenCalled();
    if (reason === 'revoked') d.disable(id);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(config.until) + 1);
    await d.tick();
    expect(runs.retry).not.toHaveBeenCalled();
    expect(d.status(id).enabled).toBe(false);
    expect(runs.decide).not.toHaveBeenCalled();
  },
);

test('delegated timeouts retry the same step once, keeping the session count', async () => {
  const { d, id, config, runs, v } = fixture();
  d.enable(id, config);
  v.gate = null;
  v.summary.status = 'failed';
  v.stepId = 'work';
  v.failureId = randomUUID();
  v.timedOut = true;
  runs.hasRetrySlot.mockReturnValue(false);
  await d.tick();
  expect(runs.hasRetrySlot).toHaveBeenCalledWith(v.summary);
  expect(runs.retry).not.toHaveBeenCalled();
  expect((await d.statusWithEvidence(id)).note).toContain('병렬 슬롯 대기');
  runs.hasRetrySlot.mockReturnValue(true);
  await Promise.all([d.tick(), d.tick()]);
  expect(runs.retry).toHaveBeenCalledTimes(1);
  expect(runs.retry).toHaveBeenCalledWith(
    id,
    v.failureId,
    expect.any(Function),
  );
  v.failureId = randomUUID();
  await d.tick();
  expect(runs.retry).toHaveBeenCalledTimes(1);
  expect(d.status(id)).toMatchObject({ enabled: false, used: 0 });
  await d.resume(id);
  expect(runs.retry).toHaveBeenCalledTimes(2);
  expect(d.status(id)).toMatchObject({ enabled: true, used: 0, config });
});

test('an explicitly queued exploration is attached only to the next approved child', async () => {
  const { id, d, config, runs, generate } = fixture();
  d.enable(id, config);
  d.exploreNext(id);
  d.exploreNext(id);
  generate.mockResolvedValue({
    checks: [
      {
        criterion: config.criteria[0],
        status: 'unknown',
        proof: 'none',
        quote: '',
      },
    ],
  });
  await d.tick();
  expect(runs.decide).toHaveBeenCalledTimes(1);
  expect(runs.decide).toHaveBeenCalledWith(
    id,
    expect.objectContaining({ decision: 'accept' }),
    expect.stringMatching(/^자율 화면 탐색/),
    true,
  );
  expect(() => d.exploreNext(id)).toThrow();
});

test('handoff delegation preserves a manual gate and accepts only the verified final handoff', async () => {
  const { id, v, runs, d, config, generate } = fixture();
  const finalGate = v.gate!;
  v.gate = { id: randomUUID(), kind: 'review', text: '추천 과제 승인' };
  d.enable(id, { ...config, handoffOnly: true });
  await d.tick();
  expect(d.status(id).enabled).toBe(true);
  expect(runs.decide).not.toHaveBeenCalled();
  v.gate = finalGate;
  await Promise.all([d.tick(), d.tick()]);
  expect(runs.reviewedArtifact).toHaveBeenCalledWith(
    id,
    finalGate.id,
    'work.md',
  );
  expect(runs.decide).toHaveBeenCalledTimes(1);
  expect(runs.decide).toHaveBeenCalledWith(id, {
    gateId: finalGate.id,
    decision: 'accept',
  });
  expect(generate).not.toHaveBeenCalled();
});

test('isolated Git reports continue under the existing budget with unverified criteria', async () => {
  const { id, v, d, config, runs, generate } = fixture();
  v.summary.isolatedGit = true;
  d.enable(id, config);
  await d.tick();
  expect(generate).not.toHaveBeenCalled();
  expect(d.status(id)).toMatchObject({
    enabled: true,
    score: 0,
    checks: [{ status: 'unknown' }],
  });
  expect(runs.decide).toHaveBeenCalledWith(
    id,
    { gateId: v.gate!.id, decision: 'accept' },
    expect.any(String),
    true,
  );
});

test('unlimited delegation continues past 100 sessions but ends at its deadline', async () => {
  const { id, v, d, db, config, runs } = fixture();
  d.enable(id, { ...config, handoffOnly: true, maxSessions: null });
  db.prepare('UPDATE session_delegations SET used=101 WHERE root=?').run(id);
  d.exploreNext(id);
  await d.tick();
  expect(runs.decide).toHaveBeenCalledWith(id, {
    gateId: v.gate!.id,
    decision: 'accept',
  });
  db.prepare('UPDATE session_delegations SET accepted=0 WHERE root=?').run(id);
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(config.until) + 1);
  await d.tick();
  expect(runs.decide).toHaveBeenCalledWith(id, {
    gateId: v.gate!.id,
    decision: 'finish',
  });
});
