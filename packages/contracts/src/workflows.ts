import { z } from 'zod';

export const workflowIdSchema = z.uuid();
export const versionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const stepId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const codexSkillRefSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const taskSkillSchema = codexSkillRefSchema.extend({
  title: z.string().min(1).max(256),
});
export type TaskSkill = z.infer<typeof taskSkillSchema>;
const documentLabel = z.string().trim().min(1).max(100);
export const nodeDocumentsSchema = z.strictObject({
  needs: z.array(documentLabel).max(4),
  output: documentLabel,
});
const stepFields = {
  id: stepId,
  templateOrigin: z
    .strictObject({ id: z.uuid(), version: versionSchema })
    .optional(),
  title: z.string().trim().min(1).max(100),
  position: z.strictObject({ x: z.number(), y: z.number() }),
};

const classificationFields = {
  project: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
};

export const workflowDefinitionSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    input: z.string().max(8_000).optional(),
    ...classificationFields,
    projectFolder: z
      .strictObject({
        serviceId: z.uuid(),
        checkoutId: z.string().regex(/^[a-f0-9]{64}$/),
        folderKey: z.string().regex(/^[a-f0-9]{64}$/),
        service: z.string().min(1).max(100),
        folder: z.string().min(1).max(4096),
        branch: z.string().min(1).max(1024),
      })
      .optional(),
    inputFields: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    goal: z.string().trim().max(1_000).optional(),
    doneWhen: z.string().trim().max(2_000).optional(),
    steps: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            ...stepFields,
            kind: z.literal('task'),
            workflowRef: z
              .strictObject({ id: workflowIdSchema, version: versionSchema })
              .optional(),
            improvementRoutes: z
              .strictObject({
                screen: z.string().trim().min(1).max(2000),
                feature: z.string().trim().min(1).max(2000),
              })
              .optional(),
            templateDocuments: nodeDocumentsSchema.optional(),
            instructions: z
              .string()
              .max(8_000)
              .refine((text) => text.trim().length > 0),
            inputFrom: z.array(stepId).max(4).optional(),
            workspaceAccess: z.enum(['read-only', 'write']).optional(),
            agent: z.enum(['codex', 'unassigned']).optional(),
            codexSkill: taskSkillSchema.optional(),
            tool: z
              .enum(['market-calendar', 'workplot-ui', 'verified-commit'])
              .optional(),
            skill: z.enum(['none', 'source-check']).optional(),
          }),
          z.strictObject({
            ...stepFields,
            kind: z.literal('review'),
            startNextSession: z.literal(true).optional(),
          }),
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
    const chain = [...visited];
    for (const [i, id] of chain.entries()) {
      const step = byId.get(id)!.step;
      if (
        step.kind === 'review' &&
        step.startNextSession &&
        (i !== chain.length - 1 ||
          byId.get(chain[i - 1] ?? '')?.step.kind !== 'task')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps'],
          message:
            '다음 세션 승인은 인계 문서를 작성하는 작업 바로 뒤, 흐름 끝에 놓으세요.',
        });
      }
    }
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
// Editing permits unfinished fields and disconnected wires until the user saves.
const [taskStep, reviewStep] =
  workflowDefinitionSchema.shape.steps.element.options;
