import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { CheckError, finishCheck, ownReportRef, returnFromCheck, setTaskKind, startOwnWork, takeCheck } from '../src/orchestration/check.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { LaunchError, launchTask } from '../src/orchestration/launch.js'
import { needsYou } from '../src/orchestration/needs-you.js'
import { acceptTask, rejectTask } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { deriveViews, readySet, waitsForHuman } from '../src/plan/graph.js'
import { type Task, newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, planPath, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-24T12:00:00Z')
const LATER = new Date('2026-09-24T12:30:00Z')

const backend: RunBackend = {
  id: 'dsh',
  launch: async () => 'run_dsh-x',
  events: async () => [],
  status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
  steer: async () => {},
  cancel: async () => {},
}
const backends: Backends = { forAgent: async () => backend }

async function setup(tasks: Task[], chat = false) {
  const root = await makeRepo()
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => ({ ...p, tasks }))
  if (chat) {
    await mkdir(join(root, '.orchestration'), { recursive: true })
    await writeFile(join(root, '.orchestration', 'chats.json'), JSON.stringify({ main: { sessionId: 's1', wake: true, boundAt: NOW.toISOString() } }))
  }
  return root
}

const view = async (root: string, id: string, prepareDecisions = false) => deriveViews(await loadPlan(root), {}, { prepareDecisions }).find((v) => v.task.id === id)!
const waits = (v: Awaited<ReturnType<typeof view>>) => waitsForHuman({ status: v.status, kind: v.task.kind, check: v.check, preparing: v.preparing })
const needsYouIds = async (root: string) => {
  const snap = await buildRepoSnapshot(root, backends, NOW)
  return needsYou([snap]).filter((item) => !item.background).map((item) => `${item.kind}:${item.taskId}`)
}

const REPORT = ['Result: received', '', '## Checks', '- [x] pnpm test — passed', '- [ ] open the stand at /health', '', 'Evidence: commit abc123, log stand.log', 'Reproduce: pnpm stand && curl /health'].join('\n')

