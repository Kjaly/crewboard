import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { lastAttemptOf } from '../src/orchestration/last-attempt.js'
import { launchTask } from '../src/orchestration/launch.js'
import { relaunchTask } from '../src/orchestration/relaunch.js'
import { syncRuns } from '../src/plan/graph.js'
import { type Plan, newTask, readPlanValue } from '../src/plan/schema.js'
import { CREWBOARD_DIR, initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { attemptAction, classifyFailure, errorLine, failureTextOf, stateFailure } from '../src/runs/failure.js'
import { eventNoteOf, normalize } from '../src/runs/normalize.js'
import { evaluateRun } from '../src/watch/rules.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-25T12:00:00Z')

/**
 * V-fo1/reasons: what each worker reports when it fails, and the code it reads as. Fixture texts are the workers'
 * own words (Claude Code `result`, Codex `turn.failed` / stderr, Devin's runner, dsh / DeepSeek API errors).
 */
const FIXTURES = [
  { backend: 'claude', text: 'Claude AI usage limit reached|1759496400', expect: { code: 'rate_limited', resetsAt: '2025-10-03T13:00:00.000Z' } },
  { backend: 'claude', text: "You've hit your usage limit · resets 3pm (Europe/Berlin)", expect: { code: 'rate_limited' } },
  { backend: 'claude', text: 'Invalid API key · Please run /login', expect: { code: 'auth_expired', login: 'claude auth login' } },
  { backend: 'claude', text: 'OAuth token has expired. Please obtain a new token or refresh your existing token.', expect: { code: 'auth_expired', login: 'claude auth login' } },
  { backend: 'codex', text: "You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.", expect: { code: 'rate_limited' } },
  { backend: 'codex', text: 'stream error: unexpected status 401 Unauthorized: Your access token could not be refreshed', expect: { code: 'auth_expired', login: 'codex login' } },
  { backend: 'devin', text: 'Devin is not logged in: run devin auth login. Not logged in', expect: { code: 'auth_expired', login: 'devin auth login' } },
  { backend: 'devin', text: 'Run supervisor stopped by SIGTERM', expect: { code: 'interrupted' } },
  { backend: 'dsh', text: 'API error 401: Authentication Fails, Your api key is invalid', expect: { code: 'auth_expired' } },
  { backend: 'dsh', text: 'ENOSPC: no space left on device, write', expect: { code: 'disk_full' } },
  { backend: 'codex', text: "the run's supervisor exited; worker pid 42 was stopped", expect: { code: 'interrupted' } },
  { backend: 'dsh', text: 'API error 402: Insufficient Balance', expect: { code: 'worker_error' } },
  { backend: 'claude', text: 'API Error: 529 overloaded', expect: { code: 'worker_error' } },
] as const

describe('failure reasons (fo1)', () => {
  it.each(FIXTURES)('V-fo1/reasons $backend: «$text»', ({ backend, text, expect: want }) => {
    expect(classifyFailure(backend, text)).toEqual(want)
  })

  it('a dsh login problem names no command: the key lives in dsh settings', () => {
    expect(classifyFailure('dsh', 'Not logged in')).toEqual({ code: 'auth_expired' })
  })

  it('V-fo1/error-line keeps the worker’s own Error: line, not the first bytes of stderr', () => {
    const stderr = 'Codex CLI v0.99 (research preview)\nwarning: config key is deprecated\nError: failed to read the prompt file\n'
    expect(errorLine(stderr)).toBe('Error: failed to read the prompt file')
    expect(failureTextOf(stderr, 'codex exited with code 1')).toBe('Error: failed to read the prompt file')
    expect(errorLine('TypeError: x is not a function\n    at main (a.js:1)')).toBe('TypeError: x is not a function')
    // No error line: the last line, then the exit code.
    expect(failureTextOf('banner\nsomething went wrong', 'x')).toBe('something went wrong')
    expect(failureTextOf('', 'claude exited with code 2')).toBe('claude exited with code 2')
  })

  it('each reason has its move', () => {
    const table = [
      ['failed', { code: 'rate_limited' }, 'retry'],
      ['failed', { code: 'auth_expired', login: 'codex login' }, 'login'],
      ['failed', { code: 'interrupted' }, 'retry'],
      ['failed', { code: 'disk_full' }, 'retry'],
      ['failed', { code: 'setup_failed' }, 'show_output'],
      ['failed', { code: 'baseline_red' }, 'show_output'],
      ['failed', { code: 'worker_error' }, 'retry'],
      ['incomplete', undefined, 'continue'],
      ['cancelled', undefined, 'retry'],
    ] as const
    for (const [outcome, reason, move] of table) expect(attemptAction(outcome, reason)).toBe(move)
  })

  it('a backend state file of an older build still yields a reason from its text; a dead supervisor is interrupted', () => {
    expect(stateFailure('claude', { status: 'failed', error: 'Not logged in · Please run /login' })).toEqual({ reason: 'auth_expired', text: 'Not logged in · Please run /login', login: 'claude auth login' })
    expect(stateFailure('codex', { status: 'failed', error: 'x', interrupted: { workerStopped: true } })).toEqual({ reason: 'interrupted', text: 'x' })
    expect(stateFailure('codex', { status: 'completed' })).toBeUndefined()
  })
})