const editorText = z.string().max(100);
const editorDefinition = z.strictObject({
  ...workflowDefinitionSchema.shape,
  name: editorText,
  steps: z
    .array(
      z.discriminatedUnion('kind', [
        taskStep.extend({
          title: editorText,
          instructions: z.string().max(8000),
        }),
        reviewStep.extend({ title: editorText }),
      ]),
    )
    .min(1)
    .max(32),
});
export const editorRecoverySchema = z.strictObject({
  draft: editorDefinition,
  baseline: editorDefinition,
  saved: workflowVersionSchema.nullable(),
  selected: z.string(),
  flowSettings: z.boolean(),
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

export const libraryLocationSchema = z.enum(['active', 'archived', 'trash']);
export const libraryMoveSchema = z.strictObject({
  from: libraryLocationSchema,
  action: z.enum(['archive', 'trash', 'restore']),
});
export const librarySchema = z.array(
  z.object({
    id: workflowIdSchema,
    version: versionSchema,
    name: z.string(),
    goal: z.string(),
    ...classificationFields,
    savedAt: z.iso.datetime(),
    favorite: z.boolean(),
    location: libraryLocationSchema.default('active'),
  }),
);
export const matchRequestSchema = z.strictObject({
  goal: z.string().trim().min(1).max(1000),
});
export const matchResultSchema = z.strictObject({
  match: z
    .strictObject({
      id: workflowIdSchema,
      version: versionSchema,
      name: z.string(),
      reason: z.string().trim().min(1).max(500),
    })
    .nullable(),
});
export type WorkflowMatch = NonNullable<
  z.infer<typeof matchResultSchema>['match']
>;
const skillRegistration = z.strictObject({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  version: versionSchema,
});
export const skillRegistrationListSchema = z.array(skillRegistration);
export const skillRegistrationRequestSchema = skillRegistration.extend({
  expectedVersion: versionSchema.nullable(),
});
export const favoriteSchema = z.strictObject({ favorite: z.boolean() });
const runMaterialSchema = z.strictObject({
  name: z.string().trim().max(100),
  source: z.string().trim().min(1).max(8000),
});
export type RunMaterial = z.infer<typeof runMaterialSchema>;

export const rerunSchema = z.strictObject({
  stepId,
  instructions: z.string().trim().min(1).max(8_000),
});
const reviewReceiptSchema = z.strictObject({
  gateId: z.uuid(),
  stepId,
  decision: z.enum(['accept', 'decline', 'finish']),
  savedWorkflowVersion: versionSchema.optional(),
  at: z.iso.datetime(),
});
export type ReviewReceipt = z.infer<typeof reviewReceiptSchema>;
export const gitTargetSchema = z.strictObject({
  serviceId: z.uuid(),
  service: z.string().trim().min(1).max(100),
  path: z.string(),
  root: z.string(),
  repository: z.string(),
  repositoryId: z.string(),
  checkoutId: z.string(),
  subpath: z.string(),
  branch: z.string(),
  sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  dirty: z.boolean(),
});
export type GitTarget = z.infer<typeof gitTargetSchema>;
export const requestFilesSchema = z.strictObject({
  handoff: z
    .strictObject({
      runId: z.uuid(),
      file: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\.md$/),
    })
    .optional(),
  gitTarget: gitTargetSchema.optional(),
  references: z.array(z.string().trim().min(1).max(4096)).max(32),
  workspace: z.string().trim().min(1).max(4096).optional(),
});
export type RequestFiles = z.infer<typeof requestFilesSchema>;
export const effortLevels = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export const modelSettingsSchema = z.strictObject({
  model: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/)
    .optional(),
  effort: z.enum(effortLevels).optional(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
const taskRequestSchema = z.string().trim().min(1).max(2000).optional();
export const runSummarySchema = z.strictObject({
  isolatedGit: z.literal(true).optional(),
  developmentTaskId: z.uuid().optional(),
  requestFiles: requestFilesSchema.optional(),
  snapshotId: z.uuid().optional(),
  modelSettings: modelSettingsSchema.optional(),
  taskRequest: taskRequestSchema,
  id: z.uuid(),
  workflowId: workflowIdSchema,
  workflowVersion: versionSchema,
  recordedAt: z.iso.datetime(),
  lastReview: reviewReceiptSchema.optional(),
  master: z
    .strictObject({ runId: z.uuid(), planId: z.uuid(), taskId: stepId })
    .optional(),
  previousSessionId: z.uuid().optional(),
  sessionGit: z
    .strictObject({
      sourceRun: z.uuid(),
      head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      base: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    })
    .optional(),
  nextSessionId: z.uuid().optional(),
  origin: z.strictObject({ runId: z.uuid(), stepId }).optional(),
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

export const MAX_DEVELOPMENT_SLOTS = 32;
export const slotSettingsSchema = z.object({
  limit: z.number().int().min(1).max(MAX_DEVELOPMENT_SLOTS),
  recommended: z.number().int().positive(),
  cores: z.number().int().positive(),
  availableGiB: z.number().nonnegative(),
});

export const runListSchema = z.array(
  runSummarySchema
    .pick({
      id: true,
      workflowVersion: true,
      workflowId: true,
      recordedAt: true,
      status: true,
    })
    .extend({
      name: z.string(),
      quotaRetryAt: z.number().int().positive().nullish(),
      gateKind: z.enum(['review', 'question']).optional(),
      occupiesSlot: z.boolean().optional(),
      isolatedTask: z.uuid().nullish(),
      handoffRunId: z.uuid().nullish(),
      masterRunId: z.uuid().nullish(),
      previousSessionId: z.uuid().nullable().optional(),
      sessionSummary: z.string().optional(),
      comparable: z.union([z.literal(0), z.literal(1)]).optional(),
    }),
);
export type RunList = z.infer<typeof runListSchema>;

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;

const artifactName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\.md$/);
export const resultPromptOriginSchema = z.strictObject({
  runId: z.uuid(),
  workflowId: workflowIdSchema.optional(),
  version: versionSchema,
  stepId,
  instructions: z.string(),
});
export type ResultPromptOrigin = z.infer<typeof resultPromptOriginSchema>;
export const runInputSchema = runSummarySchema
  .omit({
    id: true,
    recordedAt: true,
    lastReview: true,
    provider: true,
  })
  .extend({
    material: runMaterialSchema.optional(),
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
  failureNote: z.string().max(400).optional(),
  workspaceBlocked: z.literal(true).optional(),
  timedOut: z.literal(true).optional(),
  quotaRetryAt: z.number().int().positive().optional(),
  answerContext: z.string().optional(),
  questionCount: z.number().int().min(0).max(2).optional(),
  stepId,
  documentHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(32),
});
export type RetryCheckpoint = z.infer<typeof retryCheckpointSchema>;

const pausedReviewSchema = z.strictObject({
  gateId: z.uuid(),
  stepId,
  documentHashes: retryCheckpointSchema.shape.documentHashes,
});
export type PausedReview = z.infer<typeof pausedReviewSchema>;
export const storedRunSchema = z.strictObject({
  summary: runSummarySchema,
  material: runMaterialSchema.optional(),
  retry: retryCheckpointSchema.optional(),
  pausedReview: pausedReviewSchema.optional(),
  completedHashes: retryCheckpointSchema.shape.documentHashes.optional(),
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
  requestFiles: requestFilesSchema.optional(),
  modelSettings: modelSettingsSchema.optional(),
  taskRequest: taskRequestSchema,
  material: runMaterialSchema.optional(),
  id: z.uuid(),
  workflowId: workflowIdSchema,
  workflowVersion: versionSchema,
});
export const runDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    gateId: z.uuid(),
    decision: z.enum(['decline', 'finish']),
  }),
  z.strictObject({
    gateId: z.uuid(),
    decision: z.literal('accept'),
    edit: z
      .strictObject({
        file: artifactName,
        expected: z.string().regex(/^[0-9a-f]{64}$/),
        rule: z.string().trim().min(1).max(2000).optional(),
        text: z
          .string()
          .max(128000)
          .refine((s) => !!s.trim()),
      })
      .optional(),
  }),
  z.strictObject({
    gateId: z.uuid(),
    decision: z.literal('answer'),
    answer: z.string().trim().min(1).max(4_000),
  }),
]);
export type RunDecision = z.infer<typeof runDecisionSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export const portCheckSchema = z.strictObject({
  token: z.string(),
  status: z.enum(['failed', 'checking', 'passed']),
  reason: z.string(),
});
export const timeoutReportSchema = z.array(
  z.object({
    step: stepId,
    attempts: z.array(
      z.object({
        begin: z.number(),
        end: z.number(),
        elapsedMs: z.number(),
        parallel: z.number().nullable(),
        lastCheck: z.string().nullable(),
        retryMs: z.number().nullable(),
        recoveredMs: z.number().nullable(),
        repeatedChecks: z.number().nullable(),
      }),
    ),
    peers: z.array(z.object({ run: z.uuid(), overlap: z.boolean() })),
  }),
);
export const runViewSchema = z.strictObject({
  hasTimeoutHistory: z.boolean().optional(),
  recovery: z
    .strictObject({ source: z.uuid(), repair: z.string(), state: z.string() })
    .optional(),
  modelCalls: z
    .array(
      z.object({ step: z.string(), model: z.string(), effort: z.string() }),
    )
    .optional(),
  portCheck: portCheckSchema.optional(),
  editedFiles: z.array(artifactName).optional(),
  worktree: z
    .object({
      directory: z.string(),
      path: z.string(),
      branch: z.string(),
      head: z.string(),
      base: z.string(),
    })
    .optional(),
  aiCalls: z
    .array(
      z.object({
        step: z.string(),
        pid: z.number(),
        session: z.string().nullable(),
        observedAt: z.string(),
      }),
    )
    .optional(),
  retention: z
    .strictObject({
      expiresAt: z.iso.datetime().nullable(),
      kept: z.array(artifactName),
      expired: z.boolean(),
      summary: z.string().nullable(),
    })
    .optional(),
  failureId: z.uuid().optional(),
  workspaceBlocked: z.literal(true).optional(),
  timedOut: z.literal(true).optional(),
  quotaRetryAt: z.number().int().positive().optional(),
  summary: runSummarySchema,
  stepId: stepId.nullable(),
  note: z.string().nullable(),
  gate: z
    .strictObject({
      id: z.uuid(),
      kind: z.enum(['review', 'question']),
      startNextSession: z.literal(true).optional(),
      repeatsSession: z.uuid().optional(),
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
    reviewCompleted: z.literal(true).optional(),
    reviewDeclined: z.literal(true).optional(),
    failureReason: z.string().trim().min(1).max(300).optional(),
    stepId: stepId.nullable(),
    gate: z.enum(['question', 'review']).nullable(),
  }),
);

export const sessionRequestInput = z.strictObject({
  id: z.uuid(),
  text: z.string().trim().min(1).max(2000),
});
export const sessionRequestView = z.strictObject({
  runId: z.uuid(),
  round: z.number().int().positive(),
  incoming: z.array(z.string()),
  outgoing: z.array(z.string()),
});

export function writableStep(
  step: WorkflowDefinition['steps'][number],
  steps: WorkflowDefinition['steps'],
) {
  return (
    step.kind === 'task' &&
    !step.improvementRoutes &&
    step.tool !== 'market-calendar' &&
    step.tool !== 'verified-commit' &&
    (step.workspaceAccess
      ? step.workspaceAccess === 'write'
      : step.tool === 'workplot-ui' ||
        steps.filter((s) => s.kind === 'task').length === 1)
  );
}

export const workspaceBlockedNote =
  '개발 차단 · 작업 폴더에 필요한 변경을 쓸 수 없습니다. 노드 권한과 연결한 폴더를 확인하세요.';
