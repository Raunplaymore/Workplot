import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import * as skills from '../src/design-skills.js';
import * as uiWork from '../src/ui-work.js';
import {
  runViewSchema,
  runEventsSchema,
  type RunView,
  type WorkflowDefinition,
} from '@studio/contracts';
import { buildApp } from '../src/app.js';
import { commandCheck } from '../src/timeout-history.js';
import {
  codexCallContext,
  RunnerError,
  type DocumentRunner,
} from '../src/codex-runner.js';

const definition: WorkflowDefinition = {
  name: '가상 문서',
  input: '원본 자료',
  steps: [
    {
      id: 'draft',
      kind: 'task',
      title: '초안',
      instructions: '원본 지침',
      agent: 'codex',
      skill: 'source-check',
      position: { x: 40, y: 0 },
    },
    { id: 'review', kind: 'review', title: '승인', position: { x: 20, y: 0 } },
    {
      id: 'revision',
      kind: 'task',
      title: '수정',
      instructions: '이전 초안 사용',
      position: { x: 0, y: 0 },
    },
  ],
  links: [
    { from: 'draft', to: 'review' },
    { from: 'review', to: 'revision' },
  ],
};
const browser = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'x-studio-client': 'browser',
};
async function withStudio(
  runner: DocumentRunner,
  work: (options: {
    path: string;
    restart: () => Promise<void>;
    inject: (
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      payload?: object,
    ) => Promise<{
      statusCode: number;
      body: string;
      headers: Record<string, unknown>;
      json(): unknown;
    }>;
  }) => Promise<void>,
) {
  const path = await mkdtemp(join(tmpdir(), 'studio-run-'));
  const openApp = () =>
    buildApp(join(path, 'runs.sqlite'), undefined, undefined, runner);
  let app = await openApp();
  const authenticate = async () => {
    const session = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: browser,
    });
    return String(session.headers['set-cookie']).split(';')[0];
  };
  try {
    let cookie = await authenticate();
    await work({
      restart: async () => {
        await app.close();
        app = await openApp();
        cookie = await authenticate();
      },
      path,
      inject: (method, url, payload) =>
        app.inject({
          method,
          url: '/api' + url,
          headers: { ...browser, cookie },
          payload,
        }),
    });
  } finally {
    await app.close();
    await rm(path, { recursive: true, force: true });
  }
}
type Inject = Parameters<Parameters<typeof withStudio>[1]>[0]['inject'];
async function setup(inject: Inject) {
  const response = await inject('POST', '/workflows', definition);
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; version: number };
}
async function until(
  inject: Inject,
  id: string,
  status: RunView['summary']['status'],
) {
  for (let iteration = 0; iteration < 100; iteration++) {
    const result = runViewSchema.parse(
      (await inject('GET', '/runs/' + id + '/view')).json(),
    );
    if (result.summary.status === status) return result;
    await delay(10);
  }
  throw new Error('Run did not reach ' + status);
}

test('saving a writing rule preserves completed results and applies to new material', async () => {
  const rule = '첫 줄에 검토용 표식을 씁니다.';
  const marker = '# 검토용 표식';
  const received: unknown[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        const input = JSON.parse(prompt);
        received.push(input);
        return {
          kind: 'document',
          text: input.instructions === rule ? marker : '# 기존 문서',
        };
      },
    },
    async ({ inject }) => {
      const workflow = await setup(inject);
      const id = '00000000-0000-4000-8000-000000000001';
      const nextId = '00000000-0000-4000-8000-000000000002';
      const route = '/workflows/' + workflow.id;
      const complete = async (
        runId: string,
        workflowVersion: number,
        material: { name: string; source: string },
      ) => {
        expect(
          (
            await inject('POST', '/runs', {
              id: runId,
              workflowId: workflow.id,
              workflowVersion,
              material,
            })
          ).statusCode,
        ).toBe(200);
        const waiting = await until(inject, runId, 'waiting');
        expect(
          (
            await inject('POST', '/runs/' + runId + '/decision', {
              gateId: waiting.gate?.id,
              decision: 'accept',
            })
          ).statusCode,
        ).toBe(200);
        return until(inject, runId, 'completed');
      };
      await complete(id, 1, { name: 'first.md', source: '첫 번째 자료' });
      const oldDraft = '/runs/' + id + '/results/draft.md';
      const before = await inject('GET', oldDraft);
      expect(before.statusCode).toBe(200);
      const sha = (body: string) =>
        createHash('sha256').update(body).digest('hex');
      const runs = (await inject('GET', '/runs')).json();
      expect(runs).toEqual([
        expect.objectContaining({ id, workflowVersion: 1 }),
      ]);
      const update = {
        baseVersion: 1,
        definition: {
          ...definition,
          steps: definition.steps.map((item) =>
            item.id === 'draft' ? { ...item, instructions: rule } : item,
          ),
        },
      };
      const saved = await inject('PUT', route, update);
      expect(saved.statusCode).toBe(200);
      expect((await inject('PUT', route, update)).statusCode).toBe(409);
      expect((await inject('GET', '/runs')).json()).toEqual(runs);
      expect(received).toHaveLength(2);
      expect((await inject('GET', route)).json()).toMatchObject({
        version: 2,
        definition: update.definition,
      });
      expect((await inject('GET', route + '/versions/1')).json()).toMatchObject(
        {
          version: 1,
          definition,
        },
      );
      const after = await inject('GET', oldDraft);
      expect(after.statusCode).toBe(200);
      expect(sha(after.body)).toBe(sha(before.body));
      const next = await complete(nextId, 2, {
        name: 'second.md',
        source: '두 번째 자료',
      });
      expect(next.summary).toMatchObject({ id: nextId, workflowVersion: 2 });
      expect(received[2]).toMatchObject({
        currentStepId: 'draft',
        source: '두 번째 자료',
        instructions: rule,
      });
      const output = await inject(
        'GET',
        '/runs/' + nextId + '/results/draft.md',
      );
      expect(output.statusCode).toBe(200);
      expect(output.body.trim()).toBe(marker);
    },
  );
});

