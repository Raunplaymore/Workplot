import { expect, it } from 'vitest';
import {
  fitContext,
  insertFittedNode,
  templateFromStep,
  type WorkflowDefinition,
  type NodeTemplate,
} from '@studio/contracts';
const flow: WorkflowDefinition = {
  name: '카페 안내',
  input: '비공개 매장 정보',
  steps: [
    {
      id: 'draft',
      title: '초안',
      kind: 'task',
      instructions: '초안 작성',
      position: { x: 0, y: 0 },
    },
    {
      id: 'approve',
      title: '승인',
      kind: 'review',
      position: { x: 240, y: 0 },
    },
    {
      id: 'final',
      title: '수정',
      kind: 'task',
      instructions: '수정',
      position: { x: 480, y: 0 },
    },
  ],
  links: [
    { from: 'draft', to: 'approve' },
    { from: 'approve', to: 'final' },
  ],
};
const template: NodeTemplate = {
  title: '문장 검토',
  kind: 'task',
  instructions: '맞춤법 검사',
  needs: ['초안'],
  output: '검토 의견',
};
const fit = {
  instructions: '소개문 초안의 오탈자를 확인한다.',
  reason: '초안을 받음',
  sources: ['draft'],
};
it('stores portable roles and omits original material, edges and document identifiers', () => {
  const snapshot = templateFromStep(flow, 'final');
  expect(snapshot).toMatchObject({ needs: ['초안'], output: '수정 결과' });
  expect(snapshot).not.toHaveProperty('position');
  expect(snapshot).not.toHaveProperty('inputFrom');
  expect(JSON.stringify(fitContext(flow, 'draft'))).not.toContain(flow.input);
});
it('preserves the approval and old document when inserting review output; leaves source definition independent', () => {
  const next = insertFittedNode(flow, 'draft', template, fit, 'check', true);
  expect(next.steps.map((n) => n.id)).toEqual([
    'draft',
    'check',
    'approve',
    'final',
  ]);
  expect(next.steps[3]).toMatchObject({ inputFrom: ['draft', 'check'] });
  expect(flow.steps[2]).not.toHaveProperty('inputFrom');
  expect(
    insertFittedNode(flow, 'draft', template, fit, 'check', false).steps[3],
  ).toMatchObject({ inputFrom: ['draft'] });
});
it('requires an explicit input choice for unresolved or impossible bindings', () => {
  for (const id of [null, 'final', 'no-such-step']) {
    expect(() =>
      insertFittedNode(
        flow,
        'draft',
        template,
        { ...fit, sources: [id] },
        'check',
        true,
      ),
    ).toThrow();
  }
  expect(
    insertFittedNode(
      flow,
      'draft',
      template,
      { ...fit, sources: ['@source'] },
      'check',
      false,
    ).steps[1],
  ).toMatchObject({ inputFrom: [] });
});