describe('the reason is stored next to the outcome (fo1)', () => {
  const planWith = (runs: Plan['tasks'][number]['runs']) => ({ version: 1, goal: 'g', rev: 1, updatedAt: NOW.toISOString(), tasks: [{ ...newTask({ id: 'a', title: 'A' }), runs }] }) as Plan

  it('syncRuns records the backend’s reason, and worker_error when it knows none', () => {
    const plan = planWith([{ runId: 'run_x-a', agent: 'claude/opus', startedAt: NOW.toISOString() }])
    const limited = syncRuns(plan, { 'run_x-a': { status: 'failed', terminal: true, exitCode: 1, failure: { reason: 'rate_limited', resetsAt: '2026-09-25T15:00:00.000Z', text: 'limit' } } }, NOW).plan
    expect(limited.tasks[0]?.runs[0]).toMatchObject({ outcome: 'failed', failure: { reason: 'rate_limited', resetsAt: '2026-09-25T15:00:00.000Z' } })
    const bare = syncRuns(plan, { 'run_x-a': { status: 'failed', terminal: true, exitCode: 1 } }, NOW).plan
    expect(bare.tasks[0]?.runs[0]?.failure).toEqual({ reason: 'worker_error' })
    const cancelled = syncRuns(plan, { 'run_x-a': { status: 'cancelled', terminal: true, exitCode: 130 } }, NOW).plan
    expect(cancelled.tasks[0]?.runs[0]?.failure).toBeUndefined()
  })

  it('V-fo1/compat the outcome enum stays as it was; a reason a newer build added reads as worker_error and is noted', () => {
    const raw = planWith([{ runId: 'run_x-a', agent: 'x', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), outcome: 'failed', failure: { reason: 'quota_gone' as never, text: 't' } }])
    const { plan, unread } = readPlanValue(JSON.parse(JSON.stringify(raw)))
    expect(plan.tasks[0]?.runs[0]?.failure).toEqual({ reason: 'worker_error', text: 't' })
    expect(unread).toEqual(['failure.reason="quota_gone"'])
    // A plan without the field (an older build's) reads as before.
    expect(readPlanValue(JSON.parse(JSON.stringify(planWith([{ runId: 'run_x-b', agent: 'x', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), outcome: 'failed' }])))).unread).toEqual([])
  })

  it('the watch reads the stored reason, with the worker’s words as detail and the login command as hint', () => {
    const [alarm] = evaluateRun({ taskId: 't', runId: 'r', agent: 'codex/gpt', startedAt: NOW.toISOString(), state: { status: 'failed', terminal: true, exitCode: 1 }, events: [], steersAt: [], failure: { reason: 'auth_expired', login: 'codex login', text: 'Error: 401 Unauthorized' } }, NOW)
    expect(alarm).toMatchObject({ kind: 'failed', reason: { code: 'auth_expired', login: 'codex login' }, detail: 'Error: 401 Unauthorized', hint: 'codex login' })
  })

  it('V-fo1/stalled the stalled alarm carries its minutes as a number', () => {
    const start = '2026-09-25T11:00:00.000Z'
    const alarms = evaluateRun({ taskId: 't', runId: 'r', agent: 'dsh', startedAt: start, state: { status: 'running', terminal: false, exitCode: null }, events: [{ ts: '2026-09-25T11:01:00.000Z', kind: 'action', text: 'pnpm test' }], steersAt: [] }, new Date('2026-09-25T11:23:30.000Z'))
    expect(alarms).toEqual([expect.objectContaining({ kind: 'stalled', severity: 'alert', idleMin: 22 })])
  })
})

