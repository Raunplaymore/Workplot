import { createHash } from 'node:crypto';
import {
  orderedSteps,
  workflowPlan,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '@studio/contracts';

export class InvalidWorkflowLink extends Error {}

export function expandWorkflow(
  parentId: string,
  definition: WorkflowDefinition,
  lookup: (id: string, version: number) => { definition: WorkflowDefinition },
  onLinkedStep?: (runtimeId: string, callId: string, childStep: string) => void,
): WorkflowDefinition {
  if (
    !definition.steps.some((step) => step.kind === 'task' && step.workflowRef)
  )
    return definition;
  const parentInputs = new Map(
    workflowPlan(definition).steps.map((step) => [step.id, step.inputs]),
  );
  const expanded: WorkflowDefinition['steps'] = [];
  for (const call of orderedSteps(definition)) {
    if (call.kind !== 'task' || !call.workflowRef) {
      expanded.push(call);
      continue;
    }
    const ref = call.workflowRef;
    if (
      ref.id === parentId ||
      call.tool ||
      call.codexSkill ||
      call.skill === 'source-check'
    )
      throw new InvalidWorkflowLink('Incompatible calling step');
    const child = lookup(ref.id, ref.version).definition;
    const steps = orderedSteps(child);
    const last = steps.at(-1);
    if (steps.some((s) => s.kind === 'review' && s.startNextSession))
      throw new InvalidWorkflowLink('Starts a next session');
    if (steps.some((s) => s.kind === 'task' && s.workflowRef))
      throw new InvalidWorkflowLink('Contains a linked workflow');
    if (steps[0]?.kind !== 'task')
      throw new InvalidWorkflowLink('Starts with approval');
    if (last?.kind !== 'task')
      throw new InvalidWorkflowLink('Ends with approval');
    const plan = workflowPlan(child);
    function mapped(id: string) {
      if (id === last?.id) return call.id;
      const key = call.id + '--' + id;
      return key.length <= 64
        ? key
        : 'linked-' +
            createHash('sha256').update(key).digest('hex').slice(0, 32);
    }
    for (const [index, step] of steps.entries()) {
      const id = mapped(step.id);
      onLinkedStep?.(id, call.id, step.id);
      if (step.kind === 'review') {
        expanded.push({ ...step, id });
        continue;
      }
      expanded.push({
        ...step,
        id,
        agent: call.agent === 'unassigned' ? 'unassigned' : step.agent,
        inputFrom:
          index === 0
            ? parentInputs.get(call.id)
            : plan.steps[index]!.inputs.map(mapped),
      });
    }
  }
  const runtime = {
    ...definition,
    steps: expanded,
    links: expanded
      .slice(1)
      .map((s, i) => ({ from: expanded[i]!.id, to: s.id })),
  };
  if (!workflowDefinitionSchema.safeParse(runtime).success)
    throw new InvalidWorkflowLink(
      expanded.length > 32
        ? 'Combined workflow exceeds 32 steps'
        : 'Conflicting step IDs or document connections',
    );
  return runtime;
}
