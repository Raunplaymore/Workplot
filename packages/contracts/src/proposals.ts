import { insertWorkflowStep } from './workflow-layout.js';
import { z } from 'zod';
import {
  codexSkillRefSchema,
  type TaskSkill,
  orderedSteps,
  workflowDefinitionSchema,
  workflowPlan,
  type WorkflowDefinition,
} from './workflows.js';

export const designSkillRefSchema = codexSkillRefSchema;
const designSkillSummarySchema = z.strictObject({
  id: codexSkillRefSchema.shape.id,
  title: z.string().min(1),
  description: z.string(),
  scope: z.string(),
});
export const designSkillsSchema = z.array(designSkillSummarySchema);
export const designSkillSchema = designSkillSummarySchema.extend({
  ...designSkillRefSchema.shape,
  instructions: z.string().min(1),
});
export type DesignSkill = z.infer<typeof designSkillSchema>;
export type DesignSkillRef = z.infer<typeof designSkillRefSchema>;

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
    designSkill: designSkillRefSchema.optional(),
    clarifications,
  }),
  z.strictObject({
    mode: z.literal('create'),
    reviewBeforeRevision: z.literal(true).optional(),
    clarifications,
    request: z.string().trim().min(1).max(1000),
  }),
]);

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const inputFrom = z.array(id).max(4);
const insertion = { after: id, id, title: z.string().trim().min(1).max(100) };
const taskInsertion = z.strictObject({
  ...insertion,
  instructions: z.string().trim().min(1).max(8000),
  inputFrom,
});
const edits = z.strictObject({
  clarification: z.string().max(1000),
  additions: z
    .array(
      z.union([
        taskInsertion,
        z.strictObject({ ...insertion, kind: z.literal('review') }),
      ]),
    )
    .max(31),
  inputs: z.array(z.strictObject({ stepId: id, inputFrom })).max(32),
  instructions: z
    .array(
      z.strictObject({ stepId: id, text: z.string().trim().min(1).max(8000) }),
    )
    .max(32),
  goal: z.string().trim().min(1).max(1000).nullable(),
  doneWhen: z.string().trim().min(1).max(2000).nullable(),
});
const skillEdits = edits.extend({ skillStepId: id.nullable() });
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
  reviewBeforeRevision = false,
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
  if (reviewBeforeRevision) {
    const [draft, gate, revision] = plan.steps;
    if (
      plan.steps.length !== 3 ||
      draft?.kind !== 'task' ||
      draft.inputFrom.length ||
      gate?.kind !== 'review' ||
      revision?.kind !== 'task' ||
      revision.inputFrom.length !== 1 ||
      revision.inputFrom[0] !== draft.id
    )
      throw new Error('invalid review sequence');
  }
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
  hasSelectedSkill = false,
) {
  return z.toJSONSchema(
    mode === 'edit'
      ? hasSelectedSkill
        ? skillEdits
        : edits
      : clarified
        ? clarifiedFlow
        : newFlow,
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
  selectedSkill?: TaskSkill,
): z.infer<typeof proposalResponseSchema> {
  const parsed = (selectedSkill ? skillEdits : edits)
    .extend({
      instructions: edits.shape.instructions.default([]),
      goal: edits.shape.goal.default(null),
      doneWhen: edits.shape.doneWhen.default(null),
    })
    .parse(raw);
  const { clarification, additions, inputs, instructions, goal, doneWhen } =
    parsed;
  const target =
    'skillStepId' in parsed && typeof parsed.skillStepId === 'string'
      ? parsed.skillStepId
      : null;
  const hasChanges =
    target ||
    additions.length ||
    inputs.length ||
    instructions.length ||
    goal ||
    doneWhen;
  if (clarification.trim()) {
    if (hasChanges) throw new Error('ambiguous proposal');
    return { kind: 'question', text: clarification.trim() };
  }
  if (!hasChanges) throw new Error('empty proposal');
  let steps = orderedSteps(base).map((step) => ({ ...step }));
  const updated = new Set<string>();
  for (const { stepId, text } of instructions) {
    const step = steps.find((item) => item.id === stepId);
    if (step?.kind !== 'task' || updated.has(stepId))
      throw new Error('invalid instruction target');
    updated.add(stepId);
    step.instructions = text;
  }
  for (const add of additions) {
    const index = steps.findIndex((step) => step.id === add.after);
    const anchor = steps[index];
    if (!anchor || steps.some((step) => step.id === add.id))
      throw new Error('invalid insertion');
    const fields = { id: add.id, title: add.title, position: anchor.position };
    steps = insertWorkflowStep(
      steps,
      index,
      'kind' in add
        ? { ...fields, kind: 'review' }
        : {
            ...fields,
            kind: 'task',
            agent: 'codex',
            instructions: add.instructions,
            inputFrom: add.inputFrom,
          },
    );
  }
  if (target && selectedSkill) {
    const task = steps.find((s) => s.id === target);
    if (task?.kind !== 'task') throw new Error('invalid skill target');
    const { id, digest, title } = selectedSkill;
    task.codexSkill = { id, digest, title };
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
  const definition = {
    ...base,
    ...(goal && { goal }),
    ...(doneWhen && { doneWhen }),
    steps,
    links,
  };
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
