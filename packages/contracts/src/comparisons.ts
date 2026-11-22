import { z } from 'zod';

export const facts = ['address', 'hours'] as const;
export const factLabels = { address: '주소', hours: '영업시간' };
const observation = z.strictObject({
  quote: z.string(),
  verdict: z.enum(['match', 'mismatch', 'omitted', 'uncertain']),
});
const field = z.strictObject({
  status: z.enum(['known', 'missing', 'conflict', 'uncertain']),
  evidence: z.array(z.string()),
  original: observation,
  revision: observation,
});
export const factReportSchema = z.strictObject({
  address: field,
  hours: field,
});
export type FactReport = z.infer<typeof factReportSchema>;
export const factOutputSchema = z.toJSONSchema(factReportSchema, {
  target: 'draft-7',
});

const document = z.strictObject({
  runId: z.uuid(),
  version: z.number().int(),
  filename: z.string(),
  text: z.string(),
  cliVersion: z.string(),
});
const part = z.strictObject({
  label: z.string(),
  before: z.string(),
  after: z.string(),
});
export type ComparisonPart = z.infer<typeof part>;
export const selectChangesSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().nonnegative(),
  selected: z.array(z.number().int().nonnegative()).max(64000),
});
export type Selection = z.infer<typeof selectChangesSchema>;
export const comparisonSchema = z.strictObject({
  source: z.string(),
  original: document,
  revision: document,
  fingerprint: selectChangesSchema.shape.fingerprint,
  review: z
    .strictObject({
      criteria: z.string(),
      facts: factReportSchema,
      cliVersion: z.string(),
      parts: z.array(part),
    })
    .nullable(),
  version: z.number().int(),
  selected: selectChangesSchema.shape.selected,
  applied: z.string().nullable(),
});
export type Comparison = z.infer<typeof comparisonSchema>;
export function applyParts(parts: ComparisonPart[], selected: number[]) {
  const include = new Set(selected);
  return parts.map((p, i) => (include.has(i) ? p.after : p.before)).join('');
}
