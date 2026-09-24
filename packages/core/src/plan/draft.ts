import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as z from '../util/zod.js'
import { findCycle } from './graph.js'
import { PLAN_ID, CREWBOARD_DIR, planPath, savePlan } from './store.js'
import { setCurrentPlan } from './plans.js'
import { TASK_CLASSES, TASK_KINDS, emptyPlan, newTask, type Plan } from './schema.js'

const slug = z.string().check(z.regex(PLAN_ID))
const taskSlug = z.string().check(z.regex(/^[a-z0-9][a-z0-9-]*$/))
const nonEmpty = () => z.string().check(z.minLength(1))
export const DraftSourceSchema = z.union([z.literal('chat'), z.object({ name: nonEmpty(), hash: nonEmpty() })])
export const DraftTaskSchema = z.object({
  id: taskSlug.check(z.describe('Stable lowercase slug, unique in the draft')), title: nonEmpty(), lane: nonEmpty().check(z.describe('One of the draft lanes')),
  class: z.enum(TASK_CLASSES), kind: z.enum(TASK_KINDS), deps: z.array(taskSlug).check(z.describe('Ids of tasks in this draft that must finish first')),
  contract: z.string().check(z.describe('Markdown contract sketch: what to change, where, and how to check it')),
  acceptance: z.array(z.string()).check(z.describe('Checks a reviewer runs to accept the result')), sources: z.array(z.string()).check(z.describe('Specification sections this task comes from')),
})
export const PlanDraftSchema = z.object({
  id: slug.check(z.describe('Plan id: lowercase letters, digits and dashes, at most 41 characters')), goal: nonEmpty(), source: DraftSourceSchema,
  lanes: z.array(nonEmpty()), tasks: z.array(DraftTaskSchema),
  decisions: z.array(z.string()).check(z.describe('Open questions for the human, each one plain string')),
}).check(z.superRefine((draft, ctx) => {
  const ids = new Set<string>()
  for (const [i, task] of draft.tasks.entries()) {
    if (ids.has(task.id)) ctx.addIssue({ code: 'custom', path: ['tasks', i, 'id'], message: `duplicate_task_id: ${task.id}` })
    ids.add(task.id)
  }
}))
export type PlanDraft = z.infer<typeof PlanDraftSchema>
export type Finding = { code: 'cycle' | 'missing_dependency' | 'missing_acceptance' | 'empty_contract' | 'file_collision'; data: Record<string, unknown> }

/**
 * Two kinds of finding. A cycle or a dependency on a task that does not exist makes a plan that
 * cannot run — the critical path, the ready set and the graph all assume neither — so a draft with
 * one cannot be approved. The rest inform the human's judgement and never block it.
 */
export const BLOCKING_FINDINGS: ReadonlySet<Finding['code']> = new Set(['cycle', 'missing_dependency'])
export const isBlocking = (finding: Finding): boolean => BLOCKING_FINDINGS.has(finding.code)

/** Deliberately produces machine-readable facts; presentation belongs to the host/CLI. */
export function checkDraft(draft: PlanDraft): Finding[] {
  const findings: Finding[] = []
  const ids = new Set(draft.tasks.map((task) => task.id))
  const cycle = findCycle(draft.tasks)
  if (cycle) findings.push({ code: 'cycle', data: { tasks: cycle } })
  const owners = new Map<string, string>()
  // Markdown contract sketches normally name files in inline code or plain text.
  const file = /(?:^|[\s`("'])((?:[\w.-]+\/)*[\w.-]+\.[a-z][\w-]*)(?=$|[\s`),"'])/gim
  for (const task of draft.tasks) {
    for (const dep of task.deps) if (!ids.has(dep)) findings.push({ code: 'missing_dependency', data: { task: task.id, dependency: dep } })
    if (!task.acceptance.some((item) => item.trim())) findings.push({ code: 'missing_acceptance', data: { task: task.id } })
    if (!task.contract.trim()) findings.push({ code: 'empty_contract', data: { task: task.id } })
    for (const match of task.contract.matchAll(file)) {
      const path = match[1]!
      const owner = owners.get(path)
      if (owner && owner !== task.id) findings.push({ code: 'file_collision', data: { file: path, tasks: [owner, task.id] } })
      else owners.set(path, task.id)
    }
  }
  return findings
}

export class DraftError extends Error {
  constructor(readonly reason: 'invalid_id' | 'not_found' | 'plan_id_collision' | 'contract_id_collision' | 'draft_invalid', readonly id: string) {
    super(`${reason}: ${id}`)
    this.name = 'DraftError'
  }
}
const draftDir = (root: string) => join(root, CREWBOARD_DIR, 'drafts')
export const draftPath = (root: string, id: string) => {
  if (!PLAN_ID.test(id)) throw new DraftError('invalid_id', id)
  return join(draftDir(root), `${id}.json`)
}
const exists = (path: string) => stat(path).then(() => true, () => false)
const atomic = async (path: string, value: string) => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try { await writeFile(tmp, value); await rename(tmp, path) } finally { await rm(tmp, { force: true }) }
}
export { PLAN_DRAFT_JSON_SCHEMA } from './draft-json-schema.js'
export const PLAN_DRAFT_EXAMPLE: PlanDraft = {
  id: 'greeting-cli', goal: 'Add a greeting command to the CLI', source: 'chat', lanes: ['core', 'docs'],
  tasks: [
    { id: 'greet-command', title: 'Add the greet command', lane: 'core', class: 'code', kind: 'implement', deps: [], contract: 'Add `src/greet.ts` exporting `greet(name)` and wire it into the CLI.', acceptance: ['pnpm test passes', '`cli greet Ann` prints Hello, Ann'], sources: ['## Greeting'] },
    { id: 'greet-docs', title: 'Document the command', lane: 'docs', class: 'design', kind: 'implement', deps: ['greet-command'], contract: 'Describe `greet` in `README.md`.', acceptance: ['README shows an example'], sources: ['## Greeting'] },
  ],
  decisions: ['Should the greeting be localised?'],
}