describe('root tasks — the orchestrator’s own work (rt1)', () => {
  it('walks ready → start → verify --done --report → in review, checked → accepted', async () => {
    const root = await setup([newTask({ id: 'i1', title: 'Integrate on the stand', kind: 'root' })], true)
    expect(await view(root, 'i1')).toMatchObject({ status: 'ready' })
    expect(readySet(deriveViews(await loadPlan(root)))).toEqual([])
    expect(await needsYouIds(root)).toEqual([])

    await startOwnWork(root, 'i1', NOW, { by: 'orchestrator' })
    const started = await view(root, 'i1')
    expect(started).toMatchObject({ status: 'running', byOrchestrator: true })
    expect(started.activeRunId).toBeUndefined()
    expect(waits(started)).toBe(false)
    const snap = await buildRepoSnapshot(root, backends, NOW)
    expect(snap.tasks[0]).toMatchObject({ status: 'running', byOrchestrator: true, activeSince: NOW.toISOString() })
    expect(await needsYouIds(root)).toEqual([])
    // Starting again is harmless.
    await startOwnWork(root, 'i1', LATER)
    expect((await loadPlan(root)).tasks[0]?.started?.at).toBe(NOW.toISOString())

    const task = await finishCheck(root, 'i1', 'integrated on the stand', LATER, { by: 'orchestrator', report: REPORT })
    expect(task).toMatchObject({ status: 'in_review', check: { state: 'checked', note: 'integrated on the stand', report: ownReportRef('main', 'i1') } })
    expect(await readFile(join(root, ownReportRef('main', 'i1')), 'utf8')).toContain('Result: received')
    const done = await view(root, 'i1')
    expect(done).toMatchObject({ status: 'in_review', check: 'checked' })
    expect(waits(done)).toBe(true)
    expect(await needsYouIds(root)).toEqual(['review:i1'])
    expect(needsYou([await buildRepoSnapshot(root, backends, NOW)])[0]).toMatchObject({ kind: 'review', checked: true })

    const detail = await getTaskDetail(root, 'i1', backends, nodeExec)
    expect(detail.report).toMatchObject({ source: 'orchestrator', runId: '' })
    expect(detail.report?.text).toContain('Reproduce:')
    expect(detail.verdict).toMatchObject({ kind: 'result', claim: 'result' })

    await acceptTask(root, 'i1', LATER, detail.verdict)
    const accepted = (await loadPlan(root)).tasks[0]!
    expect(accepted.status).toBe('accepted')
    expect(accepted.notes.at(-1)).toMatchObject({ type: 'accept', check: 'checked', verdict: { kind: 'result' } })
    expect(accepted.reviewIntervals?.at(-1)).toMatchObject({ decision: 'accepted', association: 'task_only' })
  })

  it('without a report the note is the report; a missing Result line is disputed, as for a worker', async () => {
    const root = await setup([newTask({ id: 'i1', title: 'I1', kind: 'root' })])
    await startOwnWork(root, 'i1', NOW)
    await finishCheck(root, 'i1', 'did it', LATER)
    expect((await getTaskDetail(root, 'i1', backends, nodeExec)).verdict).toMatchObject({ kind: 'disputed', mismatch: 'claim_missing' })
    await finishCheck(root, 'i1', 'Result: received\nstand is up', LATER)
    const detail = await getTaskDetail(root, 'i1', backends, nodeExec)
    // No worker copy to count files in: a claimed result without files is not disputed for the orchestrator's work.
    expect(detail.verdict).toMatchObject({ kind: 'result' })
    expect(detail.verdict?.mismatch).toBeUndefined()
  })

  it('send back returns it to ready with the reason; it is started again', async () => {
    const root = await setup([newTask({ id: 'i1', title: 'I1', kind: 'root' })], true)
    await startOwnWork(root, 'i1', NOW)
    await finishCheck(root, 'i1', 'Result: received', NOW)
    await rejectTask(root, 'i1', 'the stand still answers 500', LATER)
    const back = await view(root, 'i1')
    expect(back).toMatchObject({ status: 'ready' })
    expect(back.task).toMatchObject({ status: 'rejected' })
    expect(back.task.started).toBeUndefined()
    expect(back.task.check).toBeUndefined()
    expect(back.task.notes.at(-1)).toMatchObject({ type: 'reject', text: 'the stand still answers 500' })
    expect(await needsYouIds(root)).toEqual([])
    await startOwnWork(root, 'i1', LATER)
    expect(await view(root, 'i1')).toMatchObject({ status: 'running', byOrchestrator: true })
  })

  it('refuses what does not fit the lifecycle', async () => {
    const root = await setup([
      newTask({ id: 'a', title: 'A' }),
      newTask({ id: 'i1', title: 'I1', kind: 'root', deps: ['a'] }),
      newTask({ id: 'w', title: 'W' }),
    ])
    await expect(startOwnWork(root, 'i1', NOW)).rejects.toMatchObject({ code: 'not_ready' })
    await expect(finishCheck(root, 'i1', 'x', NOW)).rejects.toMatchObject({ code: 'not_ready' })
    await expect(startOwnWork(root, 'w', NOW)).rejects.toMatchObject({ code: 'not_root' })
    await expect(finishCheck(root, 'w', 'x', NOW, { report: 'Result: received' })).rejects.toMatchObject({ code: 'report_for_worker' })
    await expect(takeCheck(root, 'i1', NOW)).rejects.toMatchObject({ code: 'own_work' })
    await expect(returnFromCheck({ root, taskId: 'i1', findings: 'x', backends, exec: nodeExec, env: {}, home: root, now: () => NOW })).rejects.toBeInstanceOf(CheckError)
  })

  it('run refuses a root task with a clear message and launches no worker', async () => {
    const root = await setup([newTask({ id: 'i1', title: 'I1', kind: 'root', contract: 'c.md' })])
    let launched = false
    const watching: Backends = { forAgent: async () => ({ ...backend, launch: async () => { launched = true; return 'run_dsh-y' } }) }
    const err = await launchTask({ root, taskId: 'i1', backends: watching, exec: nodeExec, env: {}, home: root, now: () => NOW, lang: 'en' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LaunchError)
    expect(err).toMatchObject({ code: 'root', vars: { id: 'i1' } })
    expect((err as Error).message).toMatch(/start i1/)
    expect(launched).toBe(false)
    expect((await loadPlan(root)).tasks[0]?.runs).toEqual([])
  })
})

describe('decisions reach the person only once prepared (rt1)', () => {
  const plan = () => [
    { ...newTask({ id: 'h1', title: 'H1' }), status: 'accepted' as const },
    newTask({ id: 'h4', title: 'Pick the integration', kind: 'decision', deps: ['h1'] }),
  ]

  it('with an orchestrator chat, closed dependencies alone are not enough', async () => {
    const root = await setup(plan(), true)
    const before = await view(root, 'h4', true)
    expect(before).toMatchObject({ status: 'ready', preparing: true })
    expect(waits(before)).toBe(false)
    expect(await needsYouIds(root)).toEqual([])
    const snap = await buildRepoSnapshot(root, backends, NOW)
    expect(snap.tasks.find((t) => t.id === 'h4')).toMatchObject({ preparing: true })
    expect(snap.plans?.[0]?.waitingHuman).toBe(0)

    await finishCheck(root, 'h4', 'A: keep the stand; B: move it. Recommend A.', NOW, { by: 'orchestrator' })
    const after = await view(root, 'h4', true)
    expect(after).toMatchObject({ status: 'ready', check: 'checked' })
    expect(after.preparing).toBeUndefined()
    expect(waits(after)).toBe(true)
    expect(await needsYouIds(root)).toEqual(['decision:h4'])
    expect((await buildRepoSnapshot(root, backends, NOW)).tasks.find((t) => t.id === 'h4')).toMatchObject({ check: 'checked', checkNote: 'A: keep the stand; B: move it. Recommend A.' })
  })

  it('a mark made while dependencies are open waits for them', async () => {
    const root = await setup([newTask({ id: 'h1', title: 'H1' }), newTask({ id: 'h4', title: 'H4', kind: 'decision', deps: ['h1'] })], true)
    await finishCheck(root, 'h4', 'options', NOW)
    expect(await view(root, 'h4', true)).toMatchObject({ status: 'blocked' })
    expect(await needsYouIds(root)).toEqual([])
  })

  it('a plan without an orchestrator chat keeps the older rule', async () => {
    const root = await setup(plan())
    const v = await view(root, 'h4', false)
    expect(v.preparing).toBeUndefined()
    expect(waits(v)).toBe(true)
    expect(await needsYouIds(root)).toEqual(['decision:h4'])
  })

  it('a decision has no verdict, with or without a report (w1b, B05)', async () => {
    const root = await setup(plan(), true)
    const blank = await getTaskDetail(root, 'h4', backends, nodeExec)
    expect(blank.report).toBeUndefined()
    expect(blank.verdict).toBeUndefined()
    await finishCheck(root, 'h4', 'options', NOW, { report: 'Result: received\n- [ ] read the stand log' })
    const detail = await getTaskDetail(root, 'h4', backends, nodeExec)
    expect(detail.report).toMatchObject({ source: 'orchestrator' })
    expect(detail.verdict).toBeUndefined()
    // A later --done without a report keeps the stored one.
    await finishCheck(root, 'h4', 'options, revised', LATER)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'h4')?.check).toMatchObject({ note: 'options, revised', report: ownReportRef('main', 'h4') })
  })

  it('sending a decision back makes it need preparing again', async () => {
    const root = await setup(plan(), true)
    await finishCheck(root, 'h4', 'options', NOW)
    await rejectTask(root, 'h4', 'add option C', LATER)
    expect(await view(root, 'h4', true)).toMatchObject({ status: 'ready', preparing: true })
    expect(await needsYouIds(root)).toEqual([])
  })
})

