import { z } from 'zod';

export const workflowIdSchema = z.uuid();
export const versionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const stepId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const stepFields = {
  id: stepId,
  title: z.string().trim().min(1).max(100),
  position: z.strictObject({ x: z.number(), y: z.number() }),
};

export const workflowDefinitionSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    input: z.string().max(8_000).optional(),
    goal: z.string().trim().max(1_000).optional(),
    doneWhen: z.string().trim().max(2_000).optional(),
    steps: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            ...stepFields,
            kind: z.literal('task'),
            instructions: z.string().trim().min(1).max(8_000),
            inputFrom: z.array(stepId).max(4).optional(),
            agent: z.enum(['codex', 'unassigned']).optional(),
            skill: z.enum(['none', 'source-check']).optional(),
          }),
          z.strictObject({ ...stepFields, kind: z.literal('review') }),
        ]),
      )
      .min(1)
      .max(32),
    links: z.array(z.strictObject({ from: stepId, to: stepId })).max(31),
  })
  .superRefine(({ steps, links }, ctx) => {
    const ids = new Set(steps.map((step) => step.id));
    const next = new Map<string, string>();
    const incoming = new Set<string>();
    if (ids.size !== steps.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: '단계 ID는 고유해야 합니다.',
      });
    }
    for (const { from, to } of links) {
      if (
        !ids.has(from) ||
        !ids.has(to) ||
        next.has(from) ||
        incoming.has(to)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['links'],
          message: '연결은 존재하는 단계를 직렬로 이어야 합니다.',
        });
        return;
      }
      next.set(from, to);
      incoming.add(to);
    }
    const starts = [...ids].filter((id) => !incoming.has(id));
    const visited = new Set<string>();
    let current: string | undefined = starts[0];
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      current = next.get(current);
    }
    if (
      starts.length !== 1 ||
      current !== undefined ||
      visited.size !== ids.size
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['links'],
        message: '모든 단계는 순환 없이 하나의 흐름으로 이어져야 합니다.',
      });
      return;
    }
    const byId = new Map(
      steps.map((step, index) => [step.id, { step, index }]),
    );
    const earlierTasks = new Set<string>();
    for (const id of visited) {
      const entry = byId.get(id);
      if (entry?.step.kind !== 'task') continue;
      const sources = entry.step.inputFrom ?? [];
      if (
        new Set(sources).size !== sources.length ||
        sources.some((source) => !earlierTasks.has(source))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', entry.index, 'inputFrom'],
          message: '각 단계는 앞선 작업의 결과만 중복 없이 받을 수 있습니다.',
        });
      }
      earlierTasks.add(id);
    }
  });

export const workflowVersionSchema = z.strictObject({
  id: workflowIdSchema,
  version: versionSchema,
  savedAt: z.iso.datetime(),
  definition: workflowDefinitionSchema,
});
export const workflowUpdateSchema = z.strictObject({
  baseVersion: versionSchema,
  definition: workflowDefinitionSchema,
});
export const workflowListSchema = z.array(
  workflowVersionSchema
    .pick({
      id: true,
      version: true,
      savedAt: true,
    })
    .extend({ name: z.string() }),
);

export const runSummarySchema = z.strictObject({
  id: z.uuid(),
  workflowId: workflowIdSchema,
  workflowVersion: versionSchema,
  recordedAt: z.iso.datetime(),
  status: z.enum([
    'queued',
    'running',
    'waiting',
    'completed',
    'failed',
    'stopped',
    'unknown',
  ]),
  provider: z.literal('codex'),
  cliVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i)
    .max(64),
});

export const runListSchema = z.array(
  runSummarySchema
    .pick({
      id: true,
      workflowVersion: true,
      recordedAt: true,
      status: true,
    })
    .extend({ name: z.string() }),
);
export type RunList = z.infer<typeof runListSchema>;

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;

const artifactName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\.md$/);
export const runInputSchema = runSummarySchema
  .omit({
    id: true,
    recordedAt: true,
    provider: true,
  })
  .extend({
    sessionId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .nullable(),
    process: z
      .strictObject({
        ownerId: z.uuid(),
        pid: z.number().int().positive().max(2_147_483_647),
      })
      .nullable(),
    results: z.array(artifactName).max(32),
  });
export type RunInput = z.infer<typeof runInputSchema>;

export const runRetrySchema = z.strictObject({ failureId: z.uuid() });
const retryCheckpointSchema = runRetrySchema.extend({
  stepId,
  documentHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(32),
});
export type RetryCheckpoint = z.infer<typeof retryCheckpointSchema>;

export const storedRunSchema = z.strictObject({
  summary: runSummarySchema,
  retry: retryCheckpointSchema.optional(),
  sessionId: runInputSchema.shape.sessionId,
  process: runInputSchema.shape.process,
  results: runInputSchema.shape.results,
});

export function orderedSteps(definition: WorkflowDefinition) {
  const targets = new Set(definition.links.map(({ to }) => to));
  const links = new Map(definition.links.map(({ from, to }) => [from, to]));
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  const order: WorkflowDefinition['steps'] = [];
  let id = definition.steps.find((step) => !targets.has(step.id))?.id;
  while (id && order.length < steps.size) {
    const step = steps.get(id);
    if (!step) break;
    order.push(step);
    id = links.get(id);
  }
  return order;
}

export function workflowPlan(definition: WorkflowDefinition) {
  let previousTask: string | undefined;
  return {
    name: definition.name,
    goal: definition.goal ?? '',
    doneWhen: definition.doneWhen ?? '',
    steps: orderedSteps(definition).map((step) => {
      const inputs =
        (step.kind === 'task' ? step.inputFrom : undefined) ??
        (previousTask ? [previousTask] : []);
      if (step.kind === 'task') previousTask = step.id;
      return {
        id: step.id,
        title: step.title,
        kind: step.kind,
        inputs,
        output: step.kind === 'task' ? step.id + '.md' : null,
      };
    }),
  };
}

export const runStartSchema = z.strictObject({
  id: z.uuid(),
  workflowId: workflowIdSchema,
  workflowVersion: versionSchema,
});
export const runDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ gateId: z.uuid(), decision: z.enum(['accept', 'decline']) }),
  z.strictObject({
    gateId: z.uuid(),
    decision: z.literal('answer'),
    answer: z.string().trim().min(1).max(4_000),
  }),
]);
export type RunDecision = z.infer<typeof runDecisionSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export const runViewSchema = z.strictObject({
  failureId: z.uuid().optional(),
  summary: runSummarySchema,
  stepId: stepId.nullable(),
  note: z.string().nullable(),
  gate: z
    .strictObject({
      id: z.uuid(),
      kind: z.enum(['review', 'question']),
      text: z.string(),
    })
    .nullable(),
  results: z.array(artifactName),
});
export type RunView = z.infer<typeof runViewSchema>;

export const runEventsSchema = z.array(
  z.object({
    status: runSummarySchema.shape.status,
    at: z.iso.datetime(),
    stepId: stepId.nullable(),
    gate: z.enum(['question', 'review']).nullable(),
  }),
);