test('pins the original workflow, waits for review, and handles duplicate start and approval exactly once', async () => {
  const prompts: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        prompts.push(prompt);
        return {
          kind: 'document',
          text: prompts.length === 1 ? '# 초안' : '# 수정',
        };
      },
    },
    async ({ inject }) => {
      const workflow = await setup(inject);
      const id = randomUUID();
      const start = {
        id,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
      };
      const starts = await Promise.all([
        inject('POST', '/runs', start),
        inject('POST', '/runs', start),
      ]);
      expect(starts.map((response) => response.statusCode)).toEqual([200, 200]);
      const waiting = await until(inject, id, 'waiting');
      expect(waiting.results).toEqual(['draft.md']);
      expect(
        (
          await inject('POST', '/runs/' + id + '/decision', {
            gateId: waiting.gate!.id,
            decision: 'finish',
          })
        ).statusCode,
      ).toBe(409);
      expect((await inject('GET', '/runs')).json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id, gateKind: 'review' }),
        ]),
      );
      expect(prompts).toHaveLength(1);
      expect(JSON.parse(prompts[0]!)).toMatchObject({
        instructions: '원본 지침',
        source: '원본 자료',
        skill: expect.stringContaining('자료의 사실'),
      });
      expect(
        (
          await inject('POST', '/runs/' + id + '/decision', {
            gateId: randomUUID(),
            decision: 'accept',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await inject('PUT', '/workflows/' + workflow.id, {
            baseVersion: 1,
            definition: { ...definition, input: '변경된 입력' },
          })
        ).statusCode,
      ).toBe(200);
      const action = { gateId: waiting.gate?.id, decision: 'accept' };
      await Promise.all([
        inject('POST', '/runs/' + id + '/decision', action),
        inject('POST', '/runs/' + id + '/decision', action),
      ]).then((responses) =>
        expect(responses.map((r) => r.statusCode)).toEqual([200, 200]),
      );
      const completed = await until(inject, id, 'completed');
      expect(completed.summary.workflowVersion).toBe(1);
      expect(completed.results).toEqual(['draft.md', 'revision.md']);
      const timeline = await inject('GET', '/runs/' + id + '/events');
      expect(timeline.statusCode).toBe(200);
      const events = runEventsSchema.parse(timeline.json());
      expect(events).toContainEqual(
        expect.objectContaining({
          status: 'waiting',
          stepId: 'review',
          gate: 'review',
        }),
      );
      expect(events.at(-1)?.status).toBe('completed');
      expect(timeline.json()).toEqual(events);
      expect(prompts).toHaveLength(2);
      expect(JSON.parse(prompts[1]!)).toMatchObject({
        approval: {
          reviewStepId: 'review',
          decision: 'accept',
          document: 'draft.md',
        },
        instructions: '이전 초안 사용',
        source: '원본 자료',
        priorDocument: '# 초안\n',
      });
      const output = await inject(
        'GET',
        '/runs/' + id + '/results/revision.md',
      );
      expect(output.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(output.body).toBe('# 수정\n');
    },
  );
});

test.each(['decline', 'tamper', 'symlink'] as const)(
  'blocks later execution after %s',
  async (scenario) => {
    let calls = 0;
    await withStudio(
      {
        ready: async () => '0.166.0',
        async write() {
          calls++;
          return { kind: 'document', text: '초안' };
        },
      },
      async ({ inject, path }) => {
        const workflow = await setup(inject);
        const id = randomUUID();
        await inject('POST', '/runs', {
          id,
          workflowId: workflow.id,
          workflowVersion: 1,
        });
        const waiting = await until(inject, id, 'waiting');
        const draft = join(path, 'runs', id, 'draft.md');
        if (scenario === 'tamper') await writeFile(draft, '변조된 입력');
        if (scenario === 'symlink') {
          const outside = join(path, 'outside.md');
          await writeFile(outside, '비공개 자료');
          await unlink(draft);
          await symlink(outside, draft);
          expect(
            (await inject('GET', '/runs/' + id + '/results/draft.md'))
              .statusCode,
          ).toBe(404);
        }
        await inject('POST', '/runs/' + id + '/decision', {
          gateId: waiting.gate?.id,
          decision: scenario === 'decline' ? 'decline' : 'accept',
        });
        await until(inject, id, scenario === 'decline' ? 'stopped' : 'failed');
        expect(calls).toBe(1);
      },
    );
  },
);

test('holds a question, passes the human answer, and stops an active adapter without a next step', async () => {
  const prompts: string[] = [];
  let stopped = false;
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt, signal) {
        prompts.push(prompt);
        if (prompts.length === 1)
          return { kind: 'question', text: '주소는 무엇인가요?' };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              stopped = true;
              reject(new RunnerError('cli'));
            },
            { once: true },
          );
        });
        throw Error('unreachable');
      },
    },
    async ({ inject }) => {
      const workflow = await setup(inject);
      const id = randomUUID();
      await inject('POST', '/runs', {
        id,
        workflowId: workflow.id,
        workflowVersion: 1,
      });
      const waiting = await until(inject, id, 'waiting');
      expect(waiting.gate?.kind).toBe('question');
      expect((await inject('GET', '/runs')).json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id, gateKind: 'question' }),
        ]),
      );
      expect(prompts).toHaveLength(1);
      await inject('POST', '/runs/' + id + '/decision', {
        gateId: waiting.gate?.id,
        decision: 'answer',
        answer: '샘플로 10',
      });
      await until(inject, id, 'running');
      expect(JSON.parse(prompts[1]!).answer).toContain('샘플로 10');
      const result = runViewSchema.parse(
        (await inject('POST', '/runs/' + id + '/stop')).json(),
      );
      expect(result.summary.status).toBe('stopped');
      expect(stopped).toBe(true);
      expect(result.results).toEqual([]);
      expect(prompts).toHaveLength(2);
    },
  );
});

test('rejects invalid input links and guards every selected document at execution', async () => {
  const tasks: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        const task = JSON.parse(prompt).currentStepId as string;
        tasks.push(task);
        return { kind: 'document', text: '원래 결과 ' + task };
      },
    },
    async ({ inject, path }) => {
      const critique = {
        id: 'critique',
        kind: 'task' as const,
        title: 'AI 검토',
        instructions: '초안의 근거를 확인',
        position: { x: 50, y: 0 },
      };
      const flow: WorkflowDefinition = {
        ...definition,
        steps: [
          ...definition.steps.filter((step) => step.id !== 'revision'),
          critique,
          {
            ...critique,
            id: 'revision',
            title: '수정본',
            inputFrom: ['draft', 'critique'],
          },
        ],
        links: [
          { from: 'draft', to: 'critique' },
          { from: 'critique', to: 'review' },
          { from: 'review', to: 'revision' },
        ],
      };
      for (const inputFrom of [
        ['missing'],
        ['review'],
        ['revision'],
        ['draft', 'draft'],
      ]) {
        const bad = {
          ...flow,
          steps: flow.steps.map((step) =>
            step.kind === 'task' && step.id === 'revision'
              ? { ...step, inputFrom }
              : step,
          ),
        };
        expect((await inject('POST', '/workflows', bad)).statusCode).toBe(400);
      }
      const response = await inject('POST', '/workflows', flow);
      expect(response.statusCode).toBe(201);
      const workflow = response.json() as { id: string; version: number };
      const id = randomUUID();
      await inject('POST', '/runs', {
        id,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
      });
      const waiting = await until(inject, id, 'waiting');
      expect(waiting.results).toEqual(['draft.md', 'critique.md']);
      await writeFile(join(path, 'runs', id, 'draft.md'), '이전 초안이 바뀜');
      await inject('POST', '/runs/' + id + '/decision', {
        gateId: waiting.gate?.id,
        decision: 'accept',
      });
      await until(inject, id, 'failed');
      expect(tasks).toEqual(['draft', 'critique']);
    },
  );
});

