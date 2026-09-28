import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import type { Backends } from '../src/orchestration/backends.js'
import { finishCheck } from '../src/orchestration/check.js'
import { lastDecisionOf } from '../src/orchestration/decision.js'
import { needsYou } from '../src/orchestration/needs-you.js'
import { acceptTasks, answerDecision, prepareDecision } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { deriveViews, waitsForHuman } from '../src/plan/graph.js'
import { type Task, newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-26T12:00:00Z')
const LATER = new Date('2026-09-26T12:30:00Z')

const backend: RunBackend = {
  id: 'dsh',
  launch: async () => 'run_dsh-x',
  events: async () => [],
  status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
  steer: async () => {},
  cancel: async () => {},
}
const backends: Backends = { forAgent: async () => backend }

/** A plan with one closed worker task, a decision on it and a dependent waiting for the decision. */
async function setup(chat = false) {
  const root = await makeRepo()
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(
      { ...newTask({ id: 'w1', title: 'W1' }), status: 'accepted' as const },
      newTask({ id: 'd1', title: 'Pick a store', kind: 'decision', deps: ['w1'] }),
      newTask({ id: 'dep', title: 'Uses the store', deps: ['d1'] }),
    )
    return p
  })
  if (chat) {
    await mkdir(join(root, '.orchestration'), { recursive: true })
    await writeFile(join(root, '.orchestration', 'chats.json'), JSON.stringify({ main: { sessionId: 's1', wake: true, boundAt: NOW.toISOString() } }))
  }
  return root
}

const task = async (root: string, id: string): Promise<Task> => (await loadPlan(root)).tasks.find((t) => t.id === id) as Task
const view = async (root: string, id: string, prepareDecisions = false) => deriveViews(await loadPlan(root), {}, { prepareDecisions }).find((v) => v.task.id === id)!
const needsYouIds = async (root: string) => needsYou([await buildRepoSnapshot(root, backends, NOW)]).filter((item) => !item.background).map((item) => `${item.kind}:${item.taskId}`)

describe('decision answer — the chat answer recorded by the orchestrator (dc1)', () => {
  it('records the answer and its basis, closes the decision and unblocks dependents', async () => {
    const root = await setup(true)
    await finishCheck(root, 'd1', 'A: sqlite; B: postgres. Recommend A.', NOW, { by: 'orchestrator' })
    expect(await needsYouIds(root)).toEqual(['decision:d1'])
    expect(await view(root, 'dep')).toMatchObject({ status: 'blocked', blockedBy: ['d1'] })

    const { task: answered, repeated } = await answerDecision(root, 'd1', 'Option A — sqlite', 'user message: “take A”', LATER)
    expect(repeated).toBe(false)
    expect(answered.status).toBe('accepted')
    expect(answered.notes.at(-1)).toMatchObject({
      type: 'accept',
      event: { kind: 'answered', answer: 'Option A — sqlite', basis: 'user message: “take A”', by: 'orchestrator' },
    })
    // The record is honest about who wrote it: the person answered, the orchestrator recorded.
    expect(lastDecisionOf(answered)).toMatchObject({ verdict: 'answered', by: 'orchestrator', answer: 'Option A — sqlite', basis: 'user message: “take A”' })
    // The dependent is free now; nothing waits on the person.
    expect(await view(root, 'dep')).toMatchObject({ status: 'ready', blockedBy: [] })
    expect(await needsYouIds(root)).toEqual([])
  })

  it('repeating the recorded answer is a no-op; a different one on the closed decision is refused', async () => {
    const root = await setup(true)
    await answerDecision(root, 'd1', 'Option A', 'chat message 12', NOW)
    const rev = (await loadPlan(root)).rev
    const again = await answerDecision(root, 'd1', 'Option A', 'chat message 12', LATER)
    expect(again.repeated).toBe(true)
    const plan = await loadPlan(root)
    expect(plan.rev).toBe(rev)
    expect(plan.tasks.find((t) => t.id === 'd1')?.notes.filter((n) => n.type === 'accept')).toHaveLength(1)
    await expect(answerDecision(root, 'd1', 'Option B', 'chat message 13', LATER)).rejects.toMatchObject({ code: 'decision_conflict' })
    await expect(answerDecision(root, 'd1', 'Option A', 'another basis', LATER)).rejects.toMatchObject({ code: 'decision_conflict' })
  })

  it('refuses non-decisions, closed decisions, an unfinished run and empty fields', async () => {
    const root = await setup()
    await updatePlan(root, (p) => {
      p.tasks.push(
        { ...newTask({ id: 'gone', title: 'G', kind: 'decision' }), status: 'dropped' as const },
        { ...newTask({ id: 'old', title: 'O', kind: 'decision' }), status: 'accepted' as const },
        { ...newTask({ id: 'live', title: 'L', kind: 'decision' }), runs: [{ runId: 'run_dsh-live', agent: 'dsh', startedAt: NOW.toISOString() }] },
      )
      return p
    })
    await expect(answerDecision(root, 'nope', 'a', 'b', NOW)).rejects.toMatchObject({ code: 'unknown_task' })
    await expect(answerDecision(root, 'w1', 'a', 'b', NOW)).rejects.toMatchObject({ code: 'not_decision' })
    await expect(answerDecision(root, 'dep', 'a', 'b', NOW)).rejects.toMatchObject({ code: 'not_decision' })
    await expect(answerDecision(root, 'gone', 'a', 'b', NOW)).rejects.toMatchObject({ code: 'decision_closed' })
    // Closed by a panel click, not by a chat answer: no recorded answer to repeat — refused as a conflict.
    await expect(answerDecision(root, 'old', 'a', 'b', NOW)).rejects.toMatchObject({ code: 'decision_conflict' })
    await expect(answerDecision(root, 'live', 'a', 'b', NOW)).rejects.toMatchObject({ code: 'running' })
    await expect(answerDecision(root, 'd1', '', 'b', NOW)).rejects.toMatchObject({ code: 'answer_fields' })
    await expect(answerDecision(root, 'd1', 'a', '  ', NOW)).rejects.toMatchObject({ code: 'answer_fields' })
    expect((await task(root, 'd1')).status).toBe('ready')
  })

  it('a decision answered without the orchestrator check still closes', async () => {
    const root = await setup()
    await answerDecision(root, 'd1', 'A', 'the person said so in chat', NOW)
    expect((await task(root, 'd1')).status).toBe('accepted')
  })
})

