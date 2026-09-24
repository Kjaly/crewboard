import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { makeRepo } from '../../core/test/git-helpers.js'
import { createExamplePlan, planPath, updatePlan } from '@crewboard/core'
import { run } from '../src/cli.js'
import { parseDuration, waitEvent } from '../src/commands/runs.js'
import { makeHarness } from './harness.js'

async function setup() {
  const root = await makeRepo()
  const h = makeHarness({ cwd: root })
  await run(['init'], h.io)
  await run(['task', 'add', 'a', '--title', 'Alpha'], h.io)
  await run(['task', 'add', 'b', '--title', 'Beta'], h.io)
  h.reset()
  return { root, h }
}
// The watch prints this once its baseline is taken; a fixed delay raced it under a loaded run.
async function untilWatching(h: ReturnType<typeof makeHarness>) {
  for (let i = 0; i < 400 && !h.err().includes('Watching plan'); i++) await delay(5)
  expect(h.err()).toContain('Watching plan')
}
async function change(root: string, id: string, status: string) {
  await updatePlan(root, (p) => { p.tasks.find((t) => t.id === id)!.status = status as never; return p })
}

it('decision wakes decision wait and JSON carries events as an array', async () => {
  const { root, h } = await setup()
  const waiting = run(['wait', '--for', 'decision', '--interval', '500ms', '--timeout', '2', '--json'], h.io)
  await untilWatching(h)
  await change(root, 'a', 'accepted')
  expect(await waiting).toBe(0)
  expect(JSON.parse(h.out())).toEqual([{ kind: 'decision', taskId: 'a', oldStatus: 'ready', newStatus: 'accepted', title: 'Alpha' }])
})

it('decision does not wake finished wait, and timeout returns 2', async () => {
  const { root, h } = await setup()
  const waiting = run(['wait', '--for', 'finished', '--interval', '20ms', '--timeout', '0.12'], h.io)
  await untilWatching(h)
  await change(root, 'a', 'accepted')
  expect(await waiting).toBe(2)
  expect(h.err()).toContain('Timed out')
})

it('filters tasks and returns changes in one polling batch together', async () => {
  const { root, h } = await setup()
  const waiting = run(['wait', '--tasks', 'a,b', '--interval', '200ms', '--timeout', '2', '--json'], h.io)
  await untilWatching(h)
  await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'a')!.status = 'accepted' as never; p.tasks.find((t) => t.id === 'b')!.status = 'superseded' as never; return p })
  expect(await waiting).toBe(0)
  expect(JSON.parse(h.out())).toHaveLength(2)
})

it('waits on an explicit plan and ignores transitions in another plan', async () => {
  const { root, h } = await setup()
  await run(['plan', 'new', 'other', '--goal', 'Other'], h.io)
  await run(['task', 'add', 'x', '--title', 'Other task'], h.io)
  await run(['plan', 'use', 'main'], h.io)
  h.reset()
  const waiting = run(['wait', '--plan', 'main', '--interval', '20ms', '--timeout', '0.12'], h.io)
  await untilWatching(h)
  await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'x')!.status = 'accepted' as never; return p }, 5, 'other')
  expect(await waiting).toBe(2)
})

// A command that never started waiting must not answer like a finished wait: exit 2 means «waited
// and nothing happened», and an agent reading it carries on. Bad options are an error.
it('reports bad options as an error, never as a timeout', async () => {
  const { h } = await setup()
  expect(await run(['wait', '--timeout', 'soon'], h.io)).toBe(1)
  expect(await run(['wait', '--for', 'everything'], h.io)).toBe(1)
})

it('reads durations the way people type them', () => {
  expect(parseDuration('15')).toBe(15_000)
  expect(parseDuration('30s')).toBe(30_000)
  expect(parseDuration('5m')).toBe(300_000)
  expect(parseDuration('2h')).toBe(7_200_000)
  expect(parseDuration('250ms')).toBe(250)
  expect(parseDuration('soon')).toBeUndefined()
})

it('reports a stray positional argument as a usage error, not a crash', async () => {
  const { h } = await setup()
  expect(await run(['wait', 'extra'], h.io)).toBe(2)
  expect(h.err()).not.toContain('    at ')
})

