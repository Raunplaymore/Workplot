import { z } from 'zod';
import {
  nodeDocumentsSchema,
  versionSchema,
  workflowIdSchema,
} from './workflows.js';

const taskId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const masterPlanSchema = z
  .strictObject({
    goal: z.string().trim().min(1).max(4000),
    tasks: z
      .array(
        z.strictObject({
          id: taskId,
          workflow: z.strictObject({
            id: workflowIdSchema,
            version: versionSchema,
          }),
          dependsOn: z.array(taskId).max(31),
          documents: nodeDocumentsSchema,
          doneWhen: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(32),
  })
  .superRefine(({ tasks }, ctx) => {
    const known = new Set(tasks.map((task) => task.id));
    if (known.size !== tasks.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: '과제 ID가 중복됩니다.',
      });
      return;
    }
    for (const [i, task] of tasks.entries()) {
      if (
        task.dependsOn.some((id) => !known.has(id)) ||
        new Set(task.dependsOn).size !== task.dependsOn.length
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', i, 'dependsOn'],
          message: '선행 과제의 ID와 중복 여부를 확인하세요.',
        });
        return;
      }
    }
    const done = new Set<string>();
    while (done.size < tasks.length) {
      const ready = tasks.filter(
        (t) => !done.has(t.id) && t.dependsOn.every((id) => done.has(id)),
      );
      if (!ready.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks'],
          message: '순환하는 선행 과제가 있습니다.',
        });
        return;
      }
      ready.forEach((t) => done.add(t.id));
    }
  });

export type MasterPlan = z.infer<typeof masterPlanSchema>;