describe('task set --kind (rt1)', () => {
  it('turns an open decision into a root task, dropping what belonged to the old kind', () => {
    const task: Task = { ...newTask({ id: 'i1', title: 'I1', kind: 'decision' }), check: { state: 'checked', at: NOW.toISOString(), note: 'n' } }
    setTaskKind(task, 'root')
    expect(task.kind).toBe('root')
    expect(task.check).toBeUndefined()
  })

  it('a root task in review goes back to ready when it stops being root work', () => {
    const task: Task = { ...newTask({ id: 'i1', title: 'I1', kind: 'root' }), status: 'in_review', started: { at: NOW.toISOString() }, check: { state: 'checked', at: NOW.toISOString(), note: 'n' } }
    setTaskKind(task, 'implement')
    expect(task).toMatchObject({ kind: 'implement', status: 'ready' })
    expect(task.started).toBeUndefined()
  })

  it('keeps a worker’s run check and refuses accepted or superseded tasks', () => {
    const worker: Task = { ...newTask({ id: 'w', title: 'W' }), status: 'in_review', check: { state: 'checked', runId: 'run_a', at: NOW.toISOString() } }
    setTaskKind(worker, 'review')
    expect(worker.check).toMatchObject({ runId: 'run_a' })
    for (const status of ['accepted', 'superseded'] as const) {
      const closed: Task = { ...newTask({ id: 'c', title: 'C', kind: 'decision' }), status }
      expect(() => setTaskKind(closed, 'root')).toThrow(CheckError)
      expect(closed.kind).toBe('decision')
    }
  })
})

describe('an older build meets a root task (rt1 × pq1)', () => {
  it('a task kind this build does not know makes the plan incompatible — the update message, no quarantine copy', async () => {
    // What an older build meets in a root task: a kind outside its closed set. `kind` stays strict, so it
    // must refuse to read (a guess would launch a worker on the orchestrator's work), never quarantine.
    const root = await setup([newTask({ id: 'i1', title: 'I1', kind: 'root' })])
    const raw = JSON.parse(await readFile(planPath(root), 'utf8'))
    await writeFile(planPath(root), JSON.stringify({ ...raw, tasks: [{ ...raw.tasks[0], kind: 'root-next', started: { at: NOW.toISOString() } }] }))
    const err = await loadPlan(root).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'PlanIncompatibleError', code: 'plan_incompatible', mode: 'read' })
    expect((err as Error).message).toMatch(/update Crewboard/)
    expect((err as Error).message).toContain('tasks.0.kind="root-next"')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(join(root, '.orchestration'))).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })

  it('this build reads and writes a root task with its new fields', async () => {
    const root = await setup([newTask({ id: 'i1', title: 'I1', kind: 'root' })])
    await startOwnWork(root, 'i1', NOW, { by: 'orchestrator' })
    await finishCheck(root, 'i1', 'Result: received', LATER, { report: REPORT })
    const stored = JSON.parse(await readFile(planPath(root), 'utf8')).tasks[0]
    expect(stored).toMatchObject({ kind: 'root', status: 'in_review', started: { at: NOW.toISOString(), by: 'orchestrator' }, check: { state: 'checked', report: ownReportRef('main', 'i1') } })
    expect(stored.notes.map((n: { event?: { kind: string } }) => n.event?.kind)).toEqual(['started', 'checked'])
  })
})
