import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Attention } from '../src/watch/rules.js'
import type { Backends } from '../src/orchestration/backends.js'
import { buildRepoSnapshot, progressItemsOf, progressStageOf } from '../src/orchestration/snapshot.js'
import { deriveViews } from '../src/plan/graph.js'
import { newTask } from '../src/plan/schema.js'
import type { Plan, Task } from '../src/plan/schema.js'
import { currentPlanId, initPlan, loadPlan, planPath, plansDir, previousPlanPath, updatePlan } from '../src/plan/store.js'
import { createPlan, planIds, setCurrentPlan } from '../src/plan/plans.js'
import { makeRepo } from './git-helpers.js'

const fixture = (input: Pick<Task, 'id' | 'title'> & Partial<Task>): Task => ({ ...newTask({ id: input.id, title: input.title, kind: input.kind ?? 'implement' }), ...input })

const NOW = new Date('2026-09-28T12:00:00Z')
const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()
const finished = (runId: string, min: number) => ({ runId, agent: 'dsh', startedAt: at(min + 10), finishedAt: at(min), outcome: 'completed' as const })
const attention = (taskId: string, kind: Attention['kind']): Attention => ({ kind, severity: 'alert', taskId, runId: 'run_alert', message: 'm' })
const backends: Backends = { forAgent: async () => Promise.reject(new Error('no backend in this test')) }

it('classifies every factual stage from the canonical view, and keeps one alert row per task', () => {
  const plan: Plan = {
    version: 1,
    goal: 'g',
    rev: 1,
    updatedAt: NOW.toISOString(),
    tasks: [
      fixture({ id: 'worker', title: 'Worker', runs: [{ runId: 'run_a', agent: 'dsh', startedAt: at(5) }] }),
      { ...fixture({ id: 'pending', title: 'Pending', status: 'in_review', runs: [finished('run_b', 20)] }), check: { state: 'pending', runId: 'run_b', at: at(19) } },
      { ...fixture({ id: 'checking', title: 'Checking', status: 'in_review', runs: [finished('run_c', 30)] }), check: { state: 'checking', runId: 'run_c', at: at(29) } },
      { ...fixture({ id: 'checked', title: 'Checked', status: 'in_review', runs: [finished('run_d', 40)] }), check: { state: 'checked', runId: 'run_d', at: at(39) } },
      { ...fixture({ id: 'review', title: 'Review', status: 'in_review', runs: [finished('run_e', 50)] }) },
      fixture({ id: 'decision', title: 'Decision', kind: 'decision' }),
      { ...fixture({ id: 'root', title: 'Root', kind: 'root' }), started: { at: at(2) } },
      { ...fixture({ id: 'unmerged', title: 'Unmerged', status: 'accepted' }), worktree: { path: '/tmp/x', branch: 'orch/x' }, notes: [{ at: at(60), type: 'accept', text: 'ok' }] },
      { ...fixture({ id: 'quiet', title: 'Quiet', runs: [finished('run_f', 70)] }) },
    ],
  } as Plan
  const views = deriveViews(plan, { run_a: { status: 'running', terminal: false, exitCode: null } })
  const stage = (id: string) => progressStageOf(views.find((v) => v.task.id === id)!)
  expect(['worker', 'pending', 'checking', 'checked', 'review', 'decision', 'root', 'unmerged', 'quiet'].map(stage)).toEqual([
    'worker', 'awaiting_check', 'checking', 'checked', 'review', 'review', 'orchestrator', 'unmerged', undefined,
  ])

  // A failed last run keeps a row even without a work stage; the alarm rides that row, never a second one.
  const items = progressItemsOf('/r', 'main', views, [attention('quiet', 'failed'), attention('checked', 'stalled')], NOW)
  const byId = new Map(items.map((item) => [item.taskId, item]))
  expect(byId.get('quiet')).toMatchObject({ stage: 'alert', alerts: ['failed'] })
  expect(byId.get('checked')).toMatchObject({ stage: 'checked', alerts: ['stalled'] })
  expect(items.filter((item) => item.taskId === 'checked')).toHaveLength(1)
  expect(byId.get('decision')).toMatchObject({ stage: 'review', decision: true })
  expect(byId.get('worker')).toMatchObject({ stage: 'worker', worker: 'dsh', ageMin: 5 })
  expect(byId.has('unmerged')).toBe(true)
})

it('reports coverage unknown — never a false empty plan — for a plan on disk that cannot be read', async () => {
  const root = await makeRepo()
  await initPlan(root, 'main plan', NOW)
  await mkdir(plansDir(root), { recursive: true })
  await writeFile(planPath(root, 'broken'), '{ not json')
  const snapshot = await buildRepoSnapshot(root, backends, NOW)
  expect(snapshot.plans?.find((plan) => plan.id === 'main')?.progress).toMatchObject({ coverage: 'known' })
  expect(snapshot.plans?.find((plan) => plan.id === 'broken')?.progress).toEqual({ coverage: 'unknown', items: [] })
})

