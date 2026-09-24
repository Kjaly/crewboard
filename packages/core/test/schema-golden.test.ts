import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DraftJobSchema } from '../src/plan/draft-jobs.js'
import { checkDraftAnswer, findingsOf } from '../src/plan/draft-from.js'
import { DraftSourceSchema, PLAN_DRAFT_EXAMPLE, PLAN_DRAFT_JSON_SCHEMA, PlanDraftSchema, normalizeDraftInput } from '../src/plan/draft.js'
import { PlanSchema, TaskSchema, newTask } from '../src/plan/schema.js'
import { EMPTY_RECIPE, RecipeSchema, saveRecipe } from '../src/worktree/recipe.js'

/**
 * Golden record of what the schemas accept, what they return and what they report. Captured from the
 * classic zod implementation before the move to zod/mini: any drift in accept/reject, defaults, issue
 * codes, paths or messages — or in the draft JSON Schema handed to workers — shows up as a diff here.
 */
type Parser = { safeParse: (input: unknown) => { success: true; data: unknown } | { success: false; error: { issues: unknown[] } } }
const outcome = (schema: Parser, input: unknown) => {
  const result = schema.safeParse(input)
  return result.success ? { ok: true, data: result.data } : { ok: false, issues: result.error.issues }
}
const thrown = (fn: () => unknown) => {
  try { return { ok: true, data: fn() } } catch (err) { return { ok: false, message: (err as Error).message, findings: findingsOf(err) } }
}

const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id.toUpperCase(), kind: 'implement', status: 'ready', ...extra })
const plan = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, goal: 'Ship', rev: 0, updatedAt: '2026-09-24T00:00:00.000Z', tasks, ...extra })
const run = { runId: 'run_abc-1', agent: 'codex', startedAt: '2026-09-24T00:00:00.000Z' }
const fullTask = task('full', {
  class: 'code', lane: 'core', deps: ['a'], worker: 'codex', contract: 'c.md', acceptance: ['ok'], sources: ['§1'],
  worktree: { path: '/w', branch: 'b' }, pos: { x: 1, y: 2 },
  runs: [{ ...run, finishedAt: 'x', outcome: 'completed', attemptIndex: 2, attemptTrigger: 'human_relaunch', billingMode: 'api', identityResolution: 'alias', quotaSamples: [{ sampleId: 's', accountKey: 'k', provider: 'p', windowId: 'w', beforePct: 1, afterPct: 2, attribution: 'shared' }] }],
  notes: [{ at: 'x', type: 'accept', text: 't', verdict: { kind: 'result', why: 'blocked', mismatch: 'no_files' } }],
  reviewIntervals: [{ id: 'r', enteredAt: 'x' }, { id: 'r2', enteredAt: 'x', decision: 'accepted', source: 'legacy_note', association: 'ambiguous' }],
})

