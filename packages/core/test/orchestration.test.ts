import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import { type Backends, ProfileError, createBackends, resolveProfile } from '../src/orchestration/backends.js'
import { LaunchError, launchTask } from '../src/orchestration/launch.js'
import { steerTask, stopTask } from '../src/orchestration/control.js'
import { readSteer } from '../src/runs/steers.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'

const NOW = new Date('2026-09-22T12:00:00Z')

function fakeBackends(calls: string[] = []): Backends {
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-x',
    events: async () => [{ ts: NOW.toISOString(), type: 'tool_started', data: 'Read file' }],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async (runId, file) => {
      calls.push(`steer ${runId} ${file}`)
    },
    cancel: async (runId) => {
      calls.push(`cancel ${runId}`)
    },
  }
  return { forAgent: async () => backend }
}

async function repoWithPlan() {
  const root = await mkdtemp(join(tmpdir(), 'orch-orc-'))
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'plan', title: 'План', kind: 'decision' }))
    p.tasks.push(newTask({ id: 'a', title: 'A', deps: ['plan'] }))
    p.tasks.push({ ...newTask({ id: 'b', title: 'B' }), runs: [{ runId: 'run_dsh-b', agent: 'dsh', startedAt: '2026-09-22T11:59:00Z' }] })
    return p
  })
  return root
}

