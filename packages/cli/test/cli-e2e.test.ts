import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

vi.mock('../../core/src/runs/devin-backend.js', async () => import('../../core/dist/runs/devin-backend.js'))
const FAKE_DEVIN = fileURLToPath(new URL('../../core/test/fixtures/fake-devin.mjs', import.meta.url))


let root: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  await mkdir(join(home, '.config/crewboard'), { recursive: true })
  await writeFile(join(home, '.config/crewboard/profiles.json'), JSON.stringify({ version: 1, routing: { classes: { code: ['devin'], design: ['devin'], review: ['devin'], research: ['devin'] }, disabled: {} }, aliases: {}, profiles: { devin: { transport: 'devin-acp', model: 'swe-2-high', displayName: 'Devin', enabled: true } } }))
  env = { ...process.env, LC_ALL: 'en_US.UTF-8', CREWBOARD_DEVIN_COMMAND: process.execPath, CREWBOARD_DEVIN_ARGS: JSON.stringify([FAKE_DEVIN, 'hold']), HOME: home }
  await mkdir(join(root, '.orchestration'), { recursive: true })
  await writeFile(join(root, '.orchestration/recipes.json'), JSON.stringify({ setup: ['echo ready > prepared.txt'], baseline: 'test -f prepared.txt' }))
  await writeFile(join(root, 'task-t1.md'), '<task>write tests</task>\n')
})

const runDir = (id: string) => join(root, '.orchestration/runs', id)
const state = async (id: string) => JSON.parse(await readFile(join(runDir(id), 'state.json'), 'utf8'))
const until = async (fn: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) {
    if (await fn().catch(() => false)) return
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error('fake Devin timed out')
}
const ready = (id: string) => until(async () => (await readFile(join(runDir(id), 'events.jsonl'), 'utf8')).includes('tool_started'))
const finishRun = async (id: string) => {
  await ready(id)
  if ((await state(id)).status === 'running') await writeFile(join(runDir(id), 'mailbox', 'steer-finish.json'), JSON.stringify({id:'finish',text:'correction',mode:'auto',status:'accepted'}))
  await until(async () => (await state(id)).status === 'completed')
  await writeFile(join(runDir(id), 'state.json'), JSON.stringify({...await state(id),finishedAt:'2026-09-22T11:30:00Z'}))
}
// Runs a test leaves going — a relaunch as its last step, a failure mid-way — are stopped by core/test/process-reaper.ts.

