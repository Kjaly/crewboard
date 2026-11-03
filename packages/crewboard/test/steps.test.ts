import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RawEvent, normalize, parseCodexLine } from '@crewboard/core'
import { describe, expect, it } from 'vitest'
import { runsDir } from '../src/store/paths.js'
import { type RunSteps, createStepsReader, stepsFromEvents } from '../src/workers/steps.js'
import { createEventStore } from '../src/store/event-store.js'
import { createFakeBackend } from './fake-backend.js'
import { gitRepo, startApp } from './helpers.js'

const ts = '2026-11-03T10:00:00.000Z'
const end = '2026-11-03T10:00:01.500Z'
const command = (callId: string): RawEvent => ({ ts, type: 'tool_started', data: { callId, tool: 'bash', status: 'running', input: { command: 'pnpm test' } } })
const completed = (callId: string, status = 'completed'): RawEvent => ({ ts: end, type: 'tool_completed', data: { callId, tool: 'bash', status, output: 'PRIVATE TOOL OUTPUT' } })

describe('run steps', () => {
  it.each([
    { name: 'message', raw: [{ ts, type: 'answer_delta', data: 'Checking\n  the build' }], step: { kind: 'message', text: 'Checking the build', detail: 'Checking\n  the build' } },
    { name: 'finished command', raw: [command('c1'), completed('c1')], step: { kind: 'command', text: 'pnpm test', status: 'done', durationMs: 1500 } },
    { name: 'running command', raw: [command('c1')], step: { kind: 'command', text: 'pnpm test', status: 'running' } },
    { name: 'failed command', raw: [command('c1'), completed('c1', 'error')], step: { kind: 'command', text: 'pnpm test', status: 'failed', durationMs: 1500 } },
    { name: 'write', raw: [{ ts, type: 'tool_started', data: { callId: 'w1', tool: 'write', status: 'running', input: { path: '/repo/app.ts', content: 'PRIVATE FILE CONTENTS' } } }], step: { kind: 'write', text: 'app.ts', status: 'running' } },
    { name: 'read', raw: [{ ts, type: 'tool_started', data: { callId: 'r1', tool: 'read', status: 'running', input: { path: '/repo/app.ts' } } }], step: { kind: 'read', text: 'app.ts', status: 'running' } },
    { name: 'generic tool', raw: [{ ts, type: 'tool_started', data: { callId: 't1', tool: 'search', status: 'running' } }], step: { kind: 'tool', text: 'search', status: 'running' } },
    { name: 'problem', raw: [{ ts, type: 'error', data: 'Build\nfailed' }], step: { kind: 'problem', text: 'Build failed' } },
    { name: 'final', raw: [{ ts, type: 'result', data: 'Finished\nthe build' }], step: { kind: 'final', text: 'Finished the build', detail: 'Finished\nthe build' } },
    { name: 'final with its handback tags', raw: [{ ts, type: 'result', data: 'Done.\n<crewboard-report>Tests pass</crewboard-report>' }], step: { kind: 'final', text: 'Done. Tests pass', detail: 'Done.\nTests pass' } },
    { name: 'thought in markdown', raw: [{ ts, type: 'reasoning_summary', data: '**Summarizing key points**' }], step: { kind: 'thought', text: 'Summarizing key points', detail: 'Summarizing key points' } },
    { name: 'bounded message', raw: [{ ts, type: 'answer_delta', data: 'x'.repeat(3000) }], step: { kind: 'message', text: 'x'.repeat(199) + '…', detail: 'x'.repeat(1999) + '…' } },
    { name: 'bounded thought', raw: [{ ts, type: 'reasoning_summary', data: 'x'.repeat(3000) }], step: { kind: 'thought', text: 'x'.repeat(199) + '…', detail: 'x'.repeat(1999) + '…' } },
  ])('maps $name without exposing tool output', ({ raw, step }) => {
    expect(stepsFromEvents(normalize(raw, { mergeToolResults: true }))).toEqual([{ i: 0, ts, ...step }])
  })

  it('maps a Codex reasoning summary to a thought without exposing raw thinking', () => {
    const parsed = parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Looking for the encryption key' } }))
    const raw = parsed.events.map(([type, data]) => ({ ts, type, data }))
    raw.push({ ts, type: 'thinking_delta', data: 'PRIVATE THINKING' })
    expect(stepsFromEvents(normalize(raw))).toEqual([{ i: 0, ts, kind: 'thought', text: 'Looking for the encryption key', detail: 'Looking for the encryption key' }])
  })

  it('polls without status or repeated reads, invalidates changed events and ends only from its journal', async () => {
    const repo = await realpath(await gitRepo())
    const store = createEventStore(repo)
    await store.writeMeta({ goalId: 'g', title: 'Build', createdAt: ts })
    await store.append('g', { type: 'run_started', goalId: 'g', assignmentId: 'a', actor: 'system', runId: 'run-1', agent: 'codex', cwd: repo })
    await store.append('g', { type: 'run_ended', goalId: 'g', assignmentId: 'b', actor: 'system', runId: 'another-run', outcome: 'completed' })
    const dir = join(runsDir(repo), 'run-1')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'events.jsonl')
    await writeFile(file, JSON.stringify(command('c1')))
    const fake = createFakeBackend()
    let eventReads = 0
    let journalReads = 0
    const readJournal = store.read
    store.read = async (id) => { journalReads++; return readJournal(id) }
    const read = createStepsReader(store, async () => ({
      ...fake.backend,
      status: async () => { throw new Error('a screen poll must never settle a run') },
      events: async () => { eventReads++; return (await readFile(file, 'utf8')).split('\n').map((line) => JSON.parse(line) as RawEvent) },
    }))
    const first = await read('run-1', 0)
    expect(first).toMatchObject({ done: false, steps: [{ text: 'pnpm test', status: 'running' }] })
    const again = await read('run-1', 0)
    expect(again).toEqual(first)
    expect(again?.steps).toBe(first?.steps)
    expect([eventReads, journalReads]).toEqual([1, 1])

    // Same byte size, new mtime: invalidate even without growth.
    await writeFile(file, JSON.stringify(command('c1')).replace('pnpm test', 'pnpm lint'))
    await utimes(file, new Date('2030-01-01'), new Date('2030-01-01'))
    expect(await read('run-1', 0)).toMatchObject({ steps: [{ text: 'pnpm lint' }] })
    expect([eventReads, journalReads]).toEqual([2, 1])
    await writeFile(file, [command('c1'), completed('c1')].map((e) => JSON.stringify(e)).join('\n'))
    expect(await read('run-1', 0)).toMatchObject({ done: false, steps: [{ status: 'done' }] })
    await store.append('g', { type: 'run_ended', goalId: 'g', assignmentId: 'a', actor: 'system', runId: 'run-1', outcome: 'completed' })
    expect(await read('run-1', 1)).toEqual({ steps: [], next: 1, done: true })
    expect([eventReads, journalReads]).toEqual([3, 1])
    const outside = join(await mkdtemp(join(tmpdir(), 'cb-outside-')), 'events.jsonl')
    await writeFile(outside, 'PRIVATE OUTSIDE DATA')
    await rm(file)
    await symlink(outside, file)
    expect(await read('run-1', 0)).toBeUndefined()
    expect(eventReads).toBe(3)
  })

  it('serves only project runs, pages newer steps and reports when a run ends', async () => {
    const t = await startApp()
    try {
      const get = (runId: string, since?: number, project = t.project) => fetch(`${t.server.url}/api/runs/${runId}/steps?project=${encodeURIComponent(project)}${since === undefined ? '' : `&since=${since}`}`)
      for (const id of ['unknown', 'bad%2Fid', 'bad%5Cid', 'bad%00id', 'bad%25id', '%E0%A4%A']) {
        const res = await get(id)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: expect.any(String) })
      }

      t.fake.script({ hold: true })
      const { goalId } = await t.call<{ goalId: string }>('crewboard_start_goal', { project: t.project, title: 'Build', criteria: [] })
      await t.call('crewboard_assign', { project: t.project, goalId, title: 'Check', criteria: [], resultKind: 'local', provider: 'codex' })
      await t.app.tick()
      const run = t.fake.runs[0]!
      const dir = join(runsDir(t.project), run.id)
      await mkdir(dir, { recursive: true })
      run.events.push({ ts, type: 'answer_delta', data: 'Checking the build' }, command('c1'), completed('c1'), { ts, type: 'usage', data: { used: 10, size: 100 } })
      const sync = () => writeFile(join(dir, 'events.jsonl'), run.events.map((e) => JSON.stringify(e)).join('\n'))
      await sync()
      const originalStatus = t.fake.backend.status
      t.fake.backend.status = async () => { throw new Error('a screen poll must never settle a run') }

      const first = await get(run.id)
      expect(first.status).toBe(200)
      const body = await first.json() as RunSteps
      expect(body).toMatchObject({ next: 2, done: false, context: { used: 10, size: 100 } })
      expect(body.steps.map((s) => [s.i, s.kind])).toEqual([[0, 'message'], [1, 'command']])
      expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT')
      expect(await (await get(run.id, body.next)).json()).toMatchObject({ steps: [], next: 2, done: false })
      expect((await get(run.id, 0, await gitRepo())).status).toBe(404)

      run.events.push(command('c2'), { ts, type: 'usage', data: JSON.stringify({ used: 25, size: 100 }) }, { ts, type: 'usage', data: { used: 30 } })
      await sync()
      const newer = await (await get(run.id, body.next)).json() as RunSteps
      expect(newer).toMatchObject({ steps: [{ i: 2, kind: 'command', status: 'running' }], next: 2, done: false, context: { used: 25, size: 100 } })

      run.events.push(completed('c2'))
      t.fake.finish(run.id, { final: '<crewboard-report>Checked</crewboard-report>' })
      await sync()
      expect(await (await get(run.id)).json()).toMatchObject({ done: false })
      t.fake.backend.status = originalStatus
      await t.app.tick()
      const finished = await (await get(run.id, newer.next)).json() as RunSteps
      expect(finished).toMatchObject({ next: 4, done: true })
      expect(finished.steps.map((s) => [s.i, s.kind, s.status])).toEqual([[2, 'command', 'done'], [3, 'final', undefined]])

      const outside = await mkdtemp(join(tmpdir(), 'cb-outside-'))
      await writeFile(join(outside, 'events.jsonl'), 'PRIVATE OUTSIDE DATA')
      await rm(join(dir, 'events.jsonl'))
      await symlink(join(outside, 'events.jsonl'), join(dir, 'events.jsonl'))
      const escaped = await get(run.id)
      expect(escaped.status).toBe(404)
      expect(await escaped.json()).toEqual({ error: expect.any(String) })
    } finally {
      await t.close()
    }
  })
})
