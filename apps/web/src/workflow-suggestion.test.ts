import { expect, test } from 'vitest';
import { type WorkflowDefinition } from '@studio/contracts';
import { workflowSuggestion } from './workflow-suggestion';

const draft = {
  id: 'a',
  title: '초안 작성',
  kind: 'task',
  agent: 'codex',
  instructions: '소개문을 작성하세요.',
  position: { x: 0, y: 0 },
} as const;
const flow: WorkflowDefinition = { name: '소개문', steps: [draft], links: [] };
test('suggests only a gap in the requested outcome', () => {
  expect(workflowSuggestion(flow)).toBeUndefined();
  for (const [goal, label, fulfilled] of [
    [
      '선택지를 제시',
      '선택지의 장단점을 보여주고 내가 고르게 해줘',
      '선택을 질문하세요.',
    ],
    ['사실 확인', '문서의 사실을 원본과 대조해줘', '원본과 대조하세요.'],
  ] as const) {
    expect(workflowSuggestion({ ...flow, goal })?.request).toBe(label);
    expect(
      workflowSuggestion({
        ...flow,
        goal,
        steps: [{ ...draft, instructions: fulfilled }],
      }),
    ).toBeUndefined();
  }
  expect(
    workflowSuggestion({ ...flow, goal: '세부 목표 수립' })?.request,
  ).toContain('완료 기준');
  expect(
    workflowSuggestion({
      ...flow,
      goal: '세부 목표 수립',
      doneWhen: '각 목표를 확인',
    }),
  ).toBeUndefined();
  expect(
    workflowSuggestion({ ...flow, goal: '선택지 없이 작성' }),
  ).toBeUndefined();
});
