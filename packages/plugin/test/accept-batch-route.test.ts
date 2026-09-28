import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, type RunBackend, initPlan, loadPlan, newTask, updatePlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const PATH = '/crewboard/api/accept-batch'
const POS_PATH = '/crewboard/api/pos'

function fakeRes() {
  const res = {
    status: 0,
    body: '',
    writeHead(status: number) {
      res.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk
    },
  }
  return res
}

async function setup(answer: boolean, path = PATH) {
  const root = await mkdtemp(join(tmpdir(), 'orch-batch-route-'))
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(
      { ...newTask({ id: 'a', title: 'Задача A' }), status: 'in_review', runs: [{ runId: 'run_a', agent: 'dsh', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), outcome: 'completed' }] },
      { ...newTask({ id: 'b', title: 'Задача B' }), status: 'in_review' },
      newTask({ id: 'd', title: 'Решение D', kind: 'decision' }),
      newTask({ id: 'r', title: 'Готова R' }),
      { ...newTask({ id: 'x', title: 'Идёт X' }), runs: [{ runId: 'run_dsh-x', agent: 'dsh', startedAt: '2026-09-22T11:59:00Z' }] },
    )
    return p
  })
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-y',
    events: async (id) => id === 'run_a' ? [{ ts: NOW.toISOString(), type: 'final', data: 'Результат: отрицательный' }] : id === 'run_c' ? [{ ts: NOW.toISOString(), type: 'final', data: 'Результат: получен' }] : [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const dialogs: string[][] = []
  const native: Native = {
    confirm: async (_t, message, okLabel) => {
      dialogs.push([message, okLabel])
      return answer
    },
    notify: async () => {},
  }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const route = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW }).find((r) => r.path === path)
  if (!route) throw new Error('no accept-batch route')
  const post = async (body: unknown) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = fakeRes()
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as Record<string, unknown> }
  }
  return { root, post, dialogs }
}

describe('POST /accept-batch', () => {
  it('accepts reviewed tasks after one native confirmation listing them', async () => {
    const { root, post, dialogs } = await setup(true)
    expect(await post({ repo: root, tasks: ['a', 'b'] })).toMatchObject({ status: 200, json: { ok: true, value: { accepted: ['a', 'b'] } } })
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]?.[0]).toContain('a — Задача A')
    expect(dialogs[0]?.[0]).not.toContain('d — Решение D')
    expect(dialogs[0]?.[0]).toContain('a — Negative result: a negative result was reported')
    expect(dialogs[0]?.[0]).toContain('b — Disputed: the report makes no explicit result claim')
    expect(dialogs[0]?.[1]).toBe('Accept 2')
    expect(dialogs[0]?.[0]).toContain('Accept 2 tasks? 0 clean, 2 at risk.')
    expect((await loadPlan(root)).tasks.filter((t) => t.status === 'accepted').map((t) => t.id)).toEqual(['a', 'b'])
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'a')?.notes.at(-1)?.verdict).toMatchObject({ kind: 'negative', why: 'negative' })
  })

  // dc1: a decision never closes in a batch — the whole list is refused before the dialog, atomically,
  // and the decision stays where the person can confirm it by itself.
  it('refuses a batch that lists a decision, without a dialog or a partial write', async () => {
    const { root, post, dialogs } = await setup(true)
    const res = await post({ repo: root, tasks: ['a', 'd'] })
    expect(res).toMatchObject({ status: 409, json: { error: 'decision_batch' } })
    expect(String(res.json.message)).toContain('d')
    expect(dialogs).toHaveLength(0)
    const plan = await loadPlan(root)
    expect(plan.tasks.find((t) => t.id === 'a')?.status).toBe('in_review')
    expect(plan.tasks.find((t) => t.id === 'd')?.status).toBe('ready')
    // Alone, too — a decision is confirmed one by one in the panel or recorded from chat.
    expect(await post({ repo: root, tasks: ['d'] })).toMatchObject({ status: 409, json: { error: 'decision_batch' } })
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'd')?.status).toBe('ready')
  })

  // rt1: a root task without the orchestrator's «done» is named before anything is accepted.
  it('names root tasks the orchestrator has not checked, and only those', async () => {
    const { root, post, dialogs } = await setup(true)
    await updatePlan(root, (p) => {
      p.tasks.push(
        { ...newTask({ id: 'i1', title: 'Стенд I1', kind: 'root' }), status: 'in_review' },
        { ...newTask({ id: 'i2', title: 'Стенд I2', kind: 'root' }), status: 'in_review', check: { state: 'checked', at: NOW.toISOString(), note: 'Result: received' } },
      )
      return p
    })
    expect(await post({ repo: root, tasks: ['a', 'i1', 'i2'] })).toMatchObject({ status: 200 })
    const [message] = dialogs[0] ?? []
    const unchecked = message?.split('Not checked by the orchestrator')[1] ?? ''
    expect(unchecked).toContain('i1 — Стенд I1')
    expect(unchecked).not.toContain('i2 — ')
    expect(unchecked).not.toContain('a — ')
  })

  it('counts clean and risky work in the confirmation (w1b, B03)', async () => {
    const { root, post, dialogs } = await setup(true)
    await updatePlan(root, (p) => {
      p.tasks.push({ ...newTask({ id: 'e', title: 'Работа E' }), status: 'in_review', runs: [{ runId: 'run_c', agent: 'dsh', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), outcome: 'completed' }] })
      return p
    })
    expect(await post({ repo: root, tasks: ['a', 'b', 'e'] })).toMatchObject({ status: 200 })
    // a is negative, b makes no claim, e claimed a result with no changed files: all at risk.
    expect(dialogs[0]?.[0]).toContain('Accept 3 tasks? 0 clean, 3 at risk.')
    expect(dialogs[0]?.[0]).toContain('e — Disputed')
  })

  it('names no unchecked own work when the batch holds only worker tasks', async () => {
    const { root, post, dialogs } = await setup(true)
    expect(await post({ repo: root, tasks: ['a', 'b'] })).toMatchObject({ status: 200 })
    expect(dialogs[0]?.[0]).not.toContain('Not checked by the orchestrator')
  })

  it('refuses the whole batch when a task is not waiting for review, without asking', async () => {
    const { root, post, dialogs } = await setup(true)
    const res = await post({ repo: root, tasks: ['a', 'r', 'x'] })
    expect(res).toMatchObject({ status: 409, json: { error: 'not_reviewable' } })
    expect(String(res.json.message)).toContain('r')
    expect(String(res.json.message)).toContain('x')
    expect(dialogs).toHaveLength(0)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'a')?.status).toBe('in_review')
  })

  it('keeps the plan unchanged when the human cancels, and validates the list', async () => {
    const { root, post } = await setup(false)
    expect(await post({ repo: root, tasks: ['a'] })).toMatchObject({ status: 409, json: { error: 'declined' } })
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'a')?.status).toBe('in_review')
    expect(await post({ repo: root, tasks: [] })).toMatchObject({ status: 400, json: { error: 'bad_request' } })
    expect(await post({ repo: root, tasks: 'a' })).toMatchObject({ status: 400, json: { error: 'bad_request' } })
    expect(await post({ repo: root, tasks: Array.from({ length: 51 }, (_, i) => `t${i}`) })).toMatchObject({ status: 400, json: { error: 'bad_request' } })
  })
})

