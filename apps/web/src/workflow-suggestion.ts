import { orderedSteps, type WorkflowDefinition } from '@studio/contracts';

export function workflowSuggestion(
  flow: WorkflowDefinition,
): string | undefined {
  const steps = orderedSteps(flow);
  if (steps.length !== flow.steps.length || steps.length === 0) return;
  const tasks = steps.filter((s) => s.kind === 'task');
  const intent = [flow.goal, flow.doneWhen].join(' ');
  const instructions = tasks
    .map((s) => s.title + ' ' + s.instructions)
    .join(' ');
  // An explicit opt-out should never become a shortcut to add more work.
  if (/없이|불필요|생략|건너뛰|제외|하지 않|하지 말|필요 없/.test(intent))
    return;
  if (
    steps.length < 32 &&
    !steps.some((s) => s.kind === 'review') &&
    steps.some(
      (s, i) =>
        /초안|draft/i.test(s.title) &&
        /수정|개정|다듬|revis/i.test(steps[i + 1]?.title ?? ''),
    ) &&
    !/자동/.test(intent)
  )
    return '초안을 내가 확인한 뒤 수정해줘';
  if (
    /선택지|여러 안|대안 비교/.test(intent) &&
    !/선택|장단점|질문/.test(instructions)
  )
    return '선택지의 장단점을 보여주고 내가 고르게 해줘';
  if (
    /사실 확인|원본 대조|정확성 검토/.test(intent) &&
    !tasks.some(
      (s) =>
        s.skill === 'source-check' ||
        /대조|사실 확인|검증|검토/.test(s.instructions + ' ' + s.title),
    )
  )
    return '문서의 사실을 원본과 대조해줘';
  if (
    /세부 목표|목표별|하위 목표/.test(flow.goal ?? '') &&
    !flow.doneWhen?.trim()
  )
    return '목표를 나누고 각각의 완료 기준을 정해줘';
}
