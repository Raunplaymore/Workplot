import { z } from 'zod';

export const healthSchema = z.object({
  status: z.literal('ok'),
  database: z.literal('ready'),
  agent: z.literal('not_connected'),
});

export type Health = z.infer<typeof healthSchema>;

export const toolsSchema = z.array(
  z.object({
    id: z.enum(['claude', 'codex']),
    status: z.enum(['detected', 'not_found', 'check_failed']),
    version: z.string().nullable(),
    authentication: z.literal('unchecked'),
  }),
);
export type ToolStatus = z.infer<typeof toolsSchema>[number];

export * from './workflows.js';
export * from './workflow-layout.js';

export * from './proposals.js';
export * from './comparisons.js';

export * from './material.js';
export * from './schedules.js';
export * from './delegation.js';
export * from './node-shelf.js';

export * from './evidence-markdown.js';
export * from './master-plan.js';
