import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaunchInput, RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { launchTask } from '../src/orchestration/launch.js'
import { relaunchTask } from '../src/orchestration/relaunch.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-22T12:00:00Z')

async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({
      ...newTask({ id: 't1', title: 'T1', contract: 'contract.md' }),
      status: 'in_review',
      runs: [{ runId: 'run_dsh-a', agent: 'dsh', startedAt: '2026-09-22T11:00:00Z', finishedAt: '2026-09-22T11:10:00Z', outcome: 'completed' }],
    })
    p.tasks.push(newTask({ id: 't2', title: 'T2', contract: 'contract.md' }))
    p.tasks.push({ ...newTask({ id: 'draft', title: 'Draft', contract: 'contract.md' }), status: 'backlog' })
    return p
  })
  const launches: LaunchInput[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async (input) => {
      launches.push(input)
      return 'run_dsh-b'
    },
    events: async () => [
      { ts: '2026-09-22T11:05:00Z', type: 'answer_delta', data: 'Half done, tests red.' },
      { ts: '2026-09-22T11:06:00Z', type: 'run_failed', data: 'vitest: 2 failed' },
    ],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const base = { root, skipPreflight: true, backends, exec: nodeExec, env: {}, home: root, now: () => NOW }
  return { root, base, launches }
}

describe('relaunchTask', () => {
  it('starts a new run with the contract plus the previous run context, keeping the task contract', async () => {
    const { root, base, launches } = await setup()
    // dsh is outside the default code order: a person names it (an agent could not, wp1).
    const r = await relaunchTask({ ...base, taskId: 't1', agent: 'dsh', caller: 'person', note: 'fix the two failing tests', fromStep: 'pnpm test' })
    expect(r).toMatchObject({ runId: 'run_dsh-b', agent: 'dsh' })
    const prompt = await readFile(launches[0]?.promptFile ?? '', 'utf8')
    expect(prompt).toContain('# Contract\nDo the thing.')
    expect(prompt).toContain('<previous_run>')
    expect(prompt).toContain('Half done, tests red.')
    expect(prompt).toContain('vitest: 2 failed')
    expect(prompt).toContain('Продолжи с шага: pnpm test')
    expect(prompt).toContain('Указание человека: fix the two failing tests')
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 't1')
    expect(task?.contract).toBe('contract.md')
    expect(task?.runs.map((x) => x.runId)).toEqual(['run_dsh-a', 'run_dsh-b'])
  })

  it('needs a previous run', async () => {
    const { base } = await setup()
    await expect(relaunchTask({ ...base, taskId: 't2' })).rejects.toMatchObject({ code: 'no_runs' })
    await expect(relaunchTask({ ...base, taskId: 'zzz' })).rejects.toMatchObject({ code: 'unknown_task' })
  })

  // Launching is the decision that a draft is ready; left a draft, its finished run skipped review.
  it('makes a launched draft ready, so its finished run goes to review', async () => {
    const { root, base } = await setup()
    await launchTask({ ...base, taskId: 'draft', agent: 'dsh', caller: 'person' })
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'draft')?.status).toBe('ready')
  })
})
