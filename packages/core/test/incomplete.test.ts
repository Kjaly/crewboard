import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaunchInput, RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import { gatherAttention } from '../src/orchestration/attention.js'
import type { Backends } from '../src/orchestration/backends.js'
import { WORKER_RULES } from '../src/orchestration/launch.js'
import { needsYou } from '../src/orchestration/needs-you.js'
import { CONTINUE_DIRECTION, continueTask } from '../src/orchestration/relaunch.js'
import { syncPlan } from '../src/orchestration/sync.js'
import { deriveViews, syncRuns } from '../src/plan/graph.js'
import { type Plan, newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

// bg1: a run whose process finished cleanly but that handed nothing in — uncommitted work, no result claim —
// ends `incomplete`: not in review, an alarm in «Needs you», and «Continue» relaunches it with a direction.

const NOW = new Date('2026-09-24T12:00:00Z')

async function setup(answer: string | undefined, dirty = true) {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await nodeExec('git', ['-C', root, 'add', 'contract.md'])
  await nodeExec('git', ['-C', root, 'commit', '-q', '-m', 'contract'])
  if (dirty) await writeFile(join(root, 'work.txt'), 'half done\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'a', title: 'A', contract: 'contract.md' }), worktree: { path: root, branch: 'main' }, runs: [{ runId: 'run_claude-a', agent: 'claude', startedAt: '2026-09-24T11:00:00Z' }] })
    return p
  })
  const launches: LaunchInput[] = []
  const backend: RunBackend = {
    id: 'claude',
    launch: async (input) => {
      launches.push(input)
      return 'run_claude-b'
    },
    events: async () => (answer === undefined ? [] : [{ ts: NOW.toISOString(), type: 'answer_delta', data: answer }]),
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  return { root, backends, launches, base: { root, skipPreflight: true, backends, exec: nodeExec, env: {}, home: root, now: () => NOW } }
}

describe('incomplete runs (bg1)', () => {
  it('V-bg1/incomplete a clean exit with uncommitted work and no answer is incomplete and stays out of review', async () => {
    const { root, backends } = await setup(undefined)
    await syncPlan(root, backends, NOW)
    const task = (await loadPlan(root)).tasks[0]!
    expect(task.runs[0]).toMatchObject({ outcome: 'incomplete', incomplete: { reason: 'no_report', uncommitted: 1 } })
    expect(task.status).toBe('ready')
    expect(task.check).toBeUndefined()
    expect(task.reviewIntervals ?? []).toEqual([])
    expect(deriveViews(await loadPlan(root))[0]).toMatchObject({ status: 'ready', lastOutcome: 'incomplete' })
  })

  it('an answer that only says it is waiting has no claim: incomplete, no_claim', async () => {
    const { root, backends } = await setup('Started the stress checks in the background, waiting for the notification.')
    await syncPlan(root, backends, NOW)
    expect((await loadPlan(root)).tasks[0]?.runs[0]).toMatchObject({ outcome: 'incomplete', incomplete: { reason: 'no_claim' } })
  })

  it.each([
    ['a result claim on the first line', 'Результат: получен\n## Отчёт\n- done', true],
    ['a result claim at the top of the report section', '## Отчёт\nРезультат: отрицательный\n- nothing to do', true],
    ['no claim but nothing left uncommitted', 'done', false],
  ])('%s goes to review as before', async (_name, answer, dirty) => {
    const { root, backends } = await setup(answer, dirty)
    await syncPlan(root, backends, NOW)
    const task = (await loadPlan(root)).tasks[0]!
    expect(task.runs[0]?.outcome).toBe('completed')
    expect(task.status).toBe('in_review')
  })

  it('syncRuns leaves a failed run failed even when it is listed', () => {
    const plan = { tasks: [{ ...newTask({ id: 'a', title: 'A' }), runs: [{ runId: 'run_x-a', agent: 'x', startedAt: NOW.toISOString() }] }] } as unknown as Plan
    const { plan: next } = syncRuns(plan, { 'run_x-a': { status: 'failed', terminal: true, exitCode: 1 } }, NOW, new Map([['run_x-a', { reason: 'no_report' as const, uncommitted: 2 }]]))
    expect(next.tasks[0]?.runs[0]).toMatchObject({ outcome: 'failed' })
    expect(next.tasks[0]?.runs[0]?.incomplete).toBeUndefined()
  })

  it('raises an incomplete alarm with the reason and the continue hint, listed in Needs you', async () => {
    const { root, backends } = await setup(undefined)
    const { plan, states } = await syncPlan(root, backends, NOW)
    const alarms = await gatherAttention(plan, states, backends, NOW)
    expect(alarms).toEqual([expect.objectContaining({ kind: 'incomplete', severity: 'alert', taskId: 'a', message: expect.stringContaining('без отчёта'), hint: 'crewboard continue a' })])
    expect(alarms[0]?.message).toContain('1')
    const items = needsYou([{ root, attention: alarms, updatedAt: NOW.toISOString(), tasks: [{ id: 'a', title: 'A', kind: 'implement', status: 'ready' }] }])
    expect(items).toEqual([expect.objectContaining({ kind: 'attention', taskId: 'a', alarm: 'incomplete', alert: true })])
  })

  it('V-bg1/continue relaunches in the same worktree with the direction and the worker rules', async () => {
    const { root, backends, launches, base } = await setup(undefined)
    await syncPlan(root, backends, NOW)
    const r = await continueTask({ ...base, taskId: 'a', caller: 'person' })
    expect(r.runId).toBe('run_claude-b')
    const prompt = await readFile(launches[0]?.promptFile ?? '', 'utf8')
    expect(prompt).toContain('# Contract\nDo the thing.')
    expect(prompt).toContain(`Прошлый запуск: claude, итог: incomplete.`)
    expect(prompt).toContain(CONTINUE_DIRECTION)
    expect(prompt).not.toContain('Указание человека')
    expect(prompt.trimEnd().endsWith(WORKER_RULES.trimEnd())).toBe(true)
    // The task's copy is keyed by its id: the continued run works in the copy the plan records for it.
    expect(launches[0]?.cwd).toBe((await loadPlan(root)).tasks[0]?.worktree?.path)
  })

  it('refuses to continue a run that did not end incomplete', async () => {
    const { root, backends, base } = await setup('Результат: получен\n- done')
    await syncPlan(root, backends, NOW)
    await expect(continueTask({ ...base, taskId: 'a' })).rejects.toMatchObject({ code: 'not_incomplete' })
    await expect(continueTask({ ...base, taskId: 'zzz' })).rejects.toMatchObject({ code: 'unknown_task' })
  })
})
