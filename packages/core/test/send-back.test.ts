import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaunchInput, RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { lastDecisionOf, pendingSendBack } from '../src/orchestration/decision.js'
import { launchTask } from '../src/orchestration/launch.js'
import { sendBackAndRerun } from '../src/orchestration/relaunch.js'
import { acceptTask, dropTask, rejectTask, supersedeTask } from '../src/orchestration/review.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { eventNote } from '../src/plan/notes.js'
import { newTask, type Note } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-25T12:00:00Z')

async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({
      ...newTask({ id: 't1', title: 'T1', contract: 'contract.md' }),
      status: 'in_review',
      runs: [{ runId: 'run_dsh-a', agent: 'dsh/deepseek-flash', startedAt: '2026-09-25T11:00:00Z', finishedAt: '2026-09-25T11:10:00Z', outcome: 'completed' }],
    })
    p.tasks.push({ ...newTask({ id: 'd1', title: 'Pick one', kind: 'decision' }), status: 'in_review' })
    p.tasks.push(newTask({ id: 't2', title: 'T2', contract: 'contract.md' }))
    return p
  })
  const launches: LaunchInput[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async (input) => {
      launches.push(input)
      return `run_dsh-${launches.length + 1}`
    },
    events: async () => [{ ts: '2026-09-25T11:05:00Z', type: 'answer_delta', data: 'Done, I think.' }],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const base = { root, skipPreflight: true, backends, exec: nodeExec, env: {}, home: root, now: () => NOW }
  return { root, base, launches, backends }
}

const note = (n: Partial<Note> & Pick<Note, 'type' | 'text'>): Note => ({ at: '2026-09-25T10:00:00Z', ...n })

describe('lastDecisionOf (V-wk1/last-decision)', () => {
  it('reads each human decision with its reason, the latest wins', () => {
    const at = '2026-09-25T10:00:00Z'
    const of = (kind: 'implement' | 'decision', ...notes: Note[]) => lastDecisionOf({ kind, notes })
    expect(of('implement', eventNote(at, 'accept', { kind: 'accepted' }))).toEqual({ by: 'person', at, verdict: 'accepted' })
    expect(of('decision', eventNote(at, 'accept', { kind: 'accepted' }))).toEqual({ by: 'person', at, verdict: 'answered' })
    expect(of('implement', eventNote(at, 'reject', { kind: 'rejected', reason: 'tests are red' }))).toEqual({ by: 'person', at, verdict: 'sent_back', reason: 'tests are red' })
    expect(of('implement', eventNote(at, 'comment', { kind: 'dropped', reason: 'not needed' }))).toMatchObject({ verdict: 'dropped', reason: 'not needed' })
    expect(of('implement', eventNote(at, 'comment', { kind: 'superseded', by: 't9' }))).toMatchObject({ verdict: 'superseded', reason: 't9' })
    expect(of('implement', eventNote(at, 'comment', { kind: 'merged', into: 'main', strategy: 'no-ff', commit: 'abc' }))).toMatchObject({ verdict: 'merged' })
    expect(of('implement', eventNote(at, 'comment', { kind: 'marked_merged', into: 'main', by: 'person', reason: 'carried by hand' }))).toMatchObject({ verdict: 'marked_merged', reason: 'carried by hand' })
    // Not decisions: automatic records and the orchestrator's own steps.
    expect(of('implement', eventNote(at, 'comment', { kind: 'merged_by_content', into: 'main' }), eventNote(at, 'check', { kind: 'checked', note: 'ok' }))).toBeUndefined()
    // A note written before events: the type says what it was.
    expect(of('implement', note({ type: 'reject', text: 'old reason' }))).toMatchObject({ verdict: 'sent_back', reason: 'old reason' })
    // The latest decision wins, whatever came after it.
    expect(of('implement', eventNote(at, 'reject', { kind: 'rejected', reason: 'first' }), eventNote('2026-09-25T11:00:00Z', 'accept', { kind: 'accepted' }), eventNote(at, 'comment', { kind: 'worktree', outcome: 'removed' }))).toMatchObject({ verdict: 'accepted', at: '2026-09-25T11:00:00Z' })
  })

  it('a send back is pending until a run starts after it', () => {
    const notes = [eventNote('2026-09-25T11:20:00Z', 'reject', { kind: 'rejected', reason: 'cover the empty list' })]
    const runs = [{ runId: 'run_a', agent: 'dsh', startedAt: '2026-09-25T11:00:00Z' }]
    expect(pendingSendBack({ kind: 'implement', notes, runs })).toBe('cover the empty list')
    expect(pendingSendBack({ kind: 'implement', notes, runs: [...runs, { runId: 'run_b', agent: 'dsh', startedAt: '2026-09-25T11:30:00Z' }] })).toBeUndefined()
  })

  it('the repository snapshot carries lastDecision on each decided task', async () => {
    const { root, backends } = await setup()
    await rejectTask(root, 't1', 'the empty list crashes', NOW)
    await acceptTask(root, 'd1', NOW)
    await dropTask(root, 't2', 'covered elsewhere', NOW)
    const snap = await buildRepoSnapshot(root, backends, NOW)
    const byId = new Map(snap.tasks.map((t) => [t.id, t]))
    expect(byId.get('t1')?.lastDecision).toEqual({ by: 'person', at: NOW.toISOString(), verdict: 'sent_back', reason: 'the empty list crashes' })
    expect(byId.get('d1')?.lastDecision).toMatchObject({ verdict: 'answered' })
    expect(byId.get('t2')?.lastDecision).toMatchObject({ verdict: 'dropped', reason: 'covered elsewhere' })
  })
})