test('retry checks approved input and consumes each failure once on its pinned version', async () => {
  const prompts: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        prompts.push(prompt);
        if (prompts.length === 2) throw new RunnerError('cli');
        return {
          kind: 'document',
          text: prompts.length === 1 ? '승인 원본' : '수정본',
        };
      },
    },
    async ({ inject, path, restart }) => {
      const workflow = await setup(inject);
      const id = randomUUID();
      const base = '/runs/' + id;
      await inject('POST', '/runs', {
        id,
        workflowId: workflow.id,
        workflowVersion: 1,
      });
      const waiting = await until(inject, id, 'waiting');
      await inject('POST', base + '/decision', {
        gateId: waiting.gate!.id,
        decision: 'accept',
      });
      const failed = await until(inject, id, 'failed');
      expect(failed.failureId).toBeTruthy();
      await restart();
      expect((await until(inject, id, 'failed')).note).toBe(failed.note);
      const retry = () =>
        inject('POST', base + '/retry', { failureId: failed.failureId });
      const draft = join(path, 'runs', id, 'draft.md');
      await writeFile(draft, '다른 문서');
      expect((await retry()).statusCode).toBe(409);
      expect(prompts).toHaveLength(2);
      await writeFile(draft, '승인 원본\n');
      const changed = structuredClone(definition);
      changed.input = '변경된 자료';
      expect(
        (
          await inject('PUT', '/workflows/' + workflow.id, {
            baseVersion: 1,
            definition: changed,
          })
        ).statusCode,
      ).toBe(200);
      const responses = await Promise.all([retry(), retry()]);
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect((await until(inject, id, 'completed')).results).toEqual([
        'draft.md',
        'revision.md',
      ]);
      expect((await retry()).statusCode).toBe(409);
      expect(prompts).toHaveLength(3);
      const { retryHandoff, ...task } = JSON.parse(prompts[2]!);
      expect(task).toEqual(JSON.parse(prompts[1]!));
      expect(retryHandoff).toEqual({
        runId: id,
        workflowId: workflow.id,
        workflowVersion: 1,
        resumeStepId: 'revision',
        failureId: failed.failureId,
        previousFailure: failed.note,
        verifiedResults: [
          {
            file: 'draft.md',
            sha256: createHash('sha256').update('승인 원본\n').digest('hex'),
          },
        ],
      });
    },
  );
});

test('completed rerun validates its source and repeats approval of changed instructions once', async () => {
  const writes: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        const { currentStepId } = JSON.parse(prompt);
        writes.push(currentStepId);
        return { kind: 'document', text: currentStepId };
      },
    },
    async ({ inject, path }) => {
      const workflow = await setup(inject);
      const id = randomUUID();
      const url = '/runs/' + id;
      const branch = () =>
        inject('POST', url + '/rerun', {
          stepId: 'revision',
          instructions: '변경한 수정 지침',
        });
      await inject('POST', '/runs', {
        id,
        workflowId: workflow.id,
        workflowVersion: 1,
      });
      const waiting = await until(inject, id, 'waiting');
      expect((await branch()).statusCode).toBe(409);
      await inject('POST', url + '/decision', {
        gateId: waiting.gate!.id,
        decision: 'accept',
      });
      await until(inject, id, 'completed');
      const file = join(path, 'runs', id, 'draft.md');
      await writeFile(file, '변경된 초안');
      expect((await branch()).statusCode).toBe(409);
      await unlink(file);
      expect((await branch()).statusCode).toBe(404);
      expect(
        (await inject('GET', '/workflows/' + workflow.id + '/versions/2'))
          .statusCode,
      ).toBe(404);
      await writeFile(file, 'draft\n');
      const results = await Promise.all([branch(), branch()]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const next = runViewSchema.parse(
        results.find((r) => r.statusCode === 200)!.json(),
      );
      const gate = await until(inject, next.summary.id, 'waiting');
      expect(gate.results).toEqual(['draft.md']);
      expect(gate.gate?.text).toContain('변경한 수정 지침');
      expect(gate.gate?.id).not.toBe(waiting.gate?.id);
      expect(writes).toEqual(['draft', 'revision']);
      await inject('POST', '/runs/' + next.summary.id + '/decision', {
        gateId: gate.gate!.id,
        decision: 'decline',
      });
      expect((await until(inject, next.summary.id, 'stopped')).results).toEqual(
        ['draft.md'],
      );
      expect((await branch()).statusCode).toBe(409);
      expect(
        (await inject('GET', '/workflows/' + workflow.id + '/versions/3'))
          .statusCode,
      ).toBe(404);
    },
  );
});

test('keeps fresh material across an idempotent start, retry, comparison and a selective rerun', async () => {
  const sources: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        const { source, currentStepId } = JSON.parse(prompt);
        sources.push(source);
        if (sources.length === 2) throw new RunnerError('cli');
        return { kind: 'document', text: currentStepId + ' ' + source };
      },
    },
    async ({ inject }) => {
      const wf = await inject('POST', '/workflows', {
        ...definition,
        inputFields: ['프로젝트명'],
      });
      const workflowId = (wf.json() as { id: string }).id;
      const id = randomUUID(),
        url = '/runs/' + id;
      const material = { name: '둘째 프로젝트', source: '프로젝트명: 푸른비' };
      const start = { id, workflowId, workflowVersion: 1, material };
      expect(
        (
          await inject('POST', '/runs', {
            ...start,
            material: { ...material, source: '자료 없음' },
          })
        ).statusCode,
      ).toBe(400);
      expect((await inject('POST', '/runs', start)).statusCode).toBe(200);
      expect((await inject('POST', '/runs', start)).statusCode).toBe(200);
      expect(
        (
          await inject('POST', '/runs', {
            ...start,
            material: { ...material, source: '프로젝트명: 다른 자료' },
          })
        ).statusCode,
      ).toBe(409);
      async function accept(runId: string) {
        const gate = await until(inject, runId, 'waiting');
        await inject('POST', '/runs/' + runId + '/decision', {
          decision: 'accept',
          gateId: gate.gate!.id,
        });
      }
      await accept(id);
      const failed = await until(inject, id, 'failed');
      expect(
        (await inject('POST', url + '/retry', { failureId: failed.failureId }))
          .statusCode,
      ).toBe(200);
      await until(inject, id, 'completed');
      expect((await inject('GET', url + '/comparison')).json()).toMatchObject({
        source: material.source,
      });
      const next = runViewSchema.parse(
        (
          await inject('POST', url + '/rerun', {
            stepId: 'revision',
            instructions: '핵심만 수정',
          })
        ).json(),
      );
      await accept(next.summary.id);
      await until(inject, next.summary.id, 'completed');
      expect(
        (
          await inject('GET', '/runs/' + next.summary.id + '/comparison')
        ).json(),
      ).toMatchObject({ source: material.source });
      expect(sources).toEqual(Array(4).fill(material.source));
      expect(
        (await inject('GET', '/workflows/' + workflowId)).json(),
      ).toMatchObject({ definition: { input: definition.input } });
    },
  );
});