const PLAN_CASES: Record<string, unknown> = {
  minimal: plan([task('a')]),
  full: plan([task('a'), fullTask], { draftSource: { name: 'spec.md', hash: 'h' }, draftDecisions: ['q'], preset: 'p', archived: false, example: true, exampleLang: 'ru', extra: 'stripped' }),
  draftSourceChat: plan([], { draftSource: 'chat' }),
  notObject: 'plan',
  nullInput: null,
  emptyObject: {},
  wrongVersion: plan([], { version: 2 }),
  negativeRev: plan([], { rev: -1 }),
  fractionalRev: plan([], { rev: 1.5 }),
  stringRev: plan([], { rev: '1' }),
  badTaskId: plan([task('Bad_Id')]),
  emptyTitle: plan([task('a', { title: '' })]),
  badKind: plan([task('a', { kind: 'build' })]),
  badClass: plan([task('a', { class: 'ops' })]),
  derivedStatus: plan([task('a', { status: 'running' })]),
  badDepsType: plan([task('a', { deps: 'b' })]),
  duplicateIds: plan([task('a'), task('a')]),
  unknownDep: plan([task('a', { deps: ['zzz'] })]),
  duplicateAndUnknown: plan([task('a', { deps: ['q'] }), task('a')]),
  badRunId: plan([task('a', { runs: [{ ...run, runId: 'RUN_1' }] })]),
  emptyAgent: plan([task('a', { runs: [{ ...run, agent: '' }] })]),
  zeroAttempt: plan([task('a', { runs: [{ ...run, attemptIndex: 0 }] })]),
  fractionalAttempt: plan([task('a', { runs: [{ ...run, attemptIndex: 1.5 }] })]),
  stringAttempt: plan([task('a', { runs: [{ ...run, attemptIndex: '1' }] })]),
  badOutcome: plan([task('a', { runs: [{ ...run, outcome: 'done' }] })]),
  badQuotaSample: plan([task('a', { runs: [{ ...run, quotaSamples: [{ sampleId: 's' }] }] })]),
  badNote: plan([task('a', { notes: [{ at: 'x', type: 'shout', text: 1, verdict: { kind: 'maybe' } }] })]),
  badInterval: plan([task('a', { reviewIntervals: [{ id: 'r', enteredAt: 'x', source: 'robot', decision: 'nope' }] })]),
  badPos: plan([task('a', { pos: { x: '1' } })]),
  badWorktree: plan([task('a', { worktree: { path: '/w' } })]),
  badDraftSource: plan([], { draftSource: { name: 'x' } }),
  badDraftSourceLiteral: plan([], { draftSource: 'email' }),
  badExampleLang: plan([], { exampleLang: 'de' }),
  tasksNotArray: plan({} as unknown[]),
}

const draftTask = PLAN_DRAFT_EXAMPLE.tasks[0]!
const draft = (extra: Record<string, unknown> = {}) => ({ ...PLAN_DRAFT_EXAMPLE, ...extra })
const DRAFT_CASES: Record<string, unknown> = {
  example: PLAN_DRAFT_EXAMPLE,
  extraKeys: draft({ note: 'stripped', tasks: [{ ...draftTask, pos: 1 }] }),
  notObject: [],
  emptyObject: {},
  badId: draft({ id: 'Bad Id' }),
  longId: draft({ id: 'a'.repeat(42) }),
  emptyGoal: draft({ goal: '' }),
  sourceEmptyName: draft({ source: { name: '', hash: '' } }),
  sourceLiteral: draft({ source: 'mail' }),
  emptyLane: draft({ lanes: [''] }),
  duplicateTasks: draft({ tasks: [draftTask, draftTask, draftTask] }),
  badTaskSlug: draft({ tasks: [{ ...draftTask, id: '-x', deps: ['Y'] }] }),
  missingTaskFields: draft({ tasks: [{ id: 'x' }] }),
  badEnums: draft({ tasks: [{ ...draftTask, class: 'ops', kind: 'build' }] }),
  decisionObject: draft({ decisions: [{ question: 'Localise?', options: ['yes', 'no'], recommendation: 'no' }] }),
  decisionNumber: draft({ decisions: [42] }),
}

const JOB = { id: 'dj-1', status: 'running', source: 'chat', agent: 'codex', createdAt: 'x', updatedAt: 'x', attempts: [{ runId: 'r', kind: 'draft', agent: 'codex', startedAt: 'x' }] }
const JOB_CASES: Record<string, unknown> = {
  valid: { ...JOB, spec: 'spec.md', findings: [{ path: 'id', code: 'c', message: 'm' }], draftId: 'd', extra: 1 },
  badId: { ...JOB, id: 'job-1' },
  badStatus: { ...JOB, status: 'paused' },
  badAttempt: { ...JOB, attempts: [{ runId: 'r', kind: 'fix' }] },
  badFinding: { ...JOB, findings: [{ path: 1 }] },
}

