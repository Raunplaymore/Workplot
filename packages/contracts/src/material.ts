import type { WorkflowDefinition } from './workflows.js';

export function requiredInputFields(flow: WorkflowDefinition): string[] {
  if (flow.inputFields) return [...new Set(flow.inputFields)];
  const task = [
    flow.name,
    flow.goal,
    flow.doneWhen,
    ...flow.steps.flatMap((s) => (s.kind === 'task' ? [s.instructions] : [])),
  ].join(' ');
  const fields = ['주소', '영업시간'].filter((field) =>
    task.replaceAll(' ', '').includes(field),
  );
  if (/매장|서점|가게|카페/.test(task)) fields.unshift('매장명');
  return fields;
}

export function missingInputFields(fields: string[], source: string): string[] {
  const lines = source.split(/[\n,;]/).map((s) => s.trim());
  return fields.filter((field) => {
    const aliases =
      field === '매장명' ? ['매장명', '매장 이름', '상호명'] : [field];
    if (
      lines.some((line) =>
        aliases.some((label) => {
          if (!line.startsWith(label)) return false;
          return /^\s*[:：]\s*\S/u.test(line.slice(label.length));
        }),
      )
    )
      return false;
    if (field === '영업시간')
      return !/\d{1,2}:\d{2}\s*[~–—-]\s*\d{1,2}:\d{2}|24시간 영업/.test(source);
    if (field === '주소')
      return !/[가-힣0-9]+(?:대로|로|길)\s*\d+(?:-\d+)?/.test(source);
    if (field === '매장명')
      return !lines.some((line) =>
        /^[^:：]{1,45}(?:서점|카페|식당|상점)$/.test(line),
      );
    return true;
  });
}