describe('runner notes are codes (fo1, B33)', () => {
  it('new events carry a code; the Russian lines older builds wrote read as the same codes', () => {
    expect(eventNoteOf({ code: 'stop_requested' })).toEqual({ code: 'stop_requested' })
    expect(eventNoteOf('остановка по запросу')).toEqual({ code: 'stop_requested' })
    expect(eventNoteOf('поправка пришла после завершения запуска и не доставлена')).toEqual({ code: 'steer_after_finish' })
    expect(eventNoteOf('please also update the docs')).toBeUndefined()
    const feed = normalize([{ ts: 't1', type: 'steer', data: 'остановка по запросу' }, { ts: 't2', type: 'steer', data: { code: 'stop_requested' } }, { ts: 't3', type: 'steer', data: 'use pnpm' }])
    expect(feed.map((e) => e.note?.code ?? e.text)).toEqual(['stop_requested', 'stop_requested', 'use pnpm'])
  })
})

describe('the last attempt (fo1)', () => {
  const run = { runId: 'run_x-a', agent: 'claude/opus', startedAt: '2026-09-25T10:00:00.000Z', finishedAt: '2026-09-25T10:30:00.000Z' }

  it('names the outcome, the reason and the move; a live or handed-in run has none', () => {
    const task = (over: object) => ({ ...newTask({ id: 'a', title: 'A' }), ...over })
    expect(lastAttemptOf(task({ runs: [{ ...run, outcome: 'failed', failure: { reason: 'auth_expired', login: 'claude auth login', text: 'Not logged in' } }] }))).toEqual({ outcome: 'failed', at: run.finishedAt, reason: { code: 'auth_expired', login: 'claude auth login' }, text: 'Not logged in', runId: run.runId, agent: run.agent, action: 'login' })
    expect(lastAttemptOf(task({ runs: [{ ...run, outcome: 'incomplete' }] }))).toMatchObject({ outcome: 'incomplete', action: 'continue' })
    expect(lastAttemptOf(task({ runs: [{ ...run, outcome: 'failed' }] }))).toMatchObject({ reason: { code: 'worker_error' }, action: 'retry' })
    expect(lastAttemptOf(task({ runs: [{ ...run, outcome: 'completed' }] }))).toBeUndefined()
    expect(lastAttemptOf(task({ runs: [{ runId: 'run_x-b', agent: 'dsh', startedAt: run.startedAt }] }))).toBeUndefined()
    expect(lastAttemptOf(task({ status: 'accepted', runs: [{ ...run, outcome: 'failed' }] }))).toBeUndefined()
  })

  it('a failed preparation after the last run is the last attempt; one before it is history', () => {
    const setup = { at: '2026-09-25T11:00:00.000Z', reason: 'setup_failed' as const, step: 'pnpm install', log: '/tmp/x.log', text: 'ERR_PNPM' }
    const task = { ...newTask({ id: 'a', title: 'A' }), runs: [{ ...run, outcome: 'failed' as const }], launchFailure: setup }
    expect(lastAttemptOf(task)).toEqual({ outcome: 'failed', at: setup.at, reason: { code: 'setup_failed', step: 'pnpm install', log: '/tmp/x.log' }, text: 'ERR_PNPM', log: '/tmp/x.log', action: 'show_output' })
    expect(lastAttemptOf({ ...task, launchFailure: { ...setup, at: '2026-09-25T09:00:00.000Z' } })).toMatchObject({ runId: run.runId })
  })
})

async function launchSetup(status: Awaited<ReturnType<RunBackend['status']>> = { status: 'failed', terminal: true, exitCode: 1 }) {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'a', title: 'Alpha', contract: 'contract.md' }))
    return p
  })
  let n = 0
  const launched: string[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => {
      n += 1
      launched.push(`run_dsh-${n}`)
      return `run_dsh-${n}`
    },
    events: async () => [],
    status: async () => status,
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const base = { root, backends, exec: nodeExec, env: {}, home: root, now: () => NOW, skipPreflight: true, taskId: 'a', agent: 'dsh' }
  return { root, base, launched }
}