const RECIPE_CASES: Record<string, unknown> = {
  empty: {},
  full: { setup: ['pnpm i', { copy: '.env' }], env: { unset: ['CI'] }, baseline: 'pnpm test', timeoutSec: 60, extra: true },
  envWithoutUnset: { env: {} },
  emptyStep: { setup: [''] },
  emptyCopy: { setup: [{ copy: '' }] },
  badStep: { setup: [1] },
  zeroTimeout: { timeoutSec: 0 },
  fractionalTimeout: { timeoutSec: 1.5 },
  stringTimeout: { timeoutSec: '5' },
  badUnset: { env: { unset: [1] } },
  notObject: 'recipe',
}

describe('schema golden record', () => {
  it('plans, tasks and newTask', async () => {
    const record = {
      plans: Object.fromEntries(Object.entries(PLAN_CASES).map(([name, input]) => [name, outcome(PlanSchema, input)])),
      task: outcome(TaskSchema, task('solo')),
      newTask: thrown(() => newTask({ id: 'n', title: 'N', deps: ['a'] })),
      newTaskInvalid: thrown(() => newTask({ id: 'N!', title: '' })),
      thrownPlan: thrown(() => PlanSchema.parse(PLAN_CASES.duplicateAndUnknown)),
    }
    await expect(`${JSON.stringify(record, null, 2)}\n`).toMatchFileSnapshot('./__golden__/plan-schema.json')
  })

  it('drafts, draft sources, draft answers and draft jobs', async () => {
    const record = {
      drafts: Object.fromEntries(Object.entries(DRAFT_CASES).map(([name, input]) => [name, outcome(PlanDraftSchema, normalizeDraftInput(input))])),
      sources: ['chat', { name: 'a', hash: 'b' }, { name: 'a' }, 7].map((input) => outcome(DraftSourceSchema, input)),
      answers: {
        valid: checkDraftAnswer(JSON.stringify(PLAN_DRAFT_EXAMPLE)),
        sourceReplaced: checkDraftAnswer(JSON.stringify({ ...PLAN_DRAFT_EXAMPLE, source: 'bogus' }), { name: 'spec.md', hash: 'h' }),
        invalid: checkDraftAnswer(JSON.stringify({ ...PLAN_DRAFT_EXAMPLE, id: 'X', tasks: [{ ...draftTask, deps: [1] }, draftTask] })),
      },
      thrownDraft: thrown(() => PlanDraftSchema.parse(DRAFT_CASES.duplicateTasks)),
      notSchemaError: findingsOf(new Error('plain')) ?? null,
      jobs: Object.fromEntries(Object.entries(JOB_CASES).map(([name, input]) => [name, outcome(DraftJobSchema, input)])),
    }
    await expect(`${JSON.stringify(record, null, 2)}\n`).toMatchFileSnapshot('./__golden__/draft-schema.json')
  })

  it('the draft JSON Schema handed to workers', async () => {
    await expect(`${JSON.stringify(PLAN_DRAFT_JSON_SCHEMA, null, 2)}\n`).toMatchFileSnapshot('./__golden__/plan-draft.schema.json')
  })

  it('recipes, including the strict save path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recipe-golden-'))
    const saved: Record<string, unknown> = {}
    for (const [name, input] of Object.entries({ ...RECIPE_CASES, unknownKey: { setup: [], extra: true }, nestedUnknownKey: { env: { unset: [], set: {} } } })) {
      saved[name] = await saveRecipe(root, input).then((data) => ({ ok: true, data }), (err: Error) => ({ ok: false, name: err.name === 'RangeError' ? 'RangeError' : 'schema', message: err.message }))
    }
    const record = {
      empty: EMPTY_RECIPE,
      recipes: Object.fromEntries(Object.entries(RECIPE_CASES).map(([name, input]) => [name, outcome(RecipeSchema, input)])),
      saved,
    }
    await expect(`${JSON.stringify(record, null, 2)}\n`).toMatchFileSnapshot('./__golden__/recipe-schema.json')
  })
})
