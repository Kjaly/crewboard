import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Backends, acceptTask, answerDecision, buildRepoSnapshot, createPlan, dropTask, eventNote, initPlan, newTask, prepareDecision, rejectTask, updatePlan } from '@crewboard/core'
import { createChatWaker, writeChats } from '../src/host/chat.js'
import type { SessionControllerFace } from '../src/host/dsh.js'
import type { OrchestraSnapshot } from '../src/shared/types.js'

const NOW = new Date('2026-09-25T12:00:00Z')
const idle: Backends = { forAgent: async () => Promise.reject(new Error('none')) }

function fakeSessions() {
  const prompts: Array<{ sessionId: string; text: string }> = []
  const sessions: SessionControllerFace = {
    create: async () => ({ sessionId: 'sess-new' }),
    prompt: async (request) => {
      prompts.push({ sessionId: request.sessionId, text: request.content[0]?.text ?? '' })
      return { accepted: true }
    },
    inspect: async (sessionId) => ({ sessionId }),
  }
  return { sessions, prompts }
}

function manualSchedule() {
  const queue: Array<() => unknown> = []
  return {
    schedule: (fn: () => void) => {
      queue.push(fn)
      return queue.length
    },
    run: async () => {
      await queue.at(-1)?.()
    },
  }
}

/** A repository whose current plan is `main`; the plan under test (`main` or the background `side`) holds t1, d1 and m1. */
async function repoWith(planId: 'main' | 'side') {
  const root = await mkdtemp(join(tmpdir(), 'orch-wk1-'))
  await initPlan(root, 'Main plan', NOW)
  if (planId === 'side') await createPlan(root, 'side', 'Side plan', NOW)
  await updatePlan(root, (plan) => {
    plan.tasks.push({ ...newTask({ id: 't1', title: 'Parser', contract: 'c.md' }), status: 'in_review', runs: [{ runId: 'run_dsh-1', agent: 'dsh', startedAt: '2026-09-25T10:00:00Z', finishedAt: '2026-09-25T10:10:00Z', outcome: 'completed' }] })
    plan.tasks.push({ ...newTask({ id: 'd1', title: 'Pick a store', kind: 'decision' }), status: 'in_review' })
    plan.tasks.push({ ...newTask({ id: 'm1', title: 'Merged work', contract: 'c.md' }), status: 'accepted' })
    return plan
  }, 5, planId)
  await writeChats(root, { [planId]: { sessionId: `sess-${planId}`, wake: true, boundAt: 't' } })
  return root
}

const snap = async (root: string): Promise<OrchestraSnapshot> => ({ generatedAt: 't', repos: [await buildRepoSnapshot(root, idle, NOW)], workers: [] })

type Decide = (root: string, planId: string) => Promise<unknown>
const note = (taskId: string, make: () => ReturnType<typeof eventNote>): Decide => (root, planId) => updatePlan(root, (plan) => {
  plan.tasks.find((t) => t.id === taskId)?.notes.push(make())
  return plan
}, 5, planId)

const KINDS: Array<{ name: string; decide: Decide; line: string; head?: string }> = [
  { name: 'accept', decide: (root, planId) => acceptTask(root, 't1', NOW, undefined, undefined, planId), line: 't1 «Parser» — decision: accepted by the person' },
  { name: 'send back', decide: (root, planId) => rejectTask(root, 't1', 'the empty list crashes', NOW, planId), line: 't1 «Parser» — decision: sent back by the person — “the empty list crashes”; the next run gets this reason in its prompt' },
  { name: 'decision answer', decide: (root, planId) => acceptTask(root, 'd1', NOW, undefined, undefined, planId), line: 'd1 «Pick a store» — decision: answered by the person' },
  // dc1: the chat hears the recorded chat answer and a «study it and propose» return, each named honestly.
  { name: 'decision answer recorded from chat', decide: (root, planId) => answerDecision(root, 'd1', 'sqlite', 'user message 12', NOW, { planId }), line: 'd1 «Pick a store» — decision: answered by the person in chat — “sqlite” (recorded by the orchestrator)' },
  { name: 'decision back to preparation', decide: (root, planId) => prepareDecision(root, 'd1', 'research latency first', NOW, { planId, by: 'orchestrator' }), line: 'd1 «Pick a store» — decision: sent back to preparation by the person via the orchestrator — “research latency first”', head: '[crewboard] Orchestrator action needed' },
  { name: 'drop', decide: (root, planId) => dropTask(root, 't1', 'covered by t9', NOW, planId), line: 't1 «Parser» — decision: dropped by the person as not needed — “covered by t9”' },
  { name: 'merge', decide: note('m1', () => eventNote(NOW.toISOString(), 'comment', { kind: 'merged', into: 'main', strategy: 'no-ff', commit: 'abc123' })), line: 'm1 «Merged work» — decision: merged by the person' },
  { name: 'mark merged', decide: note('m1', () => eventNote(NOW.toISOString(), 'comment', { kind: 'marked_merged', into: 'main', by: 'person', reason: 'carried by hand' })), line: 'm1 «Merged work» — decision: marked as merged by the person — “carried by hand”' },
]

