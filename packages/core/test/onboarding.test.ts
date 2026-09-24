import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Backends } from '../src/orchestration/backends.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { launchTask } from '../src/orchestration/launch.js'
import { acceptTask, rejectTask, supersedeTask } from '../src/orchestration/review.js'
import { relaunchTask } from '../src/orchestration/relaunch.js'
import { steerTask, stopTask } from '../src/orchestration/control.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { getTaskDiff } from '../src/orchestration/detail.js'
import { getTaskFile } from '../src/orchestration/file-preview.js'
import { createExamplePlan, EXAMPLE_RUN_PREFIX, EXAMPLE_SOURCE, removeExample } from '../src/plan/example.js'
import { backendsForPlan } from '../src/runs/example-backend.js'
import { buildLedger } from '../src/runs/ledger.js'
import { runCost } from '../src/cost/cost.js'
import { loadPlan, updatePlan } from '../src/plan/store.js'
import { listPlans } from '../src/plan/plans.js'
import { detectRecipe, loadRecipe, saveRecipe } from '../src/worktree/recipe.js'
import { nodeExec } from '../src/exec.js'
import { makeRepo } from './git-helpers.js'

const now = new Date('2026-09-23T12:00:00Z')
const backends: Backends = { forAgent: async () => { throw new Error('backend must not be used') } }

describe('repository recipe', () => {
  it('detects a project, saves atomically, validates, and never executes commands', async () => {
    const root = await makeRepo()
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await writeFile(join(root, 'Makefile'), 'test:\n\t@true\n')
    expect(await detectRecipe(root)).toMatchObject({ setup: ['pnpm install --frozen-lockfile'], baseline: 'make test' })
    const recipe = await saveRecipe(root, { setup: ['touch SHOULD_NOT_EXIST'], baseline: 'make test', timeoutSec: 45 })
    expect(recipe.setup).toEqual(['touch SHOULD_NOT_EXIST'])
    expect(await loadRecipe(root)).toEqual(recipe)
    expect(await stat(join(root, 'SHOULD_NOT_EXIST')).then(() => true, () => false)).toBe(false)
    expect(await readFile(join(root, '.orchestration/recipes.json'), 'utf8')).toContain('timeoutSec')
    await expect(saveRecipe(root, { setup: [], timeoutSec: -1 })).rejects.toThrow()
  })
})