describe('decision prepare — back to the orchestrator at the person’s word (dc1)', () => {
  // Regression: the queue must empty even where the orchestrator check setting is off or no chat is bound —
  // preparation follows the explicit `decision_prepare` record, not `prepareDecisions`.
  it('leaves the person’s queue without a bound chat, while a legacy open decision still waits', async () => {
    const root = await setup(false)
    await finishCheck(root, 'd1', 'A or B, recommend A', NOW, { by: 'orchestrator' })
    // The older rule before any prepare record: the open decision waits for the person.
    expect(await view(root, 'd1')).toMatchObject({ status: 'ready', check: 'checked' })
    expect((await view(root, 'd1')).preparing).toBeUndefined()
    expect(await needsYouIds(root)).toEqual(['decision:d1'])

    await prepareDecision(root, 'd1', 'person asked to compare latency too', LATER, { by: 'orchestrator' })
    // No `prepareDecisions` option — the record alone marks preparation.
    const after = await view(root, 'd1')
    expect(after).toMatchObject({ status: 'ready', preparing: true })
    expect(waitsForHuman({ status: after.status, kind: after.task.kind, check: after.check, preparing: after.preparing })).toBe(false)
    expect(await needsYouIds(root)).toEqual([])
    expect(await view(root, 'dep')).toMatchObject({ status: 'blocked', blockedBy: ['d1'] })
    // A decision that never carried the record still waits — the record is what hides it.
    await updatePlan(root, (p) => { p.tasks.push(newTask({ id: 'd9', title: 'Other question', kind: 'decision' })); return p })
    expect(await needsYouIds(root)).toEqual(['decision:d9'])
    // A fresh preparation («checked» newer than the record) hands it back to the person.
    await finishCheck(root, 'd1', 'recommendation updated', LATER, { by: 'orchestrator' })
    expect((await view(root, 'd1')).preparing).toBeUndefined()
  })

  it('keeps the earlier report path on the record, not as the current proposal', async () => {
    const root = await setup(true)
    await finishCheck(root, 'd1', 'A or B, recommend A', NOW, { by: 'orchestrator', report: 'Result: received\n- [x] options compared\n' })
    expect((await task(root, 'd1')).check?.report).toBe('.orchestration/reports/main/d1.md')
    const prepared = await prepareDecision(root, 'd1', 'compare latency too', LATER, { by: 'orchestrator' })
    expect(prepared.check).toBeUndefined()
    expect(prepared.notes.at(-1)?.event).toMatchObject({ kind: 'decision_prepare', reason: 'compare latency too', report: '.orchestration/reports/main/d1.md' })
    // Detail no longer presents it as the current proposal: the check that carried it is gone.
    expect((await task(root, 'd1')).check).toBeUndefined()
  })

  it('clears readiness and leaves the person’s queue, keeping the brief and the notes as history', async () => {
    const root = await setup(true)
    await updatePlan(root, (p) => {
      p.tasks.find((t) => t.id === 'd1')!.contract = 'decision.md'
      return p
    })
    await finishCheck(root, 'd1', 'A or B, recommend A', NOW, { by: 'orchestrator' })
    expect(await needsYouIds(root)).toEqual(['decision:d1'])

    const task = await prepareDecision(root, 'd1', 'person asked to compare latency too', LATER, { by: 'orchestrator' })
    expect(task.check).toBeUndefined()
    expect(task.started).toBeUndefined()
    expect(task.contract).toBe('decision.md')
    // History stays: the earlier «prepared» note and the new prepare record.
    expect(task.notes.map((n) => n.event?.kind)).toEqual(['checked', 'decision_prepare'])
    expect(lastDecisionOf(task)).toMatchObject({ verdict: 'sent_back', by: 'orchestrator', reason: 'person asked to compare latency too' })

    const after = await view(root, 'd1', true)
    expect(after).toMatchObject({ status: 'ready', preparing: true })
    expect(waitsForHuman({ status: after.status, kind: after.task.kind, check: after.check, preparing: after.preparing })).toBe(false)
    expect(await needsYouIds(root)).toEqual([])
    // Dependents stay blocked: nothing was answered.
    expect(await view(root, 'dep', true)).toMatchObject({ status: 'blocked', blockedBy: ['d1'] })
  })

  it('an unprepared open decision stays open and records the instruction', async () => {
    const root = await setup(true)
    const task = await prepareDecision(root, 'd1', 'look into option C first', NOW, { by: 'orchestrator' })
    expect(task.status).toBe('ready')
    expect(task.notes.at(-1)).toMatchObject({ event: { kind: 'decision_prepare', reason: 'look into option C first', by: 'orchestrator' } })
    expect(await view(root, 'd1', true)).toMatchObject({ status: 'ready', preparing: true })
    expect(await needsYouIds(root)).toEqual([])
  })

  it('refuses closed decisions, non-decisions and a missing instruction', async () => {
    const root = await setup()
    await answerDecision(root, 'd1', 'A', 'chat', NOW)
    await updatePlan(root, (p) => {
      p.tasks.push({ ...newTask({ id: 'sup', title: 'S', kind: 'decision' }), status: 'superseded' as const })
      return p
    })
    await expect(prepareDecision(root, 'd1', 'again', NOW)).rejects.toMatchObject({ code: 'decision_closed' })
    await expect(prepareDecision(root, 'sup', 'again', NOW)).rejects.toMatchObject({ code: 'decision_closed' })
    await expect(prepareDecision(root, 'w1', 'again', NOW)).rejects.toMatchObject({ code: 'not_decision' })
    await expect(prepareDecision(root, 'nope', 'again', NOW)).rejects.toMatchObject({ code: 'unknown_task' })
    const open = await setup()
    await expect(prepareDecision(open, 'd1', '   ', NOW)).rejects.toMatchObject({ code: 'prepare_reason' })
  })
})

// dc1: a decision never closes through the batch path — the mixed list is refused atomically.
describe('batch acceptance refuses decisions atomically (dc1)', () => {
  it('a decision in the list refuses the whole batch before any write', async () => {
    const root = await setup()
    const rev = (await loadPlan(root)).rev
    await expect(acceptTasks(root, ['dep', 'd1'], NOW)).rejects.toMatchObject({ code: 'decision_in_batch' })
    const plan = await loadPlan(root)
    expect(plan.rev).toBe(rev)
    expect(plan.tasks.find((t) => t.id === 'dep')?.status).toBe('ready')
    expect(plan.tasks.find((t) => t.id === 'd1')?.status).toBe('ready')
  })

  it('worker tasks still batch together', async () => {
    const root = await setup()
    await updatePlan(root, (p) => {
      p.tasks.push(newTask({ id: 'w2', title: 'W2' }))
      return p
    })
    expect(await acceptTasks(root, ['dep', 'w2'], NOW)).toEqual(['dep', 'w2'])
  })
})
