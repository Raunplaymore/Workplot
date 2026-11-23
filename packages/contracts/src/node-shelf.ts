import { z } from 'zod';
import {
  nodeDocumentsSchema,
  orderedSteps,
  taskSkillSchema,
  workflowDefinitionSchema,
  workflowPlan,
  type WorkflowDefinition,
} from './workflows.js';
import { insertWorkflowStep } from './workflow-layout.js';

const title = z.string().trim().min(1).max(100);
export const nodeTemplateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('review'), title }),
  z.strictObject({
    kind: z.literal('task'),
    title,
    instructions: z.string().trim().min(1).max(8000),
    ...nodeDocumentsSchema.shape,
    agent: z.enum(['codex', 'unassigned']).optional(),
    tool: z
      .enum(['market-calendar', 'workplot-ui', 'verified-commit'])
      .optional(),
    skill: z.enum(['source-check', 'none']).optional(),
    codexSkill: taskSkillSchema.optional(),
  }),
]);
export type NodeTemplate = z.infer<typeof nodeTemplateSchema>;
export const shelfEntrySchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  favorite: z.boolean(),
  template: nodeTemplateSchema,
});
export type ShelfEntry = z.infer<typeof shelfEntrySchema>;
export const fitSchema = z.strictObject({
  instructions: z.string().trim().min(1).max(8000),
  sources: z.array(z.string().nullable()).max(4),
  reason: z.string().trim().min(1).max(1500),
});
export type NodeFit = z.infer<typeof fitSchema>;
export function templateFromStep(
  flow: WorkflowDefinition,
  id: string,
): NodeTemplate {
  const s = flow.steps.find((n) => n.id === id);
  if (!s) throw new Error('단계를 찾을 수 없습니다.');
  if (s.kind === 'review') return { kind: s.kind, title: s.title };
  const inputs =
    workflowPlan(flow).steps.find((n) => n.id === id)?.inputs ?? [];
  return {
    kind: s.kind,
    title: s.title,
    instructions: s.instructions,
    agent: s.agent,
    tool: s.tool,
    skill: s.skill,
    codexSkill: s.codexSkill,
    ...(s.templateDocuments ?? {
      needs: inputs.map((key) => flow.steps.find((n) => n.id === key)!.title),
      output: s.title + ' 결과',
    }),
  };
}
export function fitContext(flow: WorkflowDefinition, after: string) {
  const plan = workflowPlan(flow);
  const i = plan.steps.findIndex((n) => n.id === after);
  if (
    i < 0 ||
    plan.steps.length !== flow.steps.length ||
    plan.steps.length >= 32
  )
    throw new Error('삽입할 위치와 단계 수를 확인하세요.');
  const sources = plan.steps
    .slice(0, i + 1)
    .filter((n) => n.kind === 'task')
    .map(({ id, title }) => ({ id, title }));
  return {
    name: flow.name,
    goal: flow.goal,
    doneWhen: flow.doneWhen,
    fields: flow.inputFields ?? [],
    after,
    steps: plan.steps,
    sources,
  };
}
export function insertFittedNode(
  flow: WorkflowDefinition,
  after: string,
  template: NodeTemplate,
  fit: NodeFit | null,
  id: string,
  pass: boolean,
  origin?: { id: string; version: number },
) {
  const ctx = fitContext(flow, after);
  const ordered = orderedSteps(flow);
  const index = ordered.findIndex((n) => n.id === after);
  const base = {
    id,
    title: template.title,
    position: ordered[index]!.position,
    templateOrigin: origin,
  };
  const refs = fit?.sources ?? [];
  if (
    template.kind === 'task' &&
    (!fit ||
      refs.length !== template.needs.length ||
      refs.some(
        (ref) => ref !== '@source' && !ctx.sources.some((s) => s.id === ref),
      ))
  )
    throw new Error('필요한 자료를 모두 연결하세요.');
  const entry =
    template.kind === 'review'
      ? { ...base, kind: template.kind }
      : {
          ...base,
          kind: template.kind,
          agent: template.agent,
          tool: template.tool,
          skill: template.skill,
          codexSkill: template.codexSkill,
          instructions: fit!.instructions,
          templateDocuments: { needs: template.needs, output: template.output },
          inputFrom: [
            ...new Set(
              refs.filter(
                (ref): ref is string => ref !== null && ref !== '@source',
              ),
            ),
          ],
        };
  const next = insertWorkflowStep(ordered, index, entry);
  // Keep the next writer's existing inputs, including its formerly implicit input.
  const dest = next.slice(index + 2).find((n) => n.kind === 'task');
  if (dest && template.kind === 'task') {
    const old = ctx.steps.find((n) => n.id === dest.id)!.inputs;
    next[next.indexOf(dest)] = {
      ...dest,
      inputFrom: pass ? [...old, id] : old,
    };
  }
  return workflowDefinitionSchema.parse({
    ...flow,
    steps: next,
    links: next.slice(1).map((n, i) => ({ from: next[i]!.id, to: n.id })),
  });
}
