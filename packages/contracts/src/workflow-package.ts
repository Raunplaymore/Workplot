import { z } from 'zod';
import {
  workflowDefinitionSchema,
  workflowIdSchema,
  versionSchema,
} from './workflows.js';

const ref = z.strictObject({ id: workflowIdSchema, version: versionSchema });
export const workflowPackageSchema = z.strictObject({
  format: z.literal('workplot/1'),
  root: ref,
  workflows: z
    .array(ref.extend({ definition: workflowDefinitionSchema }))
    .min(1)
    .max(33),
});
export type WorkflowPackage = z.infer<typeof workflowPackageSchema>;
