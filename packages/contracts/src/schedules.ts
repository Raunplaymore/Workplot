import { z } from 'zod';
import { versionSchema } from './workflows.js';

export const scheduleConfigSchema = z.strictObject({
  version: versionSchema,
  enabled: z.boolean(),
  weekday: z.number().int().min(0).max(6).nullable(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  material: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('text'),
      value: z.string().trim().min(1).max(8000),
    }),
    z.strictObject({
      kind: z.literal('file'),
      value: z
        .string()
        .trim()
        .max(200)
        .regex(/^[^./\\\p{Cc}][^/\\\p{Cc}]*\.(?:md|txt)$/iu),
    }),
  ]),
});
export const scheduleSaveSchema = z.strictObject({
  expected: z.uuid().nullable(),
  config: scheduleConfigSchema,
});
export const schedulePanelSchema = z.object({
  folder: z.string(),
  schedule: z
    .object({
      revision: z.uuid(),
      config: scheduleConfigSchema,
      nextAt: z.number().nullable(),
      lastAt: z.number().nullable(),
      note: z.string().nullable(),
      runId: z.uuid().nullable(),
    })
    .nullable(),
});
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
export type SchedulePanel = z.infer<typeof schedulePanelSchema>;