describe('orch run lifecycle', () => {
  it('runs a task end to end: worktree, delegate, events, attention, review, gc', async () => {
    const h = makeHarness({ cwd: root, env, now: new Date('2026-09-22T11:09:00Z') })
    expect(await run(['init', '--goal', 'g'], h.io)).toBe(0)
    expect(await run(['task', 'add', 't1', '--title', 'Write tests', '--contract', 'task-t1.md'], h.io)).toBe(0)

    // 1. launch through orch run
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(0)
    const plan1 = await loadPlan(root)
    const task1 = plan1.tasks[0]
    const runId = task1?.runs[0]?.runId as string
    expect(runId).toMatch(/^run_devin-/)
    await ready(runId)
    expect(task1).toMatchObject({ worker: 'devin', worktree: { branch: 'orch/t1-write-tests' } })
    const rpc = (await readFile(join(task1!.worktree!.path, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    expect(rpc.find(m => m.method === 'session/new').params.cwd).toBe(task1?.worktree?.path)
    expect(rpc.find(m => m.method === 'session/prompt').params.prompt[0].text).toBe('<task>write tests</task>\n')

    // 2. running status and a second run is refused
    h.reset()
    expect(await run(['status', '--json'], h.io)).toBe(0)
    expect(JSON.parse(h.out()).views[0]).toMatchObject({ id: 't1', status: 'running', activeRunId: runId })
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(1)
    expect(h.err()).toContain('already running')

    // 3. meaningful feed
    h.reset()
    expect(await run(['events', 't1'], h.io)).toBe(0)
    expect(h.out()).toContain('read file')
    expect(h.out()).not.toContain('thinking')

    // 5. attention: the last event is at 11:13 with a problem, now 11:30 → stalled alert
    h.setNow(new Date(Date.now() + 20 * 60 * 1000))
    h.reset()
    expect(await run(['attention', '--json'], h.io)).toBe(0)
    expect(JSON.parse(h.out())).toMatchObject([{ kind: 'attention', alarm: 'stalled', taskId: 't1', runId }])
    h.reset()
    expect(await run(['attention', '--alarms', '--json'], h.io)).toBe(0)
    expect((JSON.parse(h.out()) as { kind: string }[]).map((a) => a.kind)).toContain('stalled')

    // 4. steer records a note and writes the direct mailbox
    expect(await run(['steer', 't1', '--message', 'Добавь тест на пустую строку'], h.io)).toBe(0)
    expect((await loadPlan(root)).tasks[0]?.notes.at(-1)).toMatchObject({ type: 'steer' })
    await until(async () => (await readdir(join(runDir(runId), 'steers'))).length > 0)
    const [steerFile] = await readdir(join(runDir(runId), 'steers'))
    expect(JSON.parse(await readFile(join(runDir(runId), 'steers', steerFile!), 'utf8')).preview).toContain('Добавь тест на пустую строку')

    // 6. finished run → in_review; no run alarm: waiting for acceptance is not a failure…
    await finishRun(runId)
    h.reset()
    expect(await run(['status', '--json'], h.io)).toBe(0)
    expect(JSON.parse(h.out()).views[0].status).toBe('in_review')
    h.reset()
    await run(['attention', '--alarms', '--json'], h.io)
    expect(JSON.parse(h.out())).toEqual([])
    // …but it waits on the person, so the «Needs you» set lists it (nq1).
    h.reset()
    await run(['attention', '--json'], h.io)
    expect(JSON.parse(h.out())).toMatchObject([{ kind: 'review', taskId: 't1' }])

    // 7. cost shows the duration
    h.reset()
    expect(await run(['cost', '--json'], h.io)).toBe(0)
    expect(JSON.parse(h.out()).runs[0]).toMatchObject({ runId, agent: 'devin', durationSec: 1260 })

    // 8. accept (human), then gc keeps the dirty worktree unless forced
    const human = makeHarness({ cwd: root, env, isTTY: true, answers: ['y', 'y'] })
    expect(await run(['accept', 't1'], human.io)).toBe(0)
    h.reset()
    expect(await run(['--lang', 'ru', 'worktree', 'gc'], h.io)).toBe(0)
    expect(h.out()).toContain('оставлен')
    const wtPath = (await loadPlan(root)).tasks[0]?.worktree?.path as string
    expect(await stat(wtPath).then(() => true)).toBe(true)
    expect(await run(['worktree', 'gc', '--force', 't1'], h.io)).toBe(1)
    expect(await run(['worktree', 'gc', '--force', 't1'], human.io)).toBe(0)
    expect(await stat(wtPath).then(() => true, () => false)).toBe(false)
  })

  it('refuses a finished run, retains the direction, and relaunches only with the explicit flag', async () => {
    const h = makeHarness({ cwd: root, env, now: new Date('2026-09-22T11:30:00Z') })
    await run(['init', '--goal', 'g'], h.io)
    await run(['task', 'add', 't1', '--title', 'Write tests', '--contract', 'task-t1.md'], h.io)
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(0)
    const oldId = (await loadPlan(root)).tasks[0]?.runs[0]?.runId as string
    await finishRun(oldId)
    h.reset()
    expect(await run(['steer', 't1', '--message', 'keep the original text'], h.io)).toBe(1)
    expect(h.err()).toContain('completed')
    expect((await loadPlan(root)).tasks[0]?.runs).toHaveLength(1)
    const files = await readdir(join(root, '.orchestration/steers'))
    const retained = join(root, '.orchestration/steers', files[0] as string)
    expect(await readFile(retained, 'utf8')).toBe('keep the original text\n')
    h.reset()
    expect(await run(['steer', 't1', '--file', retained, '--relaunch', '--skip-preflight'], h.io), h.err()).toBe(0)
    expect((await loadPlan(root)).tasks[0]?.runs).toHaveLength(2)
    const prompts = await readdir(join(root, '.orchestration/relaunch'))
    expect(await readFile(join(root, '.orchestration/relaunch', prompts[0] as string), 'utf8')).toContain('Указание человека: keep the original text')
  })

  // vr1: finished work goes to the orchestrator first; --return relaunches with the findings.
  it('orchestrator check: verify, return with findings, done, then a checked acceptance', async () => {
    const h = makeHarness({ cwd: root, env, now: new Date('2026-09-22T11:30:00Z') })
    await run(['init', '--goal', 'g'], h.io)
    await run(['task', 'add', 't1', '--title', 'Write tests', '--contract', 'task-t1.md'], h.io)
    await writeFile(join(root, '.orchestration/settings.json'), JSON.stringify({ orchestratorCheck: true }))
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(0)
    await finishRun((await loadPlan(root)).tasks[0]?.runs[0]?.runId as string)
    h.reset()
    await run(['status', '--json'], h.io)
    expect(JSON.parse(h.out()).views[0]).toMatchObject({ status: 'in_review', check: 'pending' })
    expect(await run(['verify', 't1'], h.io)).toBe(0)
    expect((await loadPlan(root)).tasks[0]?.check).toMatchObject({ state: 'checking', by: 'orchestrator' })
    h.reset()
    expect(await run(['verify', 't1', '--return', 'the empty-string case is untested', '--skip-preflight'], h.io), h.err()).toBe(0)
    const plan = await loadPlan(root)
    expect(plan.tasks[0]?.runs).toHaveLength(2)
    expect(plan.tasks[0]?.check).toBeUndefined()
    const prompts = await readdir(join(root, '.orchestration/relaunch'))
    expect(await readFile(join(root, '.orchestration/relaunch', prompts[0] as string), 'utf8')).toContain('Замечания оркестратора по проверке: the empty-string case is untested')
    await finishRun(plan.tasks[0]?.runs[1]?.runId as string)
    await run(['status'], h.io)
    expect(await run(['verify', 't1', '--done'], h.io)).toBe(2)
    expect(await run(['verify', 't1', '--done', '--note', 'tests green, stand ok'], h.io)).toBe(0)
    const human = makeHarness({ cwd: root, env, isTTY: true, answers: ['y'] })
    expect(await run(['accept', 't1'], human.io)).toBe(0)
    expect((await loadPlan(root)).tasks[0]?.notes.find((n) => n.type === 'accept')).toMatchObject({ check: 'checked' })
    expect(await run(['verify', 't1'], h.io)).toBe(1)
  })

  it('stop cancels the active run', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init'], h.io)
    await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task-t1.md'], h.io)
    await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)
    expect(await run(['stop', 't1'], h.io)).toBe(0)
    const id=(await loadPlan(root)).tasks[0]!.runs[0]!.runId
    await until(async () => (await state(id)).status === 'cancelled')
  })

  it('refuses to run a blocked task, a decision and a red baseline', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init'], h.io)
    await run(['task', 'add', 'plan', '--title', 'План', '--kind', 'decision'], h.io)
    await run(['task', 'add', 't1', '--title', 'T', '--deps', 'plan', '--contract', 'task-t1.md'], h.io)
    expect(await run(['run', 'plan', '-a', 'devin', '--skip-preflight'], h.io)).toBe(1)
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(1)
    expect(h.err()).toContain('waiting for: plan')

    await run(['task', 'add', 't2', '--title', 'T2', '--contract', 'task-t1.md'], h.io)
    await writeFile(join(root, '.orchestration/recipes.json'), JSON.stringify({ baseline: 'exit 1' }))
    h.reset()
    expect(await run(['run', 't2', '-a', 'devin', '--skip-preflight'], h.io)).toBe(1)
    expect(h.err()).toContain('baseline run is red')
  })

  it('a red baseline refuses every launch of the reused copy until its cause is fixed (bl1)', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init'], h.io)
    await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task-t1.md'], h.io)
    await writeFile(join(root, '.orchestration/recipes.json'), JSON.stringify({ baseline: 'test -f fixed.txt' }))
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(1)
    h.reset()
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(1)
    expect(h.err()).toContain('baseline run is red')
    h.reset()
    expect(await run(['worktree', 'list'], h.io)).toBe(0)
    expect(h.out()).toMatch(/baseline ✗ [0-9a-f]{7}/)

    await writeFile(join(root, 'fixed.txt'), 'ok\n')
    execFileSync('git', ['-C', root, 'add', 'fixed.txt'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'fix the cause'])
    h.reset()
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], h.io)).toBe(0)
    h.reset()
    expect(await run(['worktree', 'list'], h.io)).toBe(0)
    expect(h.out()).toMatch(/baseline ✓ [0-9a-f]{7}/)
  })

  it('preflight fails fast on an unknown profile', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init'], h.io)
    expect(await run(['preflight', '-a', 'ghost'], h.io)).toBe(1)
    expect(h.err()).toContain('ghost')
  })
})