it('a read-only snapshot writes no plan and no run bookkeeping, and leaves the current pointer alone', async () => {
  const root = await makeRepo()
  await initPlan(root, 'main', NOW)
  await createPlan(root, 'p2', 'second', NOW)
  // An unfinished run the backend reports completed: a full sync would persist the finish and keep a `.prev` backup.
  await updatePlan(root, (plan) => {
    plan.tasks.push({ ...fixture({ id: 't', title: 'T', status: 'in_review', runs: [{ runId: 'run_a', agent: 'dsh', startedAt: at(5) }] }) })
    return plan
  }, 5, 'p2')
  const completing: Backends = {
    forAgent: async () => ({
      id: 'dsh',
      launch: async () => 'run_a',
      events: async () => [],
      status: async () => ({ status: 'completed', terminal: true, exitCode: 0, finishedAt: NOW.toISOString() }),
      steer: async () => {},
      cancel: async () => {},
    }),
  }
  await setCurrentPlan(root, 'main')
  const beforeBackup = await readFile(previousPlanPath(root, 'p2'), 'utf8')
  const beforeMain = await readFile(planPath(root, 'main'), 'utf8')
  const beforeP2 = await readFile(planPath(root, 'p2'), 'utf8')
  const snapshot = await buildRepoSnapshot(root, completing, NOW, 'p2', { readOnly: true, skipSummaries: true })
  expect(snapshot.planId).toBe('p2')
  expect(snapshot.partial).toBeUndefined()
  expect(currentPlanId(root)).toBe('main')
  expect(await planIds(root)).toEqual(expect.arrayContaining(['main', 'p2']))
  expect(await readFile(planPath(root, 'main'), 'utf8')).toBe(beforeMain)
  expect(await readFile(planPath(root, 'p2'), 'utf8')).toBe(beforeP2)
  expect(existsSync(previousPlanPath(root, 'main'))).toBe(false)
  expect(await readFile(previousPlanPath(root, 'p2'), 'utf8')).toBe(beforeBackup)
  // The read still reflects the finish in memory.
  expect(snapshot.tasks.find((task) => task.id === 't')?.status).toBe('in_review')
  expect((await loadPlan(root, 'p2')).tasks[0]?.runs[0]?.finishedAt).toBeUndefined()

  // Without read-only the very same finish is persisted — the difference is the option, not the data.
  await buildRepoSnapshot(root, completing, NOW, 'p2')
  expect((await loadPlan(root, 'p2')).tasks[0]?.runs[0]?.finishedAt).toBe(NOW.toISOString())
  expect(existsSync(previousPlanPath(root, 'p2'))).toBe(true)
})

it('does not run the all-plan summary pass when skipSummaries is set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-nav-skip-'))
  await initPlan(root, 'g', NOW)
  const snapshot = await buildRepoSnapshot(root, backends, NOW, 'main', { readOnly: true, skipSummaries: true })
  expect(snapshot.plans).toEqual([])
})

it('carries the contract\'s explicit <human_review> into progress and leaves an unread contract unknown', async () => {
  const root = await makeRepo()
  await initPlan(root, 'g', NOW)
  await writeFile(join(root, 'review.md'), '# Goal\n\n<human_review>\n</human_review>\n')
  await writeFile(join(root, 'plain.md'), '# Goal\n')
  await updatePlan(root, (plan) => {
    plan.tasks.push({ ...fixture({ id: 'reviewed', title: 'Reviewed', status: 'in_review', runs: [finished('run_r', 20)] }), contract: 'review.md' })
    plan.tasks.push({ ...fixture({ id: 'plain', title: 'Plain', status: 'in_review', runs: [finished('run_p', 10)] }), contract: 'plain.md' })
    plan.tasks.push({ ...fixture({ id: 'missing', title: 'Missing', status: 'in_review', runs: [finished('run_m', 5)] }), contract: 'gone.md' })
    // The run's contract is authoritative (auto-close.ts): a newer `task.contract` must not hide a requirement.
    plan.tasks.push({ ...fixture({ id: 'hidden', title: 'Hidden', status: 'in_review', runs: [{ ...finished('run_h', 15), contractPath: 'review.md' }] }), contract: 'plain.md' })
    plan.tasks.push({ ...fixture({ id: 'revealed', title: 'Revealed', status: 'in_review', runs: [{ ...finished('run_v', 12), contractPath: 'plain.md' }] }), contract: 'review.md' })
    return plan
  })
  const snapshot = await buildRepoSnapshot(root, backends, NOW)
  const items = new Map((snapshot.plans?.[0]?.progress?.items ?? []).map((item) => [item.taskId, item]))
  // The classification is the contract's own, never inferred from `in_review` (all five are in review).
  expect(items.get('reviewed')).toMatchObject({ stage: 'review', humanReview: true })
  expect(items.get('plain')).toMatchObject({ stage: 'review', humanReview: false })
  expect(items.get('missing')?.humanReview).toBeUndefined()
  // `run.contractPath ?? task.contract`, the exact acceptance/auto-close priority, in both directions.
  expect(items.get('hidden')).toMatchObject({ humanReview: true })
  expect(items.get('revealed')).toMatchObject({ humanReview: false })
})


it('keeps backlog, dependency-blocked and terminal decisions out of the current human queue', () => {
  const plan: Plan = { version: 1, goal: 'g', rev: 1, updatedAt: NOW.toISOString(), tasks: [
    fixture({ id: 'upstream', title: 'U', status: 'backlog' }),
    fixture({ id: 'later', title: 'Later decision', kind: 'decision', status: 'backlog' }),
    fixture({ id: 'blocked', title: 'Blocked decision', kind: 'decision', deps: ['upstream'] }),
    fixture({ id: 'superseded', title: 'Old decision', kind: 'decision', status: 'superseded' }),
    fixture({ id: 'dropped', title: 'Dropped decision', kind: 'decision', status: 'dropped' }),
    fixture({ id: 'ready', title: 'Ready decision', kind: 'decision' }),
  ] }
  const views = deriveViews(plan)
  expect(progressItemsOf('/r', 'main', views, [], NOW).map((item) => item.taskId)).toEqual(['ready'])
  const preparing = deriveViews(plan, {}, { prepareDecisions: true })
  expect(progressItemsOf('/r', 'main', preparing, [], NOW).find((item) => item.taskId === 'ready')?.stage).toBe('orchestrator')
})