describe('orchestration', () => {
  it('routes supported workers to their direct backends', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const b = createBackends({ env: {}, home, exec: nodeExec, root: home })
    expect((await b.forAgent('dsh/deepseek-flash')).id).toBe('dsh')
    await expect(b.forAgent('unknown')).rejects.toMatchObject({ code: 'backend_unavailable' })
    expect((await b.forAgent('devin')).id).toBe('devin')
  })

  it('resolves profiles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    expect(await resolveProfile({}, home, 'dsh/deepseek-flash')).toMatchObject({ backend: 'dsh', model: 'deepseek-flash' })
    // The Claude Code floor belongs to Opus 5.5 (the model the API refused on 2.1.216), not to Opus 5.
    expect(await resolveProfile({}, home, 'claude/opus')).not.toHaveProperty('minCliVersion')
    expect(await resolveProfile({}, home, 'claude/opus-5-5')).toMatchObject({ backend: 'claude-code', model: 'opus-5-5', minCliVersion: '2.1.280' })
    expect(await resolveProfile({}, home, 'claude/fable')).not.toHaveProperty('minCliVersion')
    await expect(resolveProfile({}, home, 'devin')).rejects.toBeInstanceOf(ProfileError)
  })

  it('builds a repo snapshot with derived statuses and attention', async () => {
    const root = await repoWithPlan()
    const s = await buildRepoSnapshot(root, fakeBackends(), NOW)
    expect(s).toMatchObject({ root, goal: 'goal', degraded: false, ready: [], criticalPath: ['plan', 'a'] })
    expect(s.tasks.map((t) => [t.id, t.status])).toEqual([
      ['plan', 'ready'],
      ['a', 'blocked'],
      ['b', 'running'],
    ])
    expect(s.tasks[0]).toMatchObject({ needsHuman: true })
    expect(s.tasks[2]).toMatchObject({ activeRunId: 'run_dsh-b', lastRunId: 'run_dsh-b', runs: 1 })
    expect(s.attention).toEqual([])
  })

  it('treats a repository without a plan as an expected empty state', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'orch-empty-'))
    const s = await buildRepoSnapshot(empty, fakeBackends(), NOW)
    expect(s).toMatchObject({ root: empty, hasPlan: false, degraded: false, tasks: [] })
    expect(s.error).toBeUndefined()
  })

  it('refuses to launch decisions, blocked, running and unknown tasks with codes', async () => {
    const root = await repoWithPlan()
    const base = { root, agent: 'dsh', skipPreflight: true, backends: fakeBackends(), exec: nodeExec, env: {}, home: root, now: () => NOW }
    const code = (id: string) => launchTask({ ...base, taskId: id }).then(() => 'ok', (e: unknown) => (e instanceof LaunchError ? e.code : String(e)))
    expect(await code('plan')).toBe('decision')
    expect(await code('a')).toBe('blocked')
    expect(await code('b')).toBe('running')
    expect(await code('zzz')).toBe('unknown_task')
  })

  it('V-B19/start-refused refuses Start while the worker of a run whose supervisor died still lives', async () => {
    const root = await repoWithPlan()
    const backends = fakeBackends()
    const backend = await backends.forAgent('dsh')
    backend.status = async () => ({ status: 'running', terminal: false, exitCode: null, orphan: { workerPid: 4242 } })
    const refused = await launchTask({ root, taskId: 'b', agent: 'dsh', skipPreflight: true, backends, exec: nodeExec, env: {}, home: root, now: () => NOW, lang: 'en' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(LaunchError)
    expect(refused).toMatchObject({ code: 'orphan_alive', vars: { pid: 4242 } })
    expect((refused as LaunchError).message).toContain('4242')
  })

  it('steers and stops the last run and records the steer note', async () => {
    const root = await repoWithPlan()
    const calls: string[] = []
    const r = await steerTask(root, 'b', { message: 'use vitest' }, fakeBackends(calls), NOW)
    expect(r.runId).toBe('run_dsh-b')
    expect(r.delivery).toBe('delivered')
    if (r.delivery !== 'delivered') throw new Error('expected delivery')
    expect(await readFile(r.file, 'utf8')).toBe('use vitest\n')
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'b')?.notes.at(-1)).toMatchObject({ type: 'steer', text: expect.stringContaining('use vitest') })
    await stopTask(root, 'b', fakeBackends(calls))
    expect(calls).toEqual([`steer run_dsh-b ${r.file}`, 'cancel run_dsh-b'])
    await expect(stopTask(root, 'a', fakeBackends())).rejects.toMatchObject({ code: 'no_runs' })
  })
  it('refuses a finished run before writing a mailbox message and retains the full correction', async () => {
    const root = await repoWithPlan()
    await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'b')!.runs[0]!.finishedAt = NOW.toISOString(); p.tasks.find((t) => t.id === 'b')!.runs[0]!.outcome = 'completed'; return p })
    const calls: string[] = []
    const backends = fakeBackends(calls)
    const mailboxFile = join(root, 'mailbox.md')
    const backend = await backends.forAgent('dsh')
    backend.steer = async () => { await writeFile(mailboxFile, 'wrong') }
    const message = 'keep this exact correction for the new run'
    const r = await steerTask(root, 'b', { message }, backends, NOW)
    expect(r).toMatchObject({ delivery: 'refused', state: 'refused', runState: 'completed', message })
    expect(calls).toEqual([])
    expect(await stat(mailboxFile).then(() => true, () => false)).toBe(false)
    if (r.delivery !== 'refused') throw new Error('expected refusal')
    expect(await readFile(r.file, 'utf8')).toBe(`${message}\n`)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'b')?.notes.at(-1)).toMatchObject({ type: 'comment', text: expect.stringContaining(message) })
  })

  it('refuses a terminal backend state and records a failed mailbox write separately', async () => {
    const root = await repoWithPlan()
    const calls: string[] = []
    const backends = fakeBackends(calls)
    const backend = await backends.forAgent('dsh')
    backend.status = async () => ({ status: 'failed', terminal: true, exitCode: 1 })
    const refused = await steerTask(root, 'b', { message: 'retry this' }, backends, NOW)
    expect(refused).toMatchObject({ delivery: 'refused', state: 'refused', runState: 'failed', message: 'retry this' })
    expect(calls).toEqual([])
    backend.status = async () => ({ status: 'running', terminal: false, exitCode: null })
    backend.steer = async () => { throw new Error('mailbox denied') }
    const failed = await steerTask(root, 'b', { message: 'must survive' }, backends, new Date(NOW.getTime() + 1))
    expect(failed).toMatchObject({ delivery: 'failed', reason: 'mailbox denied', message: 'must survive' })
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'b')?.notes.at(-1)?.text).toContain('(mailbox denied)')
  })

  it('reports abandonment when the run finishes between the status check and mailbox write', async () => {
    const root = await repoWithPlan()
    const backend = await fakeBackends().forAgent('dsh')
    let terminal = false
    backend.status = async () => ({ status: terminal ? 'completed' : 'running', terminal, exitCode: terminal ? 0 : null })
    backend.steer = async () => { terminal = true }
    const result = await steerTask(root, 'b', { message: 'late correction' }, { forAgent: async () => backend }, NOW)
    expect(result).toMatchObject({ delivery: 'abandoned', state: 'abandoned' })
    expect(await readSteer(join(root, '.orchestration', 'runs', 'run_dsh-b'), result.steerId)).toMatchObject({ state: 'abandoned', reason: 'run_finished' })
  })

})
