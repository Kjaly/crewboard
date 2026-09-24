import { isSchemaError } from '../util/zod.js'
import { PLAN_DRAFT_EXAMPLE, PLAN_DRAFT_JSON_SCHEMA, PlanDraftSchema, normalizeDraftInput, type PlanDraft } from './draft.js'

export type DraftSource = PlanDraft['source']
/** One reason a worker answer is not a PlanDraft; `path` points into the answer (`decisions[0]`), empty for the whole answer. */
export type AnswerFinding = { path: string; code: string; message: string }
export type AnswerCheck = { ok: true; draft: PlanDraft } | { ok: false; findings: AnswerFinding[] }

const schemaBlock = () => `## PlanDraft JSON Schema\n\n\`\`\`json\n${JSON.stringify(PLAN_DRAFT_JSON_SCHEMA, null, 2)}\n\`\`\`\n\n## Example\n\n\`\`\`json\n${JSON.stringify(PLAN_DRAFT_EXAMPLE, null, 2)}\n\`\`\`\n`

/** The draft-worker request: the exact schema and an example, so a worker never has to guess a shape. */
export function draftPrompt(spec: string, source: DraftSource): string {
  return `# Draft a plan graph from this specification

Return only one PlanDraft JSON object that validates against the schema below — no prose and no code fences around it. Do not create or approve a plan. Every task needs a stable lowercase slug id, a lane from \`lanes\`, deps that name other tasks of this draft, a Markdown contract sketch, acceptance checks and sources pointing to specification sections. Every entry of \`decisions\` is one plain string. Set \`source\` to ${JSON.stringify(source)}. Ask no questions in this worker run; mark uncertainty in decisions.

${schemaBlock()}
# Specification

${spec}
`
}

/** A follow-up run: the previous answer and exactly what the validator refused in it. */
export function repairPrompt(answer: string, findings: AnswerFinding[], source: DraftSource, spec?: string): string {
  return `# Repair a PlanDraft JSON answer

A previous run answered with the JSON below, and the validator refused it. Return only the corrected PlanDraft JSON object — no prose and no code fences. Keep the content; change only what is needed to satisfy the schema and fix every finding. Set \`source\` to ${JSON.stringify(source)}.${spec ? ` The specification is the repository file \`${spec}\` if you need it.` : ''}

## Validator findings

${findings.map((f) => `- \`${f.path || '(answer)'}\`: ${f.message}`).join('\n') || '- (none recorded)'}

${schemaBlock()}
## Previous answer

\`\`\`
${answer}
\`\`\`
`
}

/** Models wrap JSON in fences or a sentence; take the outermost object when the plain text is not JSON. */
function parseJson(answer: string): unknown {
  const clean = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(clean) } catch (err) {
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start >= 0 && end > start) try { return JSON.parse(clean.slice(start, end + 1)) } catch { /* report the first error */ }
    throw err
  }
}

const pathText = (path: PropertyKey[]) => path.reduce<string>((out, key) => typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key), '')
/** Zod issues as findings (undefined for any other error); the chat tool reports a refused draft with the same shape. */
export const findingsOf = (err: unknown): AnswerFinding[] | undefined => isSchemaError(err) ? err.issues.map((issue) => ({ path: pathText(issue.path), code: issue.code, message: issue.message })) : undefined

/**
 * Validates a worker's raw final answer. `source` (the spec the job was started from) replaces whatever
 * the worker wrote there. Never throws: a refusal comes back as findings a repair run can act on.
 */
export function checkDraftAnswer(answer: string, source?: DraftSource): AnswerCheck {
  let proposed: unknown
  try { proposed = parseJson(answer) }
  catch (err) { return { ok: false, findings: [{ path: '', code: 'invalid_json', message: (err as Error).message }] } }
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return { ok: false, findings: [{ path: '', code: 'not_object', message: 'The answer is not a JSON object' }] }
  const result = PlanDraftSchema.safeParse(normalizeDraftInput(source ? { ...proposed, source } : proposed))
  if (result.success) return { ok: true, draft: result.data }
  return { ok: false, findings: findingsOf(result.error) ?? [] }
}
