import { z } from 'zod';
import {
  orderedSteps,
  workflowDefinitionSchema,
  workflowPlan,
  type WorkflowDefinition,
} from './workflows.js';

const clarificationTurn = z.strictObject({
  question: z.string().trim().min(1).max(1000),
  answer: z.string().trim().min(1).max(1000),
});
export type ClarificationTurn = z.infer<typeof clarificationTurn>;
const clarifications = z.array(clarificationTurn).min(1).optional();

export const proposalRequestSchema = z.union([
  z.strictObject({
    request: z.string().trim().min(1).max(2000),
    definition: workflowDefinitionSchema,
    clarifications,
  }),
  z.strictObject({
    mode: z.literal('create'),
    clarifications,
    request: z.string().trim().min(1).max(1000),
  }),
]);

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const inputFrom = z.array(id).max(4);
const edits = z.strictObject({
  clarification: z.string().max(1000),
  additions: z
    .array(
      z.strictObject({
        after: id,
        id,
        title: z.string().trim().min(1).max(100),
        instructions: z.string().trim().min(1).max(8000),
        inputFrom,
      }),
    )
    .max(31),
  inputs: z.array(z.strictObject({ stepId: id, inputFrom })).max(32),
});
const plannedStep = { id, title: z.string().trim().min(1).max(100) };
const newFlow = z.strictObject({
  clarification: z.string().trim().max(1000),
  name: z.string().trim().max(100),
  steps: z
    .array(
      z.union([
        z.strictObject({
          ...plannedStep,
          kind: z.literal('task'),
          instructions: z.string().trim().min(1).max(8000),
          inputFrom,
        }),
        z.strictObject({ ...plannedStep, kind: z.literal('review') }),
      ]),
    )
    .max(32),
});

const clarifiedFlow = newFlow.extend({
  resolvedGoal: z.string().trim().max(1000),
});
export function buildNewProposal(
  goal: string,
  raw: unknown,
  clarified = false,
): z.infer<typeof proposalResponseSchema> {
  const plan = clarified
    ? clarifiedFlow.parse(raw)
    : { ...newFlow.parse(raw), resolvedGoal: goal };
  if (plan.clarification) {
    if (plan.steps.length) throw new Error('ambiguous proposal');
    return { kind: 'question', text: plan.clarification };
  }
  if (!plan.resolvedGoal) throw new Error('missing goal');
  if (!plan.steps.some((step) => step.kind === 'task'))
    throw new Error('no task');
  const steps = plan.steps.map((step, index) => ({
    ...step,
    ...(step.kind === 'task' && { agent: 'codex' as const }),
    position: { x: index * 240, y: 90 },
  }));
  const links = steps
    .slice(1)
    .map((step, index) => ({ from: steps[index]!.id, to: step.id }));
  return {
    kind: 'proposal',
    definition: workflowDefinitionSchema.parse({
      goal: plan.resolvedGoal,
      name: plan.name,
      steps,
      links,
    }),
  };
}
export function proposalOutputSchema(
  mode: 'create' | 'edit' = 'edit',
  clarified = false,
) {
  return z.toJSONSchema(
    mode === 'edit' ? edits : clarified ? clarifiedFlow : newFlow,
    {
      target: 'draft-7',
    },
  );
}

export const proposalResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question'), text: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('proposal'),
    definition: workflowDefinitionSchema,
  }),
]);

export function buildProposal(
  base: WorkflowDefinition,
  raw: unknown,
): z.infer<typeof proposalResponseSchema> {
  const { clarification, additions, inputs } = edits.parse(raw);
  if (clarification.trim()) {
    if (additions.length || inputs.length)
      throw new Error('ambiguous proposal');
    return { kind: 'question', text: clarification.trim() };
  }
  if (!additions.length && !inputs.length) throw new Error('empty proposal');
  const steps = orderedSteps(base).map((step) => ({ ...step }));
  for (const add of additions) {
    const index = steps.findIndex((step) => step.id === add.after);
    const anchor = steps[index];
    if (!anchor || steps.some((step) => step.id === add.id))
      throw new Error('invalid insertion');
    const x = anchor.position.x;
    const occupied = steps.filter(
      (step) => Math.abs(step.position.x - x) < 180,
    );
    const y =
      Math.max(anchor.position.y, ...occupied.map((step) => step.position.y)) +
      140;
    const position = { x, y };
    steps.splice(index + 1, 0, {
      id: add.id,
      title: add.title,
      instructions: add.instructions,
      kind: 'task',
      agent: 'codex',
      inputFrom: add.inputFrom,
      position,
    });
  }
  const originalInputs = new Map(
    workflowPlan(base).steps.map((step) => [step.id, step.inputs]),
  );
  const targets = new Map(
    inputs.map((input) => [input.stepId, input.inputFrom]),
  );
  if (
    targets.size !== inputs.length ||
    inputs.some(
      (input) =>
        !steps.some((step) => step.kind === 'task' && step.id === input.stepId),
    )
  )
    throw new Error('invalid input target');
  const links = steps
    .slice(1)
    .map((step, index) => ({ from: steps[index]!.id, to: step.id }));
  const definition = { ...base, steps, links };
  for (const effective of workflowPlan(definition).steps) {
    const step = steps.find((step) => step.id === effective.id)!;
    if (step.kind !== 'task') continue;
    const desired = targets.get(step.id) ?? originalInputs.get(step.id);
    if (desired && JSON.stringify(desired) !== JSON.stringify(effective.inputs))
      step.inputFrom = desired;
  }
  return {
    kind: 'proposal',
    definition: workflowDefinitionSchema.parse(definition),
  };
}
