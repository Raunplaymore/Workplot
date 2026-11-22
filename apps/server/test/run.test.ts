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
  const sources: string[] = [],
    missions: string[] = [];
  await withStudio(
    {
      ready: async () => '0.166.0',
      write: async (prompt) => {
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
      const accept = { gateId: first.gate!.id, decision: 'accept' };
      await Promise.all([
        inject('POST', '/runs/' + id + '/decision', accept),
        inject('POST', '/runs/' + id + '/decision', accept),
      ]);
      const finished = await until(inject, id, 'completed');
      const childId = finished.summary.nextSessionId!;
      const child = await until(inject, childId, 'waiting');
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