describe('the waker hears the person (wk1, B23)', () => {
  for (const planId of ['main', 'side'] as const) {
    it.each(KINDS)(`V-wk1/wake-decision $name wakes the chat of plan ${planId} once, with the decision and the reason`, async ({ decide, line, head }) => {
      const root = await repoWith(planId)
      const { sessions, prompts } = fakeSessions()
      const sched = manualSchedule()
      const waker = createChatWaker({ sessions, now: () => NOW, newId: () => 'req', windowMs: 5000, schedule: sched.schedule })
      waker(await snap(root))
      await waker.idle()
      await sched.run()
      expect(prompts).toHaveLength(0)

      await decide(root, planId)
      waker(await snap(root))
      await waker.idle()
      await sched.run()
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.sessionId).toBe(`sess-${planId}`)
      expect(prompts[0]?.text).toContain(line)
      expect(prompts[0]?.text).toContain(head ?? '[crewboard] The person decided')

      // Once per change: the same decision in the next snapshots wakes nobody again.
      waker(await snap(root))
      await waker.idle()
      await sched.run()
      expect(prompts).toHaveLength(1)
    })
  }

  it('V-wk1/wake-background work in a background plan that waits for the person wakes that plan\'s chat, not the open one', async () => {
    const root = await repoWith('side')
    await writeChats(root, { side: { sessionId: 'sess-side', wake: true, boundAt: 't' }, main: { sessionId: 'sess-main', wake: true, boundAt: 't' } })
    const { sessions, prompts } = fakeSessions()
    const sched = manualSchedule()
    const waker = createChatWaker({ sessions, now: () => NOW, newId: () => 'req', windowMs: 5000, schedule: sched.schedule })
    waker(await snap(root))
    await waker.idle()
    await updatePlan(root, (plan) => {
      plan.tasks.push({ ...newTask({ id: 't2', title: 'Lexer', contract: 'c.md' }), status: 'in_review', runs: [{ runId: 'run_dsh-2', agent: 'dsh', startedAt: '2026-09-25T11:00:00Z', finishedAt: '2026-09-25T11:10:00Z', outcome: 'completed' }] })
      return plan
    }, 5, 'side')
    waker(await snap(root))
    await waker.idle()
    await sched.run()
    expect(prompts.map((p) => p.sessionId)).toEqual(['sess-side'])
    // A plan with a chat has the orchestrator's check on: finished work first waits for that check.
    expect(prompts[0]?.text).toContain('t2 «Lexer» — check_due: Run finished — check it: orchestra_verify action=done')
    expect(prompts[0]?.text).toContain('[crewboard] Orchestrator action needed')
  })

  it('a muted background chat stays quiet', async () => {
    const root = await repoWith('side')
    await writeChats(root, { side: { sessionId: 'sess-side', wake: false, boundAt: 't' } })
    const { sessions, prompts } = fakeSessions()
    const sched = manualSchedule()
    const waker = createChatWaker({ sessions, now: () => NOW, newId: () => 'req', windowMs: 5000, schedule: sched.schedule })
    waker(await snap(root))
    await waker.idle()
    await rejectTask(root, 't1', 'no', NOW, 'side')
    waker(await snap(root))
    await waker.idle()
    await sched.run()
    expect(prompts).toHaveLength(0)
  })
})
