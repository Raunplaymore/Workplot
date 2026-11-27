import { z } from 'zod';
import {
  versionSchema,
  workflowIdSchema,
  type WorkflowDefinition,
} from './workflows.js';

export const linkCandidateSchema = z.object({
  id: workflowIdSchema,
  version: versionSchema,
  name: z.string(),
  reason: z.string().nullable(),
});
export const linkUsageSchema = z.object({
  id: workflowIdSchema,
  version: versionSchema,
  name: z.string(),
  step: z.string(),
  pinned: versionSchema,
  location: z.enum(['active', 'archived', 'trash']),
});
export type LinkCandidate = z.infer<typeof linkCandidateSchema>;
export type LinkUsage = z.infer<typeof linkUsageSchema>;
type Task = Extract<WorkflowDefinition['steps'][number], { kind: 'task' }>;

export function linkWorkflowStep(
  step: Task,
  target: Pick<LinkCandidate, 'id' | 'version' | 'name'>,
): Task {
  return {
    ...step,
    workflowRef: { id: target.id, version: target.version },
    improvementRoutes: undefined,
    title: target.name,
    instructions: '연결한 워크플롯의 마지막 작업 문서를 반환합니다.',
    agent: 'codex',
    codexSkill: undefined,
    tool: undefined,
    skill: undefined,
  };
}
