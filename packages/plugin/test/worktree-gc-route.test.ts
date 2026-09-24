import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, EMPTY_RECIPE, WORKTREE_POLICIES, initPlan, loadPlan, newTask, nodeExec, prepareWorktree, saveWorktreePolicy, updatePlan, worktreeConfigPath } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const API = '/crewboard/api'
const JSON_HEADERS = { 'content-type': 'application/json', [CLIENT_HEADER]: '1' }

type FakeRes = { status?: number; headers?: Record<string, string>; body: string }

function fakeRes() {
  const res = {
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status
      res.headers = headers
      return res
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk
    },
  } as FakeRes & { writeHead: unknown; end: unknown }
  return res
}

function fakeReq(method: string, url: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers })
  return req
}

const idle: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
const native: Native = { confirm: async () => true, notify: async () => {} }
const gone = (p: string) => stat(p).then(() => false, () => true)

const SPECS = [
  { id: 'b', acceptAt: '2026-09-22T10:59:00Z' },
  { id: 'a1', acceptAt: '2026-09-22T11:00:00Z' },
  { id: 'a2', acceptAt: '2026-09-22T12:00:00Z' },
  { id: 'a3', acceptAt: '2026-09-22T12:01:00Z' },
  { id: 'a4', acceptAt: '2026-09-22T12:02:00Z' },
]

async function setup() {
  // These tests pin what a route removes; the background recheck of the «after acceptance» policy
  // would also collect other eligible copies, so the policy here is «on command».
  await saveWorktreePolicy(worktreeConfigPath(process.env, process.env.HOME ?? ''), WORKTREE_POLICIES[1])
  const root = await makeRepo()
  await initPlan(root, 'g', NOW)
  const copies = new Map<string, { path: string; branch: string }>()
  for (const spec of [...SPECS, { id: 't1', acceptAt: undefined }]) {
    const wt = await prepareWorktree({ repoRoot: root, taskId: spec.id, title: spec.id, recipe: EMPTY_RECIPE, exec: nodeExec })
    copies.set(spec.id, { path: wt.path, branch: wt.branch })
  }
  await updatePlan(root, (plan) => {
    plan.tasks = SPECS.map((spec) => ({
      ...newTask({ id: spec.id, title: spec.id }),
      status: 'accepted',
      worktree: copies.get(spec.id)!,
      notes: [{ at: spec.acceptAt, type: 'accept' as const, text: 'принято' }],
    }))
    plan.tasks.push({ ...newTask({ id: 't1', title: 't1' }), status: 'in_review', worktree: copies.get('t1')! })
    return plan
  })
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => idle, native, env: {}, home: root, now: () => NOW })
  const call = async (method: string, url: string, body?: unknown) => {
    const pathname = url.split('?')[0]
    const route = routes.find((r) => r.path === pathname)
    if (!route) throw new Error(`no route ${pathname}`)
    const res = fakeRes()
    await route.handler(fakeReq(method, url, body), res as unknown as ServerResponse)
    const json = res.headers?.['content-type']?.startsWith('application/json') ? (JSON.parse(res.body) as Record<string, unknown>) : undefined
    return { status: res.status, json }
  }
  return { root, copies, call }
}

describe('worktree gc routes', () => {
  it('removes only the sent ids and answers with the removed list', async () => {
    const { root, copies, call } = await setup()
    const res = await call('POST', `${API}/worktree-gc`, { repo: root, tasks: ['a1'] })
    expect(res.status).toBe(200)
    expect((res.json!.value as { removed: string[] }).removed).toEqual(['a1'])
    expect(await gone(copies.get('a1')!.path)).toBe(true)
    // The other eligible copy was not sent, so it stays; the three recent ones are never candidates.
    expect(await gone(copies.get('b')!.path)).toBe(false)
    expect(await gone(copies.get('a4')!.path)).toBe(false)
  })

  it('acceptance removes only that task copy and writes one line into the feed', async () => {
    const { root, copies, call } = await setup()
    const res = await call('POST', `${API}/accept`, { repo: root, task: 't1' })
    expect(res.status).toBe(200)
    expect((res.json!.value as { worktreeRemoved: boolean }).worktreeRemoved).toBe(true)
    expect(await gone(copies.get('t1')!.path)).toBe(true)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 't1')?.notes.at(-1)).toMatchObject({ text: 'Worktree removed after acceptance.' })
    expect(await gone(copies.get('b')!.path)).toBe(false)
  })

  it('lists the copies with their reasons and total size', async () => {
    const { root, call } = await setup()
    const res = await call('GET', `${API}/worktrees?repo=${encodeURIComponent(root)}`)
    expect(res.status).toBe(200)
    const value = res.json!.value as { candidates: Array<{ taskId: string; keep?: string }>; totalBytes: number; policy: string }
    expect(value.candidates.find((c) => c.taskId === 'a1')?.keep).toBeUndefined()
    expect(value.candidates.find((c) => c.taskId === 'a4')?.keep).toBe('recent')
    expect(value.totalBytes).toBeGreaterThan(0)
    expect(value.policy).toBe('после приёмки')
  })

  it('refuses a copy that is not eligible, naming the reason', async () => {
    const { root, call } = await setup()
    const res = await call('POST', `${API}/worktree-gc`, { repo: root, tasks: ['a4'] })
    expect(res.status).toBe(200)
    expect((res.json!.value as { removed: string[] }).removed).toEqual([])
    expect((res.json!.value as { failed: Array<{ taskId: string; reason: string }> }).failed[0]).toMatchObject({
      taskId: 'a4',
      reason: 'recent',
    })
  })
})
