import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaunchInput, RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { finishCheck, returnFromCheck, takeCheck } from '../src/orchestration/check.js'
import { resolveOrchestratorCheck, setPlanOrchestratorCheck, setRepositoryOrchestratorCheck } from '../src/orchestration/check-setting.js'
import { acceptTask } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { syncPlan } from '../src/orchestration/sync.js'
import { deriveViews, waitsForHuman } from '../src/plan/graph.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-24T12:00:00Z')

async function setup(setting: boolean | 'chat' | undefined) {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 't1', title: 'T1', contract: 'contract.md' }), runs: [{ runId: 'run_dsh-a', agent: 'dsh', startedAt: '2026-09-24T11:00:00Z' }] })
    return p
  })
  if (setting === 'chat') {
    await mkdir(join(root, '.orchestration'), { recursive: true })
    await writeFile(join(root, '.orchestration', 'chats.json'), JSON.stringify({ main: { sessionId: 's1', wake: true, boundAt: NOW.toISOString() } }))
  } else if (setting !== undefined) await setRepositoryOrchestratorCheck(root, setting)
  const launches: LaunchInput[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async (input) => { launches.push(input); return 'run_dsh-b' },
    events: async () => [],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  return { root, backends, launches }
}

const viewOf = async (root: string) => deriveViews(await loadPlan(root)).find((v) => v.task.id === 't1')!
const waits = async (root: string) => { const v = await viewOf(root); return waitsForHuman({ status: v.status, kind: v.task.kind, check: v.check }) }

describe('orchestrator check (vr1)', () => {
  it('with the setting on, a finished task stays with the orchestrator until checked', async () => {
    const { root, backends } = await setup(true)
    await syncPlan(root, backends, NOW)
    expect(await viewOf(root)).toMatchObject({ status: 'in_review', check: 'pending' })
    expect(await waits(root)).toBe(false)
    const snapshot = await buildRepoSnapshot(root, backends, NOW)
    expect(snapshot.tasks[0]).toMatchObject({ status: 'in_review', check: 'pending' })
    expect(snapshot.plans?.[0]?.waitingHuman).toBe(0)
    expect(snapshot.orchestratorCheck).toEqual({ enabled: true, source: 'repository', repository: true })

    await takeCheck(root, 't1', NOW, { by: 'orchestrator' })
    expect(await viewOf(root)).toMatchObject({ check: 'checking' })
    expect(await waits(root)).toBe(false)

    await finishCheck(root, 't1', 'gates green, stand ok', NOW)
    expect(await viewOf(root)).toMatchObject({ status: 'in_review', check: 'checked' })
    expect(await waits(root)).toBe(true)
    const task = (await loadPlan(root)).tasks[0]!
    expect(task.check).toMatchObject({ state: 'checked', runId: 'run_dsh-a', note: 'gates green, stand ok' })
    expect(task.notes.filter((n) => n.type === 'check').map((n) => n.event)).toEqual([{ kind: 'check_due' }, { kind: 'check_taken', by: 'orchestrator' }, { kind: 'checked', note: 'gates green, stand ok' }])
    expect((await buildRepoSnapshot(root, backends, NOW)).tasks[0]).toMatchObject({ check: 'checked', checkNote: 'gates green, stand ok' })

    await acceptTask(root, 't1', NOW)
    expect((await loadPlan(root)).tasks[0]!.notes.at(-1)).toMatchObject({ type: 'accept', check: 'checked' })
  })

  it('puts work already in review under the check once the setting is on', async () => {
    const { root, backends } = await setup(false)
    await syncPlan(root, backends, NOW)
    expect(await viewOf(root)).toMatchObject({ status: 'in_review' })
    expect((await viewOf(root)).check).toBeUndefined()
    // Another process (an older host) saw the finish; the setting comes on afterwards.
    await setRepositoryOrchestratorCheck(root, true)
    await syncPlan(root, backends, NOW)
    expect(await viewOf(root)).toMatchObject({ status: 'in_review', check: 'pending' })
    expect(await waits(root)).toBe(false)
  })

  it('records an acceptance before the check finished as unchecked', async () => {
    const { root, backends } = await setup(true)
    await syncPlan(root, backends, NOW)
    await takeCheck(root, 't1', NOW)
    await acceptTask(root, 't1', NOW)
    expect((await loadPlan(root)).tasks[0]!.notes.at(-1)).toMatchObject({ type: 'accept', check: 'unchecked' })
  })

  it('with the setting off, today\'s flow is kept: no check, waiting for the person', async () => {
    const { root, backends } = await setup(undefined)
    await syncPlan(root, backends, NOW)
    expect((await viewOf(root)).check).toBeUndefined()
    expect(await waits(root)).toBe(true)
    await acceptTask(root, 't1', NOW)
    expect((await loadPlan(root)).tasks[0]!.notes.at(-1)!.check).toBeUndefined()
  })

  it('is on by default while the plan has an orchestrator chat; the plan setting wins over both', async () => {
    const { root, backends } = await setup('chat')
    expect(await resolveOrchestratorCheck(root)).toEqual({ enabled: true, source: 'chat' })
    await setPlanOrchestratorCheck(root, undefined, false)
    expect(await resolveOrchestratorCheck(root)).toEqual({ enabled: false, source: 'plan', plan: false })
    await syncPlan(root, backends, NOW)
    expect(await waits(root)).toBe(true)
  })

  it('turning the setting off hands work waiting for a check straight to the person', async () => {
    const { root, backends } = await setup(true)
    await syncPlan(root, backends, NOW)
    expect(await waits(root)).toBe(false)
    await setRepositoryOrchestratorCheck(root, false)
    expect(await waits(root)).toBe(true)
    expect((await loadPlan(root)).tasks[0]!.notes.at(-1)!.text).toContain('check skipped')
  })

  it('--return relaunches the worker with the findings and closes the wait as reopened', async () => {
    const { root, backends, launches } = await setup(true)
    await syncPlan(root, backends, NOW)
    await takeCheck(root, 't1', NOW)
    const result = await returnFromCheck({ root, taskId: 't1', findings: 'lint fails in a.ts', caller: 'agent', skipPreflight: true, backends: { forAgent: async (agent, runId) => ({ ...(await backends.forAgent(agent, runId)), status: async () => ({ status: 'running', terminal: false, exitCode: null }) }) }, exec: nodeExec, env: {}, home: root, now: () => NOW })
    expect(result.runId).toBe('run_dsh-b')
    expect(await readFile(launches[0]!.promptFile, 'utf8')).toContain('Замечания оркестратора по проверке: lint fails in a.ts')
    const task = (await loadPlan(root)).tasks[0]!
    expect(task.check).toBeUndefined()
    expect(task.notes.at(-1)).toMatchObject({ type: 'check', text: 'returned: lint fails in a.ts' })
    expect(task.reviewIntervals?.[0]).toMatchObject({ runId: 'run_dsh-a', decision: 'reopened' })
  })

  it('refuses to check work that is not in review', async () => {
    const { root } = await setup(true)
    await updatePlan(root, (p) => { p.tasks.push(newTask({ id: 't2', title: 'T2' })); return p })
    await expect(takeCheck(root, 't2', NOW)).rejects.toMatchObject({ code: 'not_in_review' })
    await expect(takeCheck(root, 'zzz', NOW)).rejects.toMatchObject({ code: 'unknown_task' })
    await expect(finishCheck(root, 't2', '  ', NOW)).rejects.toMatchObject({ code: 'no_note' })
  })
})
