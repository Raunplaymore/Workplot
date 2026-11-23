import { z } from 'zod';
export const MAX_ADDITIONAL_SESSIONS = 100;
export const completionGoalSchema = z.strictObject({
  goal: z.string().trim().min(1).max(500),
  criteria: z
    .array(z.string().trim().min(1).max(180))
    .min(1)
    .max(6)
    .refine(
      (values) => new Set(values).size === values.length,
      '기준을 서로 다르게 입력하세요.',
    ),
  target: z.number().int().min(1).max(100),
});
export const delegationConfigSchema = completionGoalSchema.extend({
  handoffOnly: z.literal(true).optional(),
  maxSessions: z.number().int().min(1).max(MAX_ADDITIONAL_SESSIONS).nullable(),
  until: z.iso.datetime(),
});
export const assessmentSchema = z
  .array(
    z.strictObject({
      criterion: z.string(),
      status: z.enum(['met', 'unmet', 'unknown']),
      quote: z.string().max(500),
      assessedRunId: z.uuid().optional(),
    }),
  )
  .max(6);
export const delegationStatusSchema = z.strictObject({
  enabled: z.boolean(),
  used: z.number(),
  note: z.string(),
  score: z.number().nullable(),
  checks: assessmentSchema,
  evidenceFiles: z.record(z.string(), z.string()).optional(),
  config: delegationConfigSchema.nullable(),
});
export type CompletionGoal = z.infer<typeof completionGoalSchema>;
export type DelegationConfig = z.infer<typeof delegationConfigSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;
