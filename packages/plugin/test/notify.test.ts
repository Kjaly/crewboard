import { expect, it } from 'vitest'
import type { Attention, PlanSummary, RepoSnapshot, TaskSnapshot } from '@crewboard/core'
import { createAttentionNotifier } from '../src/host/notify.js'

// at2 (B28): the macOS channel says the work that waits on the person, grouped by plan and reason, once per
// change — never one notification per task or per alarm.

const task = (id: string, patch: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id,
  title: `Task ${id}`,
  kind: 'implement',
  status: 'running',
  deps: [],
  blockedBy: [],
  needsHuman: false,
  runs: 1,
  lastRunId: `run_${id}`,
  ...patch,
})
const repo = (tasks: TaskSnapshot[], attention: Attention[] = [], plans?: PlanSummary[]): RepoSnapshot => ({
  root: '/r',
  goal: 'Ship it',
  planId: 'main',
  rev: 1,
  updatedAt: 't',
  tasks,
  ready: [],
  criticalPath: [],
  attention,
  degraded: false,
  ...(plans ? { plans } : {}),
})
const snap = (...repos: RepoSnapshot[]) => ({ generatedAt: 't', repos, workers: [] })
const review = (id: string) => task(id, { status: 'in_review' })

/** A notifier whose window closes only when the test says so. */
function harness(lang: 'en' | 'ru' = 'en', gate: () => boolean = () => true) {
  const sent: string[] = []
  let pending: (() => void) | undefined
  const notifier = createAttentionNotifier((title, message) => { sent.push(`${title}|${message}`) }, () => lang, gate, {
    schedule: (fn) => {
      pending = fn
      return () => { pending = undefined }
    },
  })
  const close = () => { pending?.() }
  return { sent, notifier, close }
}

it('a burst of three finished tasks yields one grouped notification', () => {
  const { sent, notifier, close } = harness()
  notifier(snap(repo([task('a'), task('b'), task('c'), task('d', { kind: 'decision', status: 'ready' })])))
  expect(sent).toEqual([])
  // The three finish across two snapshots inside one window.
  notifier(snap(repo([review('a'), task('b'), task('c'), task('d', { kind: 'decision', status: 'ready' })])))
  notifier(snap(repo([review('a'), review('b'), review('c'), task('d', { kind: 'decision', status: 'ready' })])))
  expect(sent).toEqual([])
  close()
  expect(sent).toEqual(['crewboard|3 tasks wait for review in “Ship it”'])
  // The same state again is no news.
  notifier(snap(repo([review('a'), review('b'), review('c'), task('d', { kind: 'decision', status: 'ready' })])))
  close()
  expect(sent).toHaveLength(1)
})

it('groups by reason and by plan: a decision, a failed run, and a background plan that waits', () => {
  const { sent, notifier, close } = harness()
  const later = (waitingHuman: number, decisions: number): PlanSummary => ({ id: 'later', goal: 'Later work', running: 0, inReview: 0, waitingHuman, decisions, ready: 0, accepted: 0, attention: [], createdAt: 't', updatedAt: 't', current: false } as unknown as PlanSummary)
  const main = { id: 'main', goal: 'Ship it', current: true, running: 0, inReview: 0, waitingHuman: 0, ready: 0, accepted: 0, attention: [], createdAt: 't', updatedAt: 't' } as unknown as PlanSummary
  const failed: Attention = { kind: 'failed', severity: 'alert', taskId: 'x', runId: 'run_x', message: 'boom', reason: { code: 'worker_error' } }
  notifier(snap(repo([task('a'), task('x')], [], [main, later(0, 0)])))
  notifier(snap(repo([review('a'), task('d', { kind: 'decision', status: 'ready' }), task('x', { status: 'ready' })], [failed], [main, later(3, 1)])))
  close()
  expect(sent).toEqual(['crewboard|1 task waits for review · 1 decision · 1 run failed or stalled in “Ship it”; 2 tasks wait for review · 1 decision in “Later work”'])
})

it('speaks the reader\'s language', () => {
  const { sent, notifier, close } = harness('ru')
  notifier(snap(repo([task('a'), task('b')])))
  notifier(snap(repo([review('a'), review('b')])))
  close()
  expect(sent).toEqual(['crewboard|2 задачи ждут ревью — «Ship it»'])
})