const DECISION_HEAD = ['question', 'title', 'text', 'decision', 'summary', 'description', 'name'] as const
const flat = (value: unknown): string => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(flat).join('; ')
  : value && typeof value === 'object' ? JSON.stringify(value) : String(value)
/**
 * Models often write a decision as `{question, options, recommendation}`. The stored shape stays one
 * string (plans, the review screen and the CLI read it as text), so the object is folded into one line
 * with nothing dropped: the leading field first, the rest as `key: value`.
 */
export function decisionText(decision: Record<string, unknown>): string {
  const head = DECISION_HEAD.find((key) => typeof decision[key] === 'string' && (decision[key] as string).trim())
  const rest = Object.entries(decision).filter(([key, value]) => key !== head && value !== undefined && value !== null && value !== '').map(([key, value]) => `${key}: ${flat(value)}`)
  return [head ? (decision[head] as string).trim() : '', rest.join('; ')].filter(Boolean).join(' — ')
}
/** Accepts what models naturally produce and returns the stored shape; anything else is left for the validator to report. */
export function normalizeDraftInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const draft = input as Record<string, unknown>
  if (!Array.isArray(draft.decisions)) return input
  return { ...draft, decisions: draft.decisions.map((d) => (d && typeof d === 'object' && !Array.isArray(d) ? decisionText(d as Record<string, unknown>) : d)) }
}

export async function saveDraft(root: string, input: unknown): Promise<PlanDraft> {
  const draft = PlanDraftSchema.parse(normalizeDraftInput(input))
  await atomic(draftPath(root, draft.id), `${JSON.stringify(draft, null, 2)}\n`)
  return draft
}
export async function loadDraft(root: string, id: string): Promise<PlanDraft> {
  try { return PlanDraftSchema.parse(JSON.parse(await readFile(draftPath(root, id), 'utf8'))) }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new DraftError('not_found', id); throw err }
}
export async function listDrafts(root: string): Promise<PlanDraft[]> {
  const names = await readdir(draftDir(root)).catch(() => [] as string[])
  return Promise.all(names.filter((name) => name.endsWith('.json') && PLAN_ID.test(name.slice(0, -5))).sort().map((name) => loadDraft(root, name.slice(0, -5))))
}
export async function discardDraft(root: string, id: string): Promise<void> {
  if (!(await exists(draftPath(root, id)))) throw new DraftError('not_found', id)
  await rm(draftPath(root, id))
}
export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex')

export async function approveDraft(root: string, id: string, now: Date): Promise<Plan> {
  const draft = await loadDraft(root, id)
  // Refuse before anything is written: a refused approval must leave no plan and no stray contract.
  const blocking = checkDraft(draft).filter(isBlocking)
  if (blocking.length) throw new DraftError('draft_invalid', blocking.map((f) => f.code).join(','))
  if (await exists(planPath(root, id))) throw new DraftError('plan_id_collision', id)
  const paths = draft.tasks.map((task) => join(root, CREWBOARD_DIR, 'contracts', `${task.id}.md`))
  for (const [i, path] of paths.entries()) if (await exists(path)) throw new DraftError('contract_id_collision', draft.tasks[i]!.id)
  const plan: Plan = { ...emptyPlan(draft.goal, now), draftSource: draft.source, draftDecisions: draft.decisions, tasks: draft.tasks.map((task) => newTask({ id: task.id, title: task.title, lane: task.lane, class: task.class, kind: task.kind, deps: task.deps, contract: `${CREWBOARD_DIR}/contracts/${task.id}.md`, acceptance: task.acceptance, sources: task.sources })) }
  for (const [i, path] of paths.entries()) await atomic(path, draft.tasks[i]!.contract)
  const saved = await savePlan(root, plan, -1, now, id)
  await rm(draftPath(root, id))
  // The approved plan is the one the next command works on, as after `plan new` (B22, ux7 F-21).
  await setCurrentPlan(root, id)
  return saved
}