describe('a failed preparation is kept on the task (fo1)', () => {
  it('V-fo1/setup-failed the failed step, its output file and the move to show it', async () => {
    const { root, base, launched } = await launchSetup()
    await mkdir(join(root, CREWBOARD_DIR), { recursive: true })
    await writeFile(join(root, CREWBOARD_DIR, 'recipes.json'), JSON.stringify({ setup: ['echo boom >&2; exit 3'] }))
    await expect(launchTask({ ...base, caller: 'person' })).rejects.toMatchObject({ code: 'prepare', message: expect.stringContaining('recipe step failed: echo boom') })
    await expect(launchTask({ ...base, caller: 'person', lang: 'ru' })).rejects.toMatchObject({ code: 'prepare', message: expect.stringContaining('шаг рецепта упал: echo boom') })
    const task = (await loadPlan(root)).tasks[0]
    expect(task?.launchFailure).toMatchObject({ reason: 'setup_failed', step: 'echo boom >&2; exit 3', text: 'boom' })
    expect(await readFile(task?.launchFailure?.log ?? '', 'utf8')).toContain('boom')
    expect(task && lastAttemptOf(task)).toMatchObject({ outcome: 'failed', reason: { code: 'setup_failed' }, action: 'show_output' })
    expect(launched).toEqual([])
  })

  it('V-fo1/baseline-red a red baseline is the last attempt; a later launch that starts a worker clears it', async () => {
    const { root, base, launched } = await launchSetup()
    await mkdir(join(root, CREWBOARD_DIR), { recursive: true })
    await writeFile(join(root, CREWBOARD_DIR, 'recipes.json'), JSON.stringify({ baseline: 'echo red; exit 1' }))
    await expect(launchTask({ ...base, caller: 'person' })).rejects.toMatchObject({ code: 'baseline' })
    const red = (await loadPlan(root)).tasks[0]
    expect(red && lastAttemptOf(red)).toMatchObject({ reason: { code: 'baseline_red', step: 'echo red; exit 1' }, action: 'show_output' })
    await writeFile(join(root, CREWBOARD_DIR, 'recipes.json'), JSON.stringify({ baseline: 'true' }))
    await launchTask({ ...base, caller: 'person' })
    expect(launched).toEqual(['run_dsh-1'])
    expect((await loadPlan(root)).tasks[0]?.launchFailure).toBeUndefined()
  })
})

describe('starting again on a copy with uncommitted changes (fo1)', () => {
  async function dirty() {
    const s = await launchSetup()
    const first = await launchTask({ ...s.base, caller: 'person' })
    await writeFile(join(first.worktree.path, 'half-done.ts'), 'export const x = 1\n')
    return { ...s, copy: first.worktree.path }
  }

  it('V-fo1/dirty-agent an agent is refused with both commands named, whatever it passes', async () => {
    const { base, launched } = await dirty()
    const refusal = { code: 'dirty_copy', vars: { id: 'a', count: 1 }, message: expect.stringMatching(/run a --keep-changes[\s\S]*run a --reset-copy/) }
    await expect(launchTask({ ...base, caller: 'agent' })).rejects.toMatchObject(refusal)
    await expect(launchTask({ ...base, caller: 'agent', dirtyCopy: 'reset' })).rejects.toMatchObject(refusal)
    await expect(launchTask({ ...base, caller: 'person', lang: 'ru' })).rejects.toMatchObject({ code: 'dirty_copy', message: expect.stringContaining('незакоммиченные изменения') })
    expect(launched).toEqual(['run_dsh-1'])
  })

  it('V-fo1/dirty-person a person continues with the changes, or resets the copy to its last commit', async () => {
    const { base, launched, copy } = await dirty()
    await launchTask({ ...base, caller: 'person', dirtyCopy: 'keep' })
    expect(await readFile(join(copy, 'half-done.ts'), 'utf8')).toContain('x = 1')
    await launchTask({ ...base, caller: 'person', dirtyCopy: 'reset' })
    await expect(readFile(join(copy, 'half-done.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(launched).toEqual(['run_dsh-1', 'run_dsh-2', 'run_dsh-3'])
  })

  it('a relaunch carries the previous run’s changes by design and asks nothing', async () => {
    const { base, launched } = await dirty()
    await relaunchTask({ ...base, caller: 'person', note: 'finish it' })
    expect(launched).toEqual(['run_dsh-1', 'run_dsh-2'])
  })
})
