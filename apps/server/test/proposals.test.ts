import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildProposal,
  buildNewProposal,
  proposalRequestSchema,
  workflowDefinitionSchema,
  workflowPlan,
} from '@studio/contracts';
const base = workflowDefinitionSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../qa/workflow.json', import.meta.url), 'utf8'),
  ),
);
const addition = {
  after: 'draft',
  id: 'critique',
  title: 'AI 검토',
  instructions: '초안을 검토하세요.',
  inputFrom: ['draft'],
};
const edits = {
  clarification: '',
  additions: [addition],
  inputs: [{ stepId: 'revision', inputFrom: ['draft', 'critique'] }],
};
test('proposals preserve gates, task settings and implicit inputs outside the requested changes', () => {
  const original = structuredClone(base);
  const result = buildProposal(base, edits);
  if (result.kind !== 'proposal') throw Error('expected proposal');
  const steps = workflowPlan(result.definition).steps;
  expect(steps.map((s) => s.id)).toEqual([
    'draft',
    'critique',
    'review',
    'revision',
  ]);
  expect(steps.at(-1)?.inputs).toEqual(['draft', 'critique']);
  expect(result.definition.steps.find((s) => s.id === 'review')).toEqual(
    base.steps.find((s) => s.id === 'review'),
  );
  const insertion = buildProposal(base, { ...edits, inputs: [] });
  if (insertion.kind !== 'proposal') throw Error('expected proposal');
  expect(workflowPlan(insertion.definition).steps.at(-1)?.inputs).toEqual([
    'draft',
  ]);
  expect(base).toEqual(original);
});
test('rejects unrepresentable edits and handles clarification without changes', () => {
  for (const invalid of [
    { ...edits, remove: ['review'] },
    { ...edits, additions: [{ ...addition, id: 'draft' }] },
    { ...edits, additions: [{ ...addition, after: 'missing' }] },
    { ...edits, inputs: [{ stepId: 'critique', inputFrom: ['revision'] }] },
    { ...edits, inputs: [{ stepId: 'review', inputFrom: ['draft'] }] },
    { ...edits, clarification: '어떤 문서인가요?' },
  ])
    expect(() => buildProposal(base, invalid)).toThrow();
  expect(
    buildProposal(base, {
      clarification: '어떤 문서인가요?',
      additions: [],
      inputs: [],
    }),
  ).toEqual({ kind: 'question', text: '어떤 문서인가요?' });
});

test('a new goal produces a serial definition with a human gate and only earlier document inputs', () => {
  const task = {
    id: 'draft',
    kind: 'task',
    title: '초안',
    instructions: '자료로 초안을 작성하세요.',
    inputFrom: [],
  };
  const review = { id: 'approve', kind: 'review', title: '내 승인' };
  const revision = { ...task, id: 'revision', inputFrom: ['draft'] };
  const plan = {
    clarification: '',
    name: '매장 소개',
    steps: [task, review, revision],
  };
  const result = buildNewProposal('매장 소개', plan);
  if (result.kind !== 'proposal') throw Error('expected proposal');
  expect(
    workflowPlan(result.definition).steps.map((s) => [s.kind, s.inputs]),
  ).toEqual([
    ['task', []],
    ['review', ['draft']],
    ['task', ['draft']],
  ]);
  for (const steps of [
    [review],
    [task, task],
    [{ ...task, inputFrom: ['revision'] }, revision],
    [task, review, { ...revision, inputFrom: ['approve'] }],
  ])
    expect(() => buildNewProposal('목표', { ...plan, steps })).toThrow();
  expect(
    buildNewProposal('도와줘', {
      clarification: '어떤 문서를 만들까요?',
      name: '',
      steps: [],
    }),
  ).toEqual({ kind: 'question', text: '어떤 문서를 만들까요?' });
  expect(() =>
    buildNewProposal('목표', { ...plan, clarification: '질문' }),
  ).toThrow();
  expect(
    proposalRequestSchema.safeParse({
      mode: 'create',
      request: '목표',
      definition: base,
    }).success,
  ).toBe(false);
});

test('clarified proposals validate the exchange and carry the resolved goal into the definition', () => {
  const request = {
    mode: 'create',
    request: '도와줘',
    clarifications: [{ question: '어떤 문서인가요?', answer: '안내문' }],
  };
  expect(proposalRequestSchema.safeParse(request).success).toBe(true);
  expect(
    proposalRequestSchema.safeParse({
      ...request,
      clarifications: [{ question: '어떤 문서인가요?', answer: '  ' }],
    }).success,
  ).toBe(false);
  const plan = {
    name: '매장 안내',
    resolvedGoal: '방문객 안내문 작성',
    clarification: '',
    steps: [
      {
        id: 'draft',
        kind: 'task',
        title: '안내문',
        instructions: '안내하세요.',
        inputFrom: [],
      },
    ],
  };
  const result = buildNewProposal(request.request, plan, true);
  expect(result).toMatchObject({
    kind: 'proposal',
    definition: { goal: plan.resolvedGoal },
  });
  expect(() =>
    buildNewProposal(request.request, { ...plan, resolvedGoal: '' }, true),
  ).toThrow();
  expect(
    buildNewProposal(
      request.request,
      {
        name: '',
        resolvedGoal: '',
        clarification: '누가 읽을 문서인가요?',
        steps: [],
      },
      true,
    ),
  ).toEqual({ kind: 'question', text: '누가 읽을 문서인가요?' });
});
