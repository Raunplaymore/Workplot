import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import {
  runViewSchema,
  runEventsSchema,
  type RunView,
  type WorkflowDefinition,
} from '@studio/contracts';
import { buildApp } from '../src/app.js';
import { RunnerError, type DocumentRunner } from '../src/codex-runner.js';

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
  const app = await buildApp(
    join(path, 'runs.sqlite'),
    undefined,
    undefined,
    runner,
  );
  try {
    const session = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: browser,
    });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    await work({
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
    async ({ inject, path }) => {
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
      expect(prompts[2]).toBe(prompts[1]);
    },
  );
});