describe('example plan', () => {
  it('builds a real graph: edges, fan-out, fan-in, a long critical path and every status', async () => {
    const root = await makeRepo()
    await createExamplePlan(root, now)
    const plan = await loadPlan(root)
    expect(plan).toMatchObject({ example: true, exampleVersion: 2 })
    expect(plan.tasks.length).toBeGreaterThanOrEqual(10)
    expect(new Set(plan.tasks.map((task) => task.lane)).size).toBeGreaterThanOrEqual(4)
    const edges = plan.tasks.flatMap((task) => task.deps.map((dep) => [dep, task.id]))
    expect(edges.length).toBeGreaterThanOrEqual(12)
    const fanOut = Math.max(...plan.tasks.map((task) => edges.filter(([from]) => from === task.id).length))
    const fanIn = Math.max(...plan.tasks.map((task) => task.deps.length))
    expect(fanOut).toBeGreaterThanOrEqual(3)
    expect(fanIn).toBeGreaterThanOrEqual(2)
    const byId = new Map(plan.tasks.map((task) => [task.id, task]))
    const depth = (id: string): number => 1 + Math.max(0, ...(byId.get(id)?.deps ?? []).map(depth))
    expect(Math.max(...plan.tasks.map((task) => depth(task.id)))).toBeGreaterThanOrEqual(4)
    expect(plan.tasks.some((task) => task.kind === 'decision')).toBe(true)
    expect(new Set(plan.tasks.map((task) => task.worker?.split('/')[0]).filter(Boolean))).toEqual(new Set(['dsh', 'claude', 'codex', 'devin']))
    const snap = await buildRepoSnapshot(root, backends, now)
    expect(new Set(snap.tasks.map((t) => t.status))).toEqual(new Set(['accepted', 'running', 'in_review', 'ready', 'blocked', 'backlog']))
    expect(snap.tasks.some((task) => task.returned)).toBe(true)
    expect(snap.tasks.some((task) => task.lastOutcome === 'failed')).toBe(true)
    expect(snap.example).toBe(true)
    expect(snap.attention).toEqual([])
    expect((await listPlans(root))[0]).toMatchObject({ example: true })
  })

  it('serves runs with ledgers, costs, review waits and a second attempt without touching a real backend', async () => {
    const root = await makeRepo()
    const plan = await createExamplePlan(root, now)
    const runs = plan.tasks.flatMap((task) => task.runs.map((run) => ({ task, run })))
    expect(runs.every(({ run }) => run.runId.startsWith(EXAMPLE_RUN_PREFIX))).toBe(true)
    expect(runs.some(({ run }) => run.attemptIndex === 2 && run.attemptTrigger === 'human_relaunch' && run.attemptParentRunId)).toBe(true)
    expect(plan.tasks.some((task) => task.notes.some((note) => note.type === 'reject'))).toBe(true)
    expect(plan.tasks.some((task) => task.reviewIntervals?.some((interval) => !interval.decidedAt))).toBe(true)
    const source = backendsForPlan(plan, root, backends)
    const costs = await Promise.all(runs.map(async ({ run }) => {
      const backend = await source.forAgent(run.agent, run.runId)
      const events = await backend.events(run.runId)
      expect(buildLedger(events, run).length).toBeGreaterThan(2)
      return runCost(run, events, await backend.usage?.(run.runId))
    }))
    expect(costs.some((cost) => cost.cashUsd?.source === EXAMPLE_SOURCE)).toBe(true)
    expect(costs.some((cost) => cost.apiEquivalentUsd?.source === EXAMPLE_SOURCE && cost.availability?.cash === 'notApplicable')).toBe(true)
    expect(costs.some((cost) => cost.cashUsd === undefined && cost.apiEquivalentUsd === undefined && cost.availability?.cash === 'unavailable')).toBe(true)
    expect(costs.some((cost) => cost.executionOutcome === 'running')).toBe(true)
    expect(costs.some((cost) => cost.executionOutcome === 'failed')).toBe(true)
    const backend = await source.forAgent('devin', 'run_example-analytics-1')
    await expect(backend.launch({ agent: 'devin', promptFile: 'x', cwd: root })).rejects.toMatchObject({ code: 'example_plan' })
    expect(await backend.events('run_real-1')).toEqual([])
    const real = { example: false }
    expect(backendsForPlan(real, root, backends)).toBe(backends)
  })

  it('shows reports, files and the decision brief, and removes everything it created', async () => {
    const root = await makeRepo()
    await createExamplePlan(root, now)
    const detail = await getTaskDetail(root, 'build', backends, nodeExec)
    expect(detail.status).toBe('in_review')
    expect(detail.report?.text).toContain('Checks: pnpm test passed')
    expect(detail.verdict.kind).toBe('result')
    expect(detail.changedFiles).toEqual(['welcome.md', 'welcome.png'])
    expect(detail.contract?.text).toContain('Review checklist')
    expect(detail.events.length).toBeGreaterThan(2)
    expect((await getTaskFile(root, 'build', 'welcome.md', 'after', nodeExec)).toString()).toContain('# Welcome screen')
    expect((await getTaskFile(root, 'build', 'welcome.png', 'after', nodeExec)).subarray(0, 4).toString('hex')).toBe('89504e47')
    await expect(getTaskFile(root, 'build', '../../plans/orchestra-example.json', 'after', nodeExec)).rejects.toMatchObject({ code: 'unknown_file' })
    expect((await getTaskDetail(root, 'decide-flow', backends, nodeExec)).contract?.text).toContain('- [x]')
    const failed = await getTaskDetail(root, 'analytics', backends, nodeExec)
    expect(failed.events.some((event) => event.kind === 'problem')).toBe(true)
    await removeExample(root)
    expect((await listPlans(root)).some((p) => p.example)).toBe(false)
    expect(await stat(join(root, '.orchestration/example')).then(() => true, () => false)).toBe(false)
    expect((await readdir(join(root, '.orchestration/runs')).catch(() => [] as string[])).filter((name) => name.startsWith(EXAMPLE_RUN_PREFIX))).toEqual([])
  })

  it('creates a Russian fixture throughout the task, report, events, contract, and Markdown preview', async () => {
    const root = await makeRepo()
    const plan = await createExamplePlan(root, now, 'ru')
    expect(plan).toMatchObject({ example: true, exampleLang: 'ru', goal: 'Посмотрите, как работает план' })
    expect(plan.tasks.map((task) => task.title)).toContain('Собрать экран приветствия')
    expect(plan.tasks.map((task) => task.lane)).toContain('Проверка')
    expect(plan.tasks.find((task) => task.id === 'outline')?.notes[0]?.text).toContain('Макет')
    const detail = await getTaskDetail(root, 'build', backends, nodeExec)
    expect(detail.report).toMatchObject({ source: 'section', text: expect.stringContaining('Экран приветствия собран') })
    expect(detail.contract?.text).toContain('Что проверить')
    expect(await getTaskDiff(root, 'build', 'welcome.md', nodeExec)).toContain('Разбейте работу')
    expect((await getTaskFile(root, 'build', 'welcome.md', 'after', nodeExec)).toString()).toContain('Экран приветствия')
    const english = await createExamplePlan(root, now, 'en')
    expect(english).toMatchObject({ exampleLang: 'en', goal: 'Explore a plan in action' })
    expect((await getTaskFile(root, 'build', 'welcome.md', 'after', nodeExec)).toString()).toContain('# Welcome screen')
  })

  it('rebuilds an example written by an older fixture', async () => {
    const root = await makeRepo()
    await createExamplePlan(root, now)
    await writeFile(join(root, '.orchestration/plans/orchestra-example.json'), (await readFile(join(root, '.orchestration/plans/orchestra-example.json'), 'utf8')).replace('"exampleVersion": 2', '"exampleVersion": 1'))
    expect((await createExamplePlan(root, now)).exampleVersion).toBe(2)
  })

  it('refuses all worker and decision mutations with the same code', async () => {
    const root = await makeRepo()
    await createExamplePlan(root, now)
    const launch = () => launchTask({ root, taskId: 'analytics', backends, exec: nodeExec, env: {}, home: root, now: () => now })
    const relaunch = () => relaunchTask({ root, taskId: 'build', backends, exec: nodeExec, env: {}, home: root, now: () => now })
    for (const attempt of [launch, relaunch, () => steerTask(root, 'api', { message: 'x' }, backends, now), () => stopTask(root, 'api', backends), () => acceptTask(root, 'build', now), () => rejectTask(root, 'build', 'x', now), () => supersedeTask(root, 'build', 'api', now), () => updatePlan(root, (p) => p)]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'example_plan' })
    }
  })
})