test('a changed skill after saving fails before the task calls Codex', async () => {
  const ref = { id: 'a'.repeat(64), digest: 'b'.repeat(64), title: 'example' };
  const read = vi.spyOn(skills, 'readDesignSkill').mockResolvedValue({
    ...ref,
    digest: 'c'.repeat(64),
    scope: 'repo',
    description: '',
    instructions: 'changed',
  });
  const write = vi.fn<DocumentRunner['write']>();
  try {
    await withStudio(
      { ready: async () => '0.166.0', write },
      async ({ inject }) => {
        const flow = {
          ...definition,
          steps: definition.steps.map((s) =>
            s.id === 'draft' ? { ...s, codexSkill: ref } : s,
          ),
        };
        const response = await inject('POST', '/workflows', flow);
        const w = response.json() as { id: string; version: number };
        const id = randomUUID();
        await inject('POST', '/runs', {
          id,
          workflowId: w.id,
          workflowVersion: w.version,
        });
        const failed = await until(inject, id, 'failed');
        expect(failed.stepId).toBe('draft');
        expect(failed.note).toContain('스킬');
        expect(failed.results).toEqual([]);
        expect(write).not.toHaveBeenCalled();
      },
    );
  } finally {
    read.mockRestore();
  }
});

test('a session hands its approved brief to exactly one successor and decline ends the chain', async () => {
  const notes: unknown[] = [];
  const sources: string[] = [],
    missions: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async (prompt) => {
        notes.push(JSON.parse(prompt).roundRequests);
        sources.push(JSON.parse(prompt).source);
        missions.push(JSON.parse(prompt).originalMission);
        return { kind: 'document', text: '다음 세션의 합격 기준' };
      },
    },
    async ({ inject }) => {
      const created = await inject('POST', '/workflows', {
        ...definition,
        steps: [
          definition.steps[0],
          { ...definition.steps[1], startNextSession: true },
        ],
        links: definition.links.slice(0, 1),
      });
      expect(created.statusCode).toBe(201);
      const workflow = created.json() as { id: string; version: number };
      const id = randomUUID();
      await inject('POST', '/runs', {
        id,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
      });
      const first = await until(inject, id, 'waiting');
      expect(first.gate?.startNextSession).toBe(true);
      expect(sources).toHaveLength(1);
      const path = '/runs/' + id + '/session-requests';
      const note = {
        id: randomUUID(),
        text: '모바일 승인 대기를 살펴봐 주세요',
      };
      await inject('POST', path, note);
      expect((await inject('POST', path, note)).json()).toMatchObject({
        outgoing: [note.text],
      });
      const accept = { gateId: first.gate!.id, decision: 'accept' };
      await Promise.all([
        inject('POST', '/runs/' + id + '/decision', accept),
        inject('POST', '/runs/' + id + '/decision', accept),
      ]);
      const finished = await until(inject, id, 'completed');
      const childId = finished.summary.nextSessionId!;
      const child = await until(inject, childId, 'waiting');
      expect(notes).toEqual([undefined, [note.text]]);
      const late = { id: randomUUID(), text: '목록 검색도 확인' };
      expect((await inject('POST', path, late)).json()).toMatchObject({
        runId: childId,
        round: 2,
        incoming: [note.text],
        outgoing: [late.text],
      });
      expect((await inject('GET', path)).json()).toMatchObject({
        outgoing: [note.text],
      });
      expect(child.summary.previousSessionId).toBe(id);
      expect(child.gate?.id).not.toBe(first.gate?.id);
      expect(sources).toEqual([definition.input, '다음 세션의 합격 기준']);
      expect(missions).toEqual([definition.input, definition.input]);
      expect(
        (await inject('POST', '/runs/' + childId + '/decision', accept))
          .statusCode,
      ).toBe(409);
      await inject('POST', '/runs/' + childId + '/decision', {
        gateId: child.gate!.id,
        decision: 'decline',
      });
      expect(
        (await until(inject, childId, 'stopped')).summary.nextSessionId,
      ).toBeUndefined();
      expect((await inject('GET', '/runs')).json()).toHaveLength(2);
    },
  );
});