it('POST /pos applies a batch to its named plan and refuses a stale revision without partial writes', async () => {
  const { root, post } = await setup(true, POS_PATH)
  const before = await loadPlan(root)
  const ok = await post({ repo: root, planId: 'main', expectedRev: before.rev, positions: [{ task: 'a', pos: { x: 1, y: 2 } }, { task: 'b', pos: { x: 3, y: 4 } }] })
  expect(ok.status).toBe(200)
  const committed = await loadPlan(root)
  expect(committed.rev).toBe(before.rev + 1)
  expect(committed.tasks.find((task) => task.id === 'a')?.pos).toEqual({ x: 1, y: 2 })
  const stale = await post({ repo: root, planId: 'main', expectedRev: before.rev, positions: [{ task: 'a', pos: null }, { task: 'b', pos: null }] })
  expect(stale.status).toBe(409)
  const afterRefusal = await loadPlan(root)
  expect(afterRefusal.tasks.find((task) => task.id === 'a')?.pos).toEqual({ x: 1, y: 2 })
})

// w1f: dropping is human-only like reject: nothing changes without the native confirmation.
describe('POST /drop', () => {
  it('closes the task for good only after the person confirms', async () => {
    const declined = await setup(false, '/crewboard/api/drop')
    expect((await declined.post({ repo: declined.root, task: 'r', reason: 'not needed' })).status).not.toBe(200)
    expect((await loadPlan(declined.root)).tasks.find((t) => t.id === 'r')?.status).toBe('ready')
    const { root, post, dialogs } = await setup(true, '/crewboard/api/drop')
    expect(await post({ repo: root, task: 'r', reason: 'not needed' })).toMatchObject({ status: 200, json: { ok: true, value: { task: 'r', status: 'dropped' } } })
    expect(dialogs[0]).toEqual(['Close task r as not needed: “not needed”? It will not come back to the queue.', 'Close task'])
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'r')).toMatchObject({ status: 'dropped', notes: [{ event: { kind: 'dropped', reason: 'not needed' } }] })
  })

  it('refuses a task whose worker is still running', async () => {
    const { root, post } = await setup(true, '/crewboard/api/drop')
    expect((await post({ repo: root, task: 'x', reason: 'not needed' })).status).not.toBe(200)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'x')?.status).toBe('ready')
  })
})