it('a reworked task that comes back with a new run is news again; accepted-but-unmerged work is not', () => {
  const { sent, notifier, close } = harness()
  notifier(snap(repo([review('a'), review('b')])))
  notifier(snap(repo([task('a', { lastRunId: 'run_a2' }), task('b', { status: 'accepted', unmerged: true })])))
  close()
  expect(sent).toEqual([])
  notifier(snap(repo([task('a', { status: 'in_review', lastRunId: 'run_a2' }), task('b', { status: 'accepted', unmerged: true })])))
  close()
  expect(sent).toEqual(['crewboard|1 task waits for review in “Ship it”'])
})

// nt2: a worker running a long foreground command (st2, bg1) is information, not an alarm — it must never
// notify, however many times it starts and stops across polls.
it('a command that starts and stops repeatedly never notifies while merely running', () => {
  const { sent, notifier, close } = harness()
  const running = (idleMin: number): Attention => ({ kind: 'running', severity: 'warn', taskId: 'x', runId: 'run_x', message: `Command running ${idleMin} min`, idleMin })
  notifier(snap(repo([task('x')])))
  notifier(snap(repo([task('x')], [running(1)])))
  close()
  notifier(snap(repo([task('x')]))) // the command finishes: the entry disappears
  close()
  notifier(snap(repo([task('x')], [running(2)]))) // a new command starts running
  close()
  notifier(snap(repo([task('x')])))
  close()
  notifier(snap(repo([task('x')], [running(1)]))) // a third command
  close()
  expect(sent).toEqual([])
})

// nt2: only the escalation past the «may be stuck» threshold is a real alarm, and it is said once for the
// run, not again on every later poll while the same command keeps running.
it('a run that goes running → quiet → running for 40 min notifies exactly once, at the «may be stuck» threshold', () => {
  const { sent, notifier, close } = harness()
  const running = (severity: 'warn' | 'alert', idleMin: number): Attention => ({ kind: 'running', severity, taskId: 'x', runId: 'run_x', message: `Command running ${idleMin} min`, idleMin })
  notifier(snap(repo([task('x')])))
  notifier(snap(repo([task('x')], [running('warn', 5)]))) // a command starts
  close()
  expect(sent).toEqual([])
  notifier(snap(repo([task('x')]))) // the gap: quiet, no command in flight
  close()
  expect(sent).toEqual([])
  notifier(snap(repo([task('x')], [running('warn', 10)]))) // another command, still well under the threshold
  close()
  expect(sent).toEqual([])
  notifier(snap(repo([task('x')], [running('alert', 31)]))) // 31 min in: past the 30 min threshold
  close()
  expect(sent).toEqual(['crewboard|1 run may be stuck in “Ship it”'])
  // The same command, still running: the same alarm, not a second one.
  notifier(snap(repo([task('x')], [running('alert', 35)])))
  close()
  notifier(snap(repo([task('x')], [running('alert', 40)])))
  close()
  expect(sent).toEqual(['crewboard|1 run may be stuck in “Ship it”'])
})

it('a failed run notifies once, and stays quiet on every later poll while it is still failed', () => {
  const { sent, notifier, close } = harness()
  const failed: Attention = { kind: 'failed', severity: 'alert', taskId: 'x', runId: 'run_x', message: 'boom', reason: { code: 'worker_error' } }
  notifier(snap(repo([task('x')])))
  notifier(snap(repo([task('x', { status: 'ready' })], [failed])))
  close()
  expect(sent).toEqual(['crewboard|1 run failed or stalled in “Ship it”'])
  notifier(snap(repo([task('x', { status: 'ready' })], [failed])))
  close()
  notifier(snap(repo([task('x', { status: 'ready' })], [failed])))
  close()
  expect(sent).toEqual(['crewboard|1 run failed or stalled in “Ship it”'])
})

it('stays silent while a browser client is present and does not replay what it showed', () => {
  let quiet = false
  const { sent, notifier, close } = harness('en', () => !quiet)
  notifier(snap(repo([task('a'), task('b')])))
  quiet = true
  notifier(snap(repo([review('a'), task('b')])))
  close()
  // The hidden browser tab is showing it, so macOS must not.
  expect(sent).toEqual([])
  quiet = false
  notifier(snap(repo([review('a'), task('b')])))
  close()
  expect(sent).toEqual([])
  notifier(snap(repo([review('a'), review('b')])))
  close()
  expect(sent).toEqual(['crewboard|1 task waits for review in “Ship it”'])
})