test('a linked workflow uses its pinned version and returns its last document before approval', async () => {
  const prompts: {
    currentStepId: string;
    instructions: string;
    inputDocuments?: { text: string }[];
  }[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async (raw) => {
        const p = JSON.parse(raw);
        prompts.push(p);
        return { kind: 'document', text: p.currentStepId + ' 문서' };
      },
    },
    async ({ inject }) => {
      const makeTask = (id: string) => ({
        id,
        kind: 'task',
        title: id,
        instructions: id,
        position: { x: 0, y: 0 },
      });
      const child = {
        name: '준비',
        steps: ['check', 'propose', 'direction'].map(makeTask),
        links: [
          { from: 'check', to: 'propose' },
          { from: 'propose', to: 'direction' },
        ],
      };
      const version = (await inject('POST', '/workflows', child)).json() as {
        id: string;
        version: number;
      };
      const call = {
        ...makeTask('prepare'),
        workflowRef: { id: version.id, version: 1 },
      };
      const parent = {
        name: '부모',
        steps: [
          makeTask('evidence'),
          call,
          { ...definition.steps[1], startNextSession: true },
        ],
        links: [
          { from: 'evidence', to: 'prepare' },
          { from: 'prepare', to: 'review' },
        ],
      };
      const saved = await inject('POST', '/workflows', parent);
      expect(saved.statusCode).toBe(201);
      const parentId = (saved.json() as { id: string }).id;
      expect(
        (
          await inject('PUT', '/workflows/' + version.id, {
            baseVersion: 1,
            definition: {
              ...child,
              steps: child.steps.map((s) => ({
                ...s,
                instructions: 'updated',
              })),
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await inject('POST', '/workflows', {
            ...parent,
            steps: [{ ...call, workflowRef: { id: parentId, version: 1 } }],
            links: [],
          })
        ).statusCode,
      ).toBe(400);
      expect(prompts).toHaveLength(0);
      const id = randomUUID();
      await inject('POST', '/runs', {
        id,
        workflowId: parentId,
        workflowVersion: 1,
      });
      const gate = await until(inject, id, 'waiting');
      expect(gate.gate?.startNextSession).toBe(true);
      expect(gate.results).toEqual([
        'evidence.md',
        'prepare--check.md',
        'prepare--propose.md',
        'prepare.md',
      ]);
      expect(prompts.map((p) => p.instructions)).toEqual([
        'evidence',
        'check',
        'propose',
        'direction',
      ]);
      expect(prompts[1]?.inputDocuments?.[0]?.text.trim()).toBe(
        'evidence 문서',
      );
      expect(prompts[3]?.inputDocuments?.[0]?.text.trim()).toBe(
        'prepare--propose 문서',
      );
      expect(gate.summary.nextSessionId).toBeUndefined();
      await inject('POST', '/runs/' + id + '/decision', {
        gateId: gate.gate!.id,
        decision: 'decline',
      });
      expect(
        (await until(inject, id, 'stopped')).summary.nextSessionId,
      ).toBeUndefined();
      expect((await inject('GET', '/runs')).json()).toHaveLength(1);
    },
  );
});

test('UI implementation evidence reaches the handoff without a question or stale source', async () => {
  const evidence = '이번 실행의 변경 내역과 실제 검사 결과';
  const work = vi.spyOn(uiWork, 'runUiWork').mockResolvedValue({
    kind: 'document',
    text: evidence,
  });
  const seen: { source: string; documentOnly?: boolean }[] = [];
  try {
    await withStudio(
      {
        ready: async () => '0.166.0',
        async write(prompt, _signal, _observe, _tool, documentOnly) {
          seen.push({ source: JSON.parse(prompt).source.trim(), documentOnly });
          return { kind: 'document', text: '다음 계획' };
        },
      },
      async ({ inject }) => {
        const saved = await inject('POST', '/workflows', {
          ...definition,
          steps: [
            { ...definition.steps[0], tool: 'workplot-ui' },
            definition.steps[2],
            { ...definition.steps[1], startNextSession: true },
          ],
          links: [
            { from: 'draft', to: 'revision' },
            { from: 'revision', to: 'review' },
          ],
        });
        expect(saved.statusCode).toBe(201);
        const workflow = saved.json() as { id: string; version: number };
        const id = randomUUID();
        await inject('POST', '/runs', {
          id,
          modelSettings: { model: 'gpt-6.2-sol', effort: 'medium' },
          workflowId: workflow.id,
          workflowVersion: workflow.version,
        });
        const view = await until(inject, id, 'waiting');
        expect(view.gate?.startNextSession).toBe(true);
        expect(work).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([{ source: evidence, documentOnly: true }]);
        expect(view.results).toEqual(['draft.md', 'revision.md']);
        await inject('POST', '/runs/' + id + '/decision', {
          gateId: view.gate!.id,
          decision: 'finish',
        });
        expect(
          (await until(inject, id, 'completed')).summary.nextSessionId,
        ).toBeFalsy();
        const config = {
          handoffOnly: true,
          goal: '인계',
          criteria: ['확인'],
          target: 100,
          maxSessions: 2,
          until: new Date(Date.now() + 60000).toISOString(),
        };
        const restart = () =>
          inject('POST', '/runs/' + id + '/delegation/restart', config);
        const replies = await Promise.all([restart(), restart()]);
        expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const child = (
          replies.find((r) => r.statusCode === 200)!.json() as { id: string }
        ).id;
        const next = await until(inject, child, 'waiting');
        expect(next.summary.modelSettings).toEqual({
          model: 'gpt-6.2-sol',
          effort: 'medium',
        });
        expect(next.summary.previousSessionId).toBe(id);
        expect(
          (await inject('GET', '/runs/' + child + '/delegation')).json(),
        ).toMatchObject({ enabled: true, used: 0, config });
      },
    );
  } finally {
    work.mockRestore();
  }
});

test('UI edits apply only to exact unique text and preserve surrounding source', () => {
  expect(uiWork.applyUiEdits('a b c', [{ before: 'b', after: 'B' }])).toBe(
    'a B c',
  );
  expect(uiWork.applyUiEdits('a b c', [])).toBe('a b c');
  for (const before of ['', 'x', 'a']) {
    expect(() =>
      uiWork.applyUiEdits('a b a', [{ before, after: 'z' }]),
    ).toThrow();
  }
  expect(() =>
    uiWork.applyUiEdits('a', [{ before: 'a', after: 'a' }]),
  ).toThrow();
});

test('master children restore separate approval gates and decisions after restart', async () => {
  const writes: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async (prompt) => {
        const p = JSON.parse(prompt);
        writes.push(p.masterTask.taskId + '/' + p.currentStepId);
        return { kind: 'document', text: p.masterTask.taskId + ' 문서' };
      },
    },
    async ({ inject, restart }) => {
      const wf = await setup(inject);
      const ref = { id: wf.id, version: 1 },
        plan = randomUUID(),
        master = randomUUID();
      const url = '/master-plans/' + plan;
      expect(
        (
          await inject('PUT', url, {
            goal: '각 문서 검토',
            tasks: ['left', 'right'].map((id) => ({
              id,
              dependsOn: [],
              workflow: ref,
              documents: { needs: [], output: '결과' },
              doneWhen: '검토 완료',
            })),
          })
        ).statusCode,
      ).toBe(201);
      const launch = () => inject('PUT', url + '/runs/' + master);
      const [r1, r2] = await Promise.all([launch(), launch()]);
      expect(r1.statusCode).toBe(200);
      expect(r2.json()).toEqual(r1.json());
      const { children } = r1.json() as { children: { runId: string }[] };
      const [a, b] = children.map((c) => c.runId) as [string, string];
      const first = await until(inject, a, 'waiting'),
        second = await until(inject, b, 'waiting');
      await restart();
      expect((await until(inject, a, 'waiting')).gate?.id).toBe(first.gate!.id);
      expect((await until(inject, b, 'waiting')).gate?.id).toBe(
        second.gate!.id,
      );
      const decide = (id: string, gateId: string, decision: string) =>
        inject('POST', '/runs/' + id + '/decision', { gateId, decision });
      expect((await decide(a, second.gate!.id, 'accept')).statusCode).toBe(409);
      expect((await decide(a, first.gate!.id, 'decline')).statusCode).toBe(200);
      await until(inject, a, 'stopped');
      expect((await until(inject, b, 'waiting')).results).toEqual(['draft.md']);
      expect((await decide(b, second.gate!.id, 'accept')).statusCode).toBe(200);
      await until(inject, b, 'completed');
      expect(writes.sort()).toEqual([
        'left/draft',
        'right/draft',
        'right/revision',
      ]);
    },
  );
});