describe('Send back reaches the next run (V-wk1/send-back-prompt)', () => {
  it('a plain run after a Send back carries the reason after the contract, once', async () => {
    const { root, base, launches } = await setup()
    await rejectTask(root, 't1', 'the empty list crashes', NOW)
    await launchTask({ ...base, taskId: 't1', agent: 'dsh', caller: 'person' })
    const prompt = await readFile(launches[0]?.promptFile ?? '', 'utf8')
    expect(prompt.indexOf('<send_back>')).toBeGreaterThan(prompt.indexOf('Do the thing.'))
    expect(prompt).toContain('the empty list crashes')
    // The run that read it made it no longer pending: the next start does not repeat it.
    await updatePlan(root, (p) => {
      const run = p.tasks.find((t) => t.id === 't1')?.runs.at(-1)
      if (run) Object.assign(run, { finishedAt: '2026-09-25T12:10:00Z', outcome: 'completed' })
      return p
    })
    await launchTask({ ...base, taskId: 't1', agent: 'dsh', caller: 'person', now: () => new Date('2026-09-25T12:20:00Z') })
    expect(await readFile(launches[1]?.promptFile ?? '', 'utf8')).not.toContain('<send_back>')
  })

  it('sendBackAndRerun records the send back and starts the same worker in the same copy with the reason', async () => {
    const { root, base, launches } = await setup()
    const result = await sendBackAndRerun({ ...base, taskId: 't1', reason: 'handle the empty list', caller: 'person' })
    // The previous run's worker, still in the preset, runs again.
    expect(result.agent).toBe('dsh/deepseek-flash')
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 't1')
    expect(task?.runs).toHaveLength(2)
    expect(lastDecisionOf(task!)).toMatchObject({ verdict: 'sent_back', reason: 'handle the empty list' })
    const prompt = await readFile(launches[0]?.promptFile ?? '', 'utf8')
    expect(prompt).toContain('<previous_run>')
    expect(prompt).toContain('<send_back>')
    expect(prompt).toContain('handle the empty list')
  })

  it('refuses a decision or a task without a run before sending anything back', async () => {
    const { root, base } = await setup()
    await expect(sendBackAndRerun({ ...base, taskId: 'd1', reason: 'no' })).rejects.toMatchObject({ code: 'decision' })
    await expect(sendBackAndRerun({ ...base, taskId: 't2', reason: 'no' })).rejects.toMatchObject({ code: 'no_runs' })
    const plan = await loadPlan(root)
    expect(plan.tasks.find((t) => t.id === 'd1')?.status).toBe('in_review')
    expect(plan.tasks.find((t) => t.id === 't2')?.notes).toEqual([])
    await supersedeTask(root, 't2', 't1', NOW)
    await expect(sendBackAndRerun({ ...base, taskId: 't2', reason: 'no' })).rejects.toMatchObject({ code: 'superseded' })
  })
})