it('refuses to watch an example plan', async () => {
  const { root, h } = await setup()
  await createExamplePlan(root)
  h.reset()
  expect(await run(['wait', '--timeout', '0.1'], h.io)).toBe(1)
  expect(h.err()).toContain('Example plans cannot be watched')
})

it('keeps the example out of real cost totals', async () => {
  const { root, h } = await setup()
  await createExamplePlan(root)
  h.reset()
  expect(await run(['cost', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out())).toEqual({ runs: [], totals: {} })
})

// vr1: the orchestrator's check steps wake the wait; a person waiting for decisions is not woken by them.
it('reports orchestrator check transitions', async () => {
  const { root, h } = await setup()
  await updatePlan(root, (p) => {
    const a = p.tasks.find((t) => t.id === 'a')!
    a.status = 'in_review'
    a.runs.push({ runId: 'run_x', agent: 'dsh', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:10:00Z', outcome: 'completed' })
    a.check = { state: 'pending', runId: 'run_x', at: '2026-09-22T10:10:00Z' }
    return p
  })
  const waiting = run(['wait', '--for', 'check', '--interval', '200ms', '--timeout', '2', '--json'], h.io)
  await untilWatching(h)
  await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'a')!.check = { state: 'checked', runId: 'run_x', at: '2026-09-22T10:20:00Z', note: 'gates green' }; return p })
  expect(await waiting).toBe(0)
  expect(JSON.parse(h.out())).toEqual([{ kind: 'check', taskId: 'a', oldStatus: 'pending', newStatus: 'checked', title: 'Alpha', note: 'gates green' }])
})

it('names each check step, a return and a finish that starts a check', () => {
  const r = { status: 'in_review', title: 'A' }
  expect(waitEvent('a', { status: 'running', title: 'A' }, { ...r, check: 'pending' })).toMatchObject({ kind: 'finished', newStatus: 'in_review', check: 'pending' })
  expect(waitEvent('a', { ...r, check: 'pending' }, { ...r, check: 'checking' })).toMatchObject({ kind: 'check', oldStatus: 'pending', newStatus: 'checking' })
  expect(waitEvent('a', { ...r, check: 'checking' }, { status: 'running', title: 'A' })).toMatchObject({ kind: 'check', oldStatus: 'checking', newStatus: 'returned' })
  expect(waitEvent('a', { ...r, check: 'checked' }, { status: 'accepted', title: 'A' })).toMatchObject({ kind: 'decision' })
  expect(waitEvent('a', r, r)).toBeUndefined()
})

/** Replaces the file in one step, as the plan store does: a reader never sees it half written. */
async function replace(file: string, text: string) {
  await writeFile(`${file}.tmp`, text)
  await rename(`${file}.tmp`, file)
}

// pq1: a plan that stays unreadable is one line on stderr, not one per tick; a newer build's plan ends the wait.
it('says once that the plan cannot be read, and again when it reads', async () => {
  const { root, h } = await setup()
  const file = planPath(root)
  const good = await readFile(file, 'utf8')
  const waiting = run(['wait', '--interval', '20ms', '--timeout', '0.6'], h.io)
  await untilWatching(h)
  await replace(file, '{ broken')
  await delay(200)
  expect(h.err().match(/Cannot read the plan/g)).toHaveLength(1)
  await replace(file, good)
  expect(await waiting).toBe(2)
  expect(h.err()).toContain('The plan reads again')
  expect((await readdir(dirname(file))).filter((name) => name.includes('.corrupt-'))).toHaveLength(1)
})

it('stops waiting on a plan a newer build wrote, naming the update', async () => {
  const { root, h } = await setup()
  const file = planPath(root)
  const waiting = run(['wait', '--interval', '20ms', '--timeout', '2'], h.io)
  await untilWatching(h)
  await replace(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), version: 2 }))
  expect(await waiting).toBe(1)
  expect(h.err()).toMatch(/newer Crewboard .*Update Crewboard/)
})

it('names the update in the chosen language before the watch starts', async () => {
  const { root, h } = await setup()
  const file = planPath(root)
  await replace(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), version: 2 }))
  expect(await run(['--lang', 'ru', 'wait', '--timeout', '1'], h.io)).toBe(1)
  expect(h.err()).toMatch(/более новой версией Crewboard .*Обновите Crewboard/)
  expect(h.err()).not.toContain('Наблюдаю план')
})