test('checks the confirmed Git binding before starting and keeps node calls across restart', async () => {
  let writes = 0;
  const thread = randomUUID();
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(_prompt, _signal, observe) {
        writes++;
        observe({ pid: 123 });
        observe({ sessionId: thread });
        return { kind: 'document', text: '초안' };
      },
    },
    async ({ path, inject, restart }) => {
      const workspace = join(path, 'repo');
      await mkdir(workspace);
      const git = (...args: string[]) =>
        execFileSync('git', [
          '-c',
          'user.name=QA',
          '-c',
          'user.email=qa@localhost',
          '-c',
          'commit.gpgsign=false',
          '-C',
          workspace,
          ...args,
        ]);
      git('init', '-q', '-b', 'main');
      git('commit', '-qm', 'initial', '--allow-empty');
      const version = await setup(inject),
        id = randomUUID(),
        base = { id, workflowId: version.id, workflowVersion: version.version };
      const target = (
        await inject('POST', '/git/targets', {
          service: 'Workplot',
          path: workspace,
        })
      ).json() as NonNullable<
        NonNullable<RunView['summary']['requestFiles']>['gitTarget']
      >;
      const start = (gitTarget?: typeof target) =>
        inject('POST', '/runs', {
          ...base,
          requestFiles: { references: [], workspace, gitTarget },
        });
      expect((await start()).statusCode).toBe(400);
      expect(
        (await start({ ...target, serviceId: randomUUID() })).statusCode,
      ).toBe(400);
      git('switch', '-q', '-c', 'other');
      expect((await start(target)).statusCode).toBe(400);
      expect(writes).toBe(0);
      expect((await inject('GET', '/runs')).json()).toEqual([]);
      git('switch', '-q', 'main');
      expect((await start(target)).statusCode).toBe(200);
      let v = await until(inject, id, 'waiting');
      expect(v.summary.developmentTaskId).toBe(id);
      expect(v.aiCalls).toEqual([
        expect.objectContaining({ step: 'draft', session: thread }),
      ]);
      await restart();
      v = await until(inject, id, 'waiting');
      expect(v.summary.requestFiles?.gitTarget).toEqual(target);
      expect(v.aiCalls?.[0]?.session).toBe(thread);
      expect(writes).toBe(1);
    },
  );
});
test('enforces the saved parallel limit and preserves running tasks when lowered', async () => {
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async () => ({ kind: 'document', text: '결과' }),
    },
    async ({ inject, path, restart }) => {
      const settings = await inject('PUT', '/development-slots', { limit: 3 });
      expect(settings.json()).toMatchObject({
        limit: 3,
        recommended: expect.any(Number),
      });
      expect(
        (await inject('PUT', '/development-slots', { limit: 0 })).statusCode,
      ).toBe(400);
      await restart();
      expect((await inject('GET', '/development-slots')).json()).toMatchObject({
        limit: 3,
      });
      const workspace = join(path, 'parallel');
      await mkdir(workspace);
      const git = (...args: string[]) =>
        execFileSync('git', [
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=QA',
          '-c',
          'user.email=qa@localhost',
          '-C',
          workspace,
          ...args,
        ]);
      git('init', '-qb', 'main');
      git('commit', '-qm', 'base', '--allow-empty');
      const wf = await setup(inject),
        target = (
          await inject('POST', '/git/targets', {
            service: 'QA',
            path: workspace,
          })
        ).json();
      const create = () => ({
        id: randomUUID(),
        workflowId: wf.id,
        workflowVersion: wf.version,
        requestFiles: { workspace, gitTarget: target, references: [] },
      });
      const runs = [create(), create(), create(), create()];
      const res = await Promise.all(
        runs.map((body) => inject('POST', '/runs', body)),
      );
      expect(res.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 409]);
      const admitted = runs.filter((_, i) => res[i]!.statusCode === 200);
      const views = await Promise.all(
        admitted.map((r) => until(inject, r.id, 'waiting')),
      );
      expect(views[0]?.worktree?.directory).toBeTruthy();
      expect(views[0]?.worktree?.directory).not.toBe(
        views[1]?.worktree?.directory,
      );
      expect((await inject('POST', '/runs', admitted[0])).statusCode).toBe(200);
      expect(
        (
          await inject('POST', '/runs', {
            id: randomUUID(),
            workflowId: wf.id,
            workflowVersion: wf.version,
          })
        ).statusCode,
      ).toBe(409);
      await inject('PUT', '/development-slots', { limit: 2 });
      expect((await inject('POST', '/runs', create())).statusCode).toBe(409);
      await inject('POST', '/runs/' + admitted[2]!.id + '/stop');
      await until(inject, admitted[2]!.id, 'stopped');
      expect((await inject('POST', '/runs', create())).statusCode).toBe(409);
      await inject('POST', '/runs/' + admitted[0]!.id + '/stop');
      await until(inject, admitted[0]!.id, 'stopped');
      expect((await inject('POST', '/runs', create())).statusCode).toBe(200);
      expect((await until(inject, admitted[1]!.id, 'waiting')).gate?.id).toBe(
        views[1]?.gate?.id,
      );
    },
  );
});

test('a successor replaces a repeated recommendation before the manual gate', async () => {
  const first = '추천 과제 · 승인 경로 확인';
  const revised = '추천 과제 · 편집 진입점 표시';
  const prompts: {
    priorApprovedRecommendations?: string[];
    correction?: string;
  }[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async (prompt) => {
        const p = JSON.parse(prompt);
        prompts.push(p);
        if (p.task === 'compare_recommendation_scope')
          return {
            kind: 'document',
            text: JSON.stringify({
              match: p.candidate === revised ? null : p.approved[0].runId,
              reason:
                p.candidate === revised
                  ? '편집 진입 경로 개선'
                  : '같은 승인 경로 점검',
            }),
          };
        return {
          kind: 'document',
          text: p.correction
            ? revised
            : p.priorApprovedRecommendations?.length
              ? '추천 과제 · 저장 기록에서 승인 흐름 대조'
              : first,
        };
      },
    },
    async ({ inject }) => {
      const flow = await inject('POST', '/workflows', {
        ...definition,
        steps: [
          definition.steps[0],
          { ...definition.steps[1], title: '추천 과제 승인' },
          definition.steps[2],
          { ...definition.steps[1], id: 'next', startNextSession: true },
        ],
        links: [...definition.links, { from: 'revision', to: 'next' }],
      });
      const id = randomUUID();
      await inject('POST', '/runs', {
        id,
        workflowId: (flow.json() as { id: string }).id,
        workflowVersion: 1,
      });
      for (const step of ['review', 'next']) {
        let v = await until(inject, id, 'waiting');
        for (let i = 0; i < 100 && (!v.gate || v.stepId !== step); i++) {
          await delay(10);
          v = await until(inject, id, 'waiting');
        }
        expect(v.stepId).toBe(step);
        await inject('POST', '/runs/' + id + '/decision', {
          gateId: v.gate!.id,
          decision: 'accept',
        });
      }
      const child = (await until(inject, id, 'completed')).summary
        .nextSessionId!;
      const gate = await until(inject, child, 'waiting');
      expect(gate.stepId).toBe('review');
      expect(
        prompts.some(
          (p) =>
            p.priorApprovedRecommendations?.includes('승인 경로 확인') &&
            p.correction,
        ),
      ).toBe(true);
    },
  );
});

