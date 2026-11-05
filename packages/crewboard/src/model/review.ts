import { z } from 'zod'

export const reviewSchema = z.object({
  verdict: z.enum(['approve', 'changes']),
  findings: z.array(z.object({ severity: z.string().min(1), file: z.string().min(1), line: z.number().int().positive(), problem: z.string().min(1), scenario: z.string().min(1) })),
})

export function parseReview(text: string) {
  try {
    const parsed = reviewSchema.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}

/**
 * The result schema a review assignment gets unless the lead passes its own: Codex and Claude enforce it natively
 * (--output-schema / --json-schema), other agents get it in the prompt. Kept to the subset strict structured outputs accept;
 * reviewSchema still checks the stricter rules when the review is read.
 */
export const REVIEW_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { severity: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, problem: { type: 'string' }, scenario: { type: 'string' } },
        required: ['severity', 'file', 'line', 'problem', 'scenario'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'findings'],
  additionalProperties: false,
} as const

/** A review's verdict and findings: from the schema-checked result, or from JSON in the report for older runs. */
export function reviewOf(report: { summary: string; result?: unknown }) {
  const checked = report.result !== undefined ? reviewSchema.safeParse(report.result) : undefined
  return checked?.success ? checked.data : parseReview(report.summary)
}
