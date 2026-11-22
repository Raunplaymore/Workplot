import type { WorkflowDefinition } from './workflows.js';

type Step = WorkflowDefinition['steps'][number];
const spacing = 240;

function isHorizontalRow(steps: Step[]) {
  return steps.every(
    (s, i) =>
      s.position.y === steps[0]!.position.y &&
      (i === 0 || s.position.x > steps[i - 1]!.position.x),
  );
}

export function insertWorkflowStep(
  steps: Step[],
  after: number,
  entry: Step,
): Step[] {
  const anchor = steps[after]!.position;
  let x = anchor.x + spacing;
  let y = anchor.y;
  const tail = steps.slice(after + 1);
  if (isHorizontalRow(steps)) {
    // Shift only until an existing gap absorbs the inserted card.
    let minimum = x + spacing;
    for (const [i, node] of tail.entries()) {
      if (node.position.x >= minimum) break;
      tail[i] = { ...node, position: { x: minimum, y: node.position.y } };
      minimum += spacing;
    }
  } else {
    const next = tail[0]?.position;
    if (next) {
      x = Math.round((next.x + anchor.x) / 2);
      y = Math.round((next.y + anchor.y) / 2);
    }
    const occupied = () =>
      steps.some(
        (s) =>
          Math.abs(s.position.x - x) < spacing &&
          Math.abs(s.position.y - y) < 160,
      );
    if (occupied()) {
      x = anchor.x + spacing;
      y = anchor.y;
    }
    while (occupied()) y += 160;
  }
  return [
    ...steps.slice(0, after + 1),
    { ...entry, position: { x, y } },
    ...tail,
  ];
}

export function removeWorkflowStep(steps: Step[], index: number): Step[] {
  const tail = steps.slice(index + 1);
  let previous = steps[index]!.position.x;
  if (isHorizontalRow(steps)) {
    for (const [i, node] of tail.entries()) {
      if (node.position.x !== previous + spacing) break;
      tail[i] = { ...node, position: { ...node.position, x: previous } };
      previous = node.position.x;
    }
  }
  return [...steps.slice(0, index), ...tail];
}