test('copies the completed handoff into the isolated development input and links both runs', async () => {
  const body = '개발 과제와 합격 기준 · 이전 회차의 전체 인계';
  const prompts: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async (prompt) => {
        prompts.push(prompt);
        return { kind: 'document', text: body };
      },
    },
    async ({ path, inject }) => {
      const flow = await inject('POST', '/workflows', {
        ...definition,
        steps: [definition.steps[0]],
        links: [],
      });
      const version = flow.json() as { id: string; version: number };
      const root = randomUUID();
      const start = {
        workflowId: version.id,
        workflowVersion: version.version,
      };
      await inject('POST', '/runs', { ...start, id: root });
      await until(inject, root, 'completed');
      const workspace = join(path, 'handoff-repo');
      await mkdir(workspace);
      execFileSync('git', ['-C', workspace, 'init', '-q', '-b', 'main']);
      execFileSync('git', [
        '-C',
        workspace,
        '-c',
        'user.name=QA',
        '-c',
        'user.email=q@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'base',
        '--allow-empty',
      ]);
      const gitTarget = (
        await inject('POST', '/git/targets', {
          service: '인계 QA',
          path: workspace,
        })
      ).json();
      const id = randomUUID(),
        files = {
          gitTarget,
          references: [],
          workspace,
          handoff: { runId: root, file: 'draft.md' },
        };
      expect(
        (await inject('POST', '/runs', { ...start, id, requestFiles: files }))
          .statusCode,
      ).toBe(200);
      await until(inject, id, 'completed');
      expect(JSON.parse(prompts.at(-1)!)).toMatchObject({
        readOnlyReferences: [
          { name: 'draft.md', text: expect.stringContaining(body) },
        ],
      });
      expect((await inject('GET', '/runs')).json()).toContainEqual(
        expect.objectContaining({ id, handoffRunId: root }),
      );
    },
  );
});

test('edited approval binds the displayed original and advances once with the accepted text', async () => {
  const prompts: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        prompts.push(prompt);
        return {
          kind: 'document',
          text: prompts.length === 1 ? '원본' : '완료',
        };
      },
    },
    async ({ inject, restart }) => {
      const workflow = await setup(inject),
        id = randomUUID(),
        route = '/runs/' + id;
      await inject('POST', '/runs', {
        id,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
      });
      const gate = (await until(inject, id, 'waiting')).gate!;
      const edit = {
        file: 'draft.md',
        expected: createHash('sha256')
          .update((await inject('GET', route + '/results/draft.md')).body)
          .digest('hex'),
        text: '사람이 고친 승인본',
        rule: '완료한 일은 출처를 명시한다.',
      };
      const decision = { gateId: gate.id, decision: 'accept', edit };
      expect(
        (
          await inject('POST', route + '/decision', {
            ...decision,
            edit: { ...edit, expected: '0'.repeat(64) },
          })
        ).statusCode,
      ).toBe(409);
      const replies = await Promise.all(
        [edit.text, '다른 탭 수정'].map((text) =>
          inject('POST', route + '/decision', {
            ...decision,
            edit: { ...edit, text },
          }),
        ),
      );
      expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      await until(inject, id, 'completed');
      expect(prompts).toHaveLength(2);
      const winner =
        replies[0]!.statusCode === 200 ? edit.text : '다른 탭 수정';
      expect(JSON.parse(prompts[1]!).priorDocument).toBe(winner);
      const saved = await inject('GET', '/workflows/' + workflow.id);
      expect(saved.json()).toMatchObject({
        version: 2,
        definition: {
          steps: [{ instructions: '원본 지침\n\n' + edit.rule }, {}, {}],
        },
      });
      expect(
        (await until(inject, id, 'completed')).summary.lastReview
          ?.savedWorkflowVersion,
      ).toBe(2);
      await restart();
      expect((await inject('GET', route + '/results/draft.md')).body).toBe(
        winner,
      );
      expect(
        (await inject('GET', route + '/results/draft.md/reviews')).json(),
      ).toMatchObject({
        original: '원본\n',
        edits: [{ text: winner, expected: edit.expected }],
      });
    },
  );
});

test('QA port retry checks the host once per failure and preserves documents and session', async () => {
  const qa = await import('../src/qa-port.js');
  const probe = vi.spyOn(qa, 'reserveQaPort');
  try {
    let calls = 0;
    const original =
      'QA 서버가 루프백 포트 할당 단계에서 EPERM으로 차단됐습니다.';
    await withStudio(
      {
        ready: async () => '0.166.0',
        async write() {
          calls++;
          return { kind: 'document', text: original };
        },
      },
      async ({ inject, restart }) => {
        const wf = (
          await inject('POST', '/workflows', {
            ...definition,
            steps: [{ ...definition.steps[0], id: 'change-evidence' }],
            links: [],
          })
        ).json() as { id: string; version: number };
        const id = randomUUID(),
          route = '/runs/' + id;
        await inject('POST', '/runs', {
          id,
          workflowId: wf.id,
          workflowVersion: wf.version,
        });
        const run = await until(inject, id, 'completed'),
          token = run.portCheck!.token;
        probe.mockRejectedValueOnce(Object.assign(Error(), { code: 'EPERM' }));
        const failed = (
          await inject('POST', route + '/qa-port/retry', { token })
        ).json() as { status: string; token: string };
        expect(failed.status).toBe('failed');
        expect(failed.token).not.toBe(token);
        const release = vi.fn();
        if (process.env.WORKPLOT_HOST_ISOLATION_QA !== '1')
          probe.mockResolvedValueOnce({ port: 23456, release });

        const results = await Promise.all(
          [1, 2].map(() =>
            inject('POST', route + '/qa-port/retry', { token: failed.token }),
          ),
        );
        expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect(probe).toHaveBeenCalledTimes(2);
        if (process.env.WORKPLOT_HOST_ISOLATION_QA !== '1')
          expect(release).toHaveBeenCalledOnce();
        await restart();
        expect((await until(inject, id, 'completed')).portCheck?.status).toBe(
          'passed',
        );
        expect(
          (await inject('GET', route + '/results/change-evidence.md')).body,
        ).toBe(original + '\n');
        expect(calls).toBe(1);
      },
    );
  } finally {
    probe.mockRestore();
  }
});

test('a skipped commit with pending edits stays retryable at the commit step', async () => {
  let edit = true;
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(
        prompt,
        _signal,
        _observe,
        _tool,
        _evidence,
        _images,
        directory,
      ) {
        if (JSON.parse(prompt).currentStepId === 'draft' && edit) {
          await writeFile(join(directory!, 'candidate.txt'), '미검증 작업');
        }
        return { kind: 'document', text: '검증 미충족' };
      },
    },
    async ({ inject, path }) => {
      const workspace = join(path, 'source');
      await mkdir(workspace);
      execFileSync('git', ['-C', workspace, 'init', '-qb', 'main']);
      execFileSync('git', [
        '-C',
        workspace,
        '-c',
        'user.name=QA',
        '-c',
        'user.email=qa@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'base',
      ]);
      const gitTarget = (
        await inject('POST', '/git/targets', { service: 'QA', path: workspace })
      ).json();
      const workflow = (
        await inject('POST', '/workflows', {
          name: '커밋 인계 검사',
          steps: [
            { ...definition.steps[0], workspaceAccess: 'write' },
            { ...definition.steps[2], id: 'check', tool: 'verified-commit' },
            { ...definition.steps[1], startNextSession: true },
          ],
          links: [
            { from: 'draft', to: 'check' },
            { from: 'check', to: 'review' },
          ],
        })
      ).json() as { id: string; version: number };
      async function start() {
        const id = randomUUID();
        expect(
          (
            await inject('POST', '/runs', {
              id,
              workflowId: workflow.id,
              workflowVersion: workflow.version,
              requestFiles: { workspace, gitTarget, references: [] },
            })
          ).statusCode,
        ).toBe(200);
        return id;
      }
      const dirty = await until(inject, await start(), 'failed');
      expect(dirty.failureId).toBeTruthy();
      expect(dirty.note).toContain('이 커밋 단계');
      expect(dirty.results).toEqual(['draft.md']);
      expect(dirty.summary.nextSessionId).toBeUndefined();
      edit = false;
      const clean = await until(inject, await start(), 'waiting');
      expect(clean.results).toEqual(['draft.md', 'check.md']);
      expect(clean.gate?.startNextSession).toBe(true);
    },
  );
});

test('a stale workflow version rolls back the review and still allows a result-only approval', async () => {
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async () => ({ kind: 'document', text: 'draft' }),
    },
    async ({ inject }) => {
      const flow = await setup(inject),
        id = randomUUID(),
        url = '/runs/' + id;
      await inject('POST', '/runs', {
        id,
        workflowId: flow.id,
        workflowVersion: 1,
      });
      const waiting = await until(inject, id, 'waiting');
      await inject('PUT', '/workflows/' + flow.id, {
        baseVersion: 1,
        definition: { ...definition, name: '새 이름' },
      });
      const edit = {
        file: 'draft.md',
        expected: createHash('sha256').update('draft\n').digest('hex'),
        text: '검토본',
      };
      const decision = { decision: 'accept', gateId: waiting.gate!.id };
      expect(
        (
          await inject('POST', url + '/decision', {
            ...decision,
            edit: { ...edit, rule: '새 규칙' },
          })
        ).statusCode,
      ).toBe(409);
      expect((await until(inject, id, 'waiting')).gate?.id).toBe(
        waiting.gate!.id,
      );
      expect((await inject('GET', url + '/results/draft.md')).body).toBe(
        'draft\n',
      );
      expect(
        (await inject('POST', url + '/decision', { ...decision, edit }))
          .statusCode,
      ).toBe(200);
      await until(inject, id, 'completed');
      expect(
        (await inject('GET', '/workflows/' + flow.id)).json(),
      ).toMatchObject({ version: 2 });
    },
  );
});
test('a retry receives only observed check labels and reports repeated checks and recovery to the user', async () => {
  let attempt = 0;
  await withStudio(
    {
      ready: async () => '0.166.0',
      async write(prompt) {
        attempt++;
        const check = commandCheck(
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: 'npm run typecheck -- local-only-argument',
              exit_code: 0,
            },
          }),
        )!;
        codexCallContext.getStore()!.check!(check);
        if (attempt === 1) throw new RunnerError('timeout');
        const handoff = JSON.parse(prompt).retryHandoff;
        expect(handoff.previousChecks).toEqual([
          { label: 'typecheck', status: '통과' },
        ]);
        expect(prompt).not.toContain('local-only-argument');
        return { kind: 'document', text: '검사 완료' };
      },
    },
    async ({ inject }) => {
      const flow = (
        await inject('POST', '/workflows', {
          ...definition,
          steps: [definition.steps[0]],
          links: [],
        })
      ).json() as { id: string };
      const id = randomUUID(),
        url = '/runs/' + id;
      await inject('POST', '/runs', {
        id,
        workflowId: flow.id,
        workflowVersion: 1,
      });
      const failed = await until(inject, id, 'failed');
      await inject('POST', url + '/retry', { failureId: failed.failureId });
      await until(inject, id, 'completed');
      expect((await inject('GET', url + '/timeouts')).json()).toMatchObject([
        {
          step: 'draft',
          attempts: [
            {
              parallel: 1,
              lastCheck: 'typecheck · 통과',
              repeatedChecks: 1,
              recoveredMs: expect.any(Number),
            },
          ],
        },
      ]);
    },
  );
});

test('approving a linked result versions its owning child and pins the new child in the parent', async () => {
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async () => ({ kind: 'document', text: '원문' }),
    },
    async ({ inject }) => {
      const child = (
        await inject('POST', '/workflows', {
          name: '연결 작업',
          steps: [{ ...definition.steps[0], skill: 'none' }],
          links: [],
        })
      ).json() as { id: string };
      const flow = (
        await inject('POST', '/workflows', {
          ...definition,
          steps: [
            {
              ...definition.steps[0],
              id: 'report',
              skill: 'none',
              workflowRef: { id: child.id, version: 1 },
            },
            definition.steps[1],
          ],
          links: [{ from: 'report', to: 'review' }],
        })
      ).json() as { id: string };
      const id = randomUUID(),
        url = '/runs/' + id;
      await inject('POST', '/runs', {
        id,
        workflowId: flow.id,
        workflowVersion: 1,
      });
      const waiting = await until(inject, id, 'waiting');
      const body = (await inject('GET', url + '/results/report.md')).body;
      expect(
        (
          await inject('POST', url + '/decision', {
            decision: 'accept',
            gateId: waiting.gate!.id,
            edit: {
              file: 'report.md',
              expected: createHash('sha256').update(body).digest('hex'),
              text: body,
              rule: '추가 지침',
            },
          })
        ).statusCode,
      ).toBe(200);
      const end = await until(inject, id, 'completed');
      expect(end.editedFiles).toEqual([]);
      expect(end.summary.workflowVersion).toBe(1);
      expect(
        (await inject('GET', '/workflows/' + flow.id)).json(),
      ).toMatchObject({
        version: 2,
        definition: {
          steps: [{ workflowRef: { id: child.id, version: 2 } }, {}],
        },
      });
      expect(
        (await inject('GET', '/workflows/' + child.id)).json(),
      ).toMatchObject({
        version: 2,
        definition: { steps: [{ instructions: '원본 지침\n\n추가 지침' }] },
      });
    },
  );
});
