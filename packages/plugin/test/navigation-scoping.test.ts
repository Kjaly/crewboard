import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, createPlan, currentPlanId, initPlan, loadPlan, newTask, planPath, plansDir, setCurrentPlan, updatePlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { orchestraRoutes } from '../src/host/routes.js'
import { OrchestraService } from '../src/host/service.js'
import { makeRepo } from '../../core/test/git-helpers.js'

const NOW = new Date('2026-09-28T12:00:00Z')

const running: Backends = {
  forAgent: async () => ({
    id: 'dsh',
    launch: async () => 'run_a',
    events: async () => [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async () => {},
    cancel: async () => {},
  }),
}

const native: Native = { confirm: async () => true, notify: async () => {} }

function harness(root: string) {
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => running, now: () => NOW })
  const routes = [...orchestraRoutes(service), ...actionRoutes({ service, repos: [root], backendsFor: () => running, native, env: {}, home: root, now: () => NOW })]
  const call = async (method: string, url: string, body?: unknown) => {
    const route = routes.find((r) => r.path === url.split('?')[0])
    if (!route) throw new Error(`no route ${url}`)
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; value?: Record<string, unknown>; error?: string } }
  }
  return { service, call }
}

async function twoPlans() {
  const root = await makeRepo()
  await createPlan(root, 'p1', 'One plan', NOW)
  await createPlan(root, 'p2', 'Two plan', NOW)
  await setCurrentPlan(root, 'p1')
  await updatePlan(root, (plan) => { plan.tasks.push(newTask({ id: 'shared', title: 'Older', status: 'ready' })); return plan }, 5, 'p1')
  await updatePlan(root, (plan) => { plan.tasks.push(newTask({ id: 'shared', title: 'Newer', status: 'ready' })); return plan }, 5, 'p2')
  return root
}

it('reads and mutates an explicitly selected plan without moving the current pointer or touching the other plan', async () => {
  const root = await twoPlans()
  const { call } = harness(root)
  const enc = encodeURIComponent(root)

  // A read of P2 answers P2's task with the same id, and leaves the CLI current plan (P1) and P1's task alone.
  const readP2 = await call('GET', `/crewboard/api/task?repo=${enc}&id=shared&plan=p2`)
  expect(readP2).toMatchObject({ status: 200, json: { ok: true } })
  expect(readP2.json.value?.title).toBe('Newer')
  const readP1 = await call('GET', `/crewboard/api/task?repo=${enc}&id=shared`)
  expect(readP1.json.value?.title).toBe('Older')
  expect(currentPlanId(root)).toBe('p1')

  // A mutation scoped to P2 writes P2 only.
  expect((await call('POST', '/crewboard/api/task-status', { repo: root, task: 'shared', status: 'backlog', plan: 'p2' })).status).toBe(200)
  expect((await loadPlan(root, 'p1')).tasks.find((task) => task.id === 'shared')?.status).toBe('ready')
  expect((await loadPlan(root, 'p2')).tasks.find((task) => task.id === 'shared')?.status).toBe('backlog')
  expect(currentPlanId(root)).toBe('p1')

  // Omitted plan keeps the legacy current-plan behavior (P1).
  expect((await call('POST', '/crewboard/api/task-status', { repo: root, task: 'shared', status: 'backlog' })).status).toBe(200)
  expect((await loadPlan(root, 'p1')).tasks.find((task) => task.id === 'shared')?.status).toBe('backlog')
  expect((await loadPlan(root, 'p2')).tasks.find((task) => task.id === 'shared')?.status).toBe('backlog')

  // Invalid or empty plan fails closed: no fallback to current, nothing written.
  expect(await call('GET', `/crewboard/api/task?repo=${enc}&id=shared&plan=nope`)).toMatchObject({ status: 404, json: { error: 'bad_plan' } })
  expect(await call('GET', `/crewboard/api/task?repo=${enc}&id=shared&plan=`)).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
  expect(await call('GET', `/crewboard/api/task?repo=${enc}&id=shared&plan=%20`)).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
  expect(await call('POST', '/crewboard/api/task-status', { repo: root, task: 'shared', status: 'ready', plan: 'nope' })).toMatchObject({ status: 404, json: { error: 'bad_plan' } })
  expect(await call('POST', '/crewboard/api/task-status', { repo: root, task: 'shared', status: 'ready', plan: '' })).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
  expect((await loadPlan(root, 'p2')).tasks.find((task) => task.id === 'shared')?.status).toBe('backlog')

  // `plan` and `planId` naming different plans is refused rather than silently preferring one.
  expect(await call('POST', '/crewboard/api/task-status', { repo: root, task: 'shared', status: 'ready', plan: 'p1', planId: 'p2' })).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
  // The legacy `planId` field is accepted as the scope on its own.
  expect((await call('POST', '/crewboard/api/task-status', { repo: root, task: 'shared', status: 'ready', planId: 'p2' })).status).toBe(200)
  expect((await loadPlan(root, 'p2')).tasks.find((task) => task.id === 'shared')?.status).toBe('ready')
})

it('serves a full read-only plan-state, rejects an explicit empty plan, and keeps the current pointer', async () => {
  const root = await twoPlans()
  const { call, service } = harness(root)
  await service.refresh(root)
  const enc = encodeURIComponent(root)

  const state = await call('GET', `/crewboard/api/plan-state?repo=${enc}&plan=p2`)
  expect(state).toMatchObject({ status: 200, json: { ok: true } })
  expect(state.json.value?.planId).toBe('p2')
  expect(typeof state.json.value?.generation).toBe('number')
  expect(currentPlanId(root)).toBe('p1')

  // Omitted plan is the served current plan; explicit empty/unknown fails closed.
  expect((await call('GET', `/crewboard/api/plan-state?repo=${enc}`)).json.value?.planId).toBe('p1')
  expect(await call('GET', `/crewboard/api/plan-state?repo=${enc}&plan=`)).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
  expect(await call('GET', `/crewboard/api/plan-state?repo=${enc}&plan=nope`)).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
  expect(currentPlanId(root)).toBe('p1')
})

it('projects current work from the served plans and marks an unreadable plan unknown, not empty', async () => {
  const root = await makeRepo()
  await initPlan(root, 'main', NOW)
  await updatePlan(root, (plan) => { plan.tasks.push({ ...newTask({ id: 'live', title: 'Live' }), runs: [{ runId: 'run_a', agent: 'dsh', startedAt: NOW.toISOString() }] }); return plan })
  await mkdir(plansDir(root), { recursive: true })
  await writeFile(planPath(root, 'broken'), '{ not json')
  const { service } = harness(root)
  await service.refresh()
  const snapshot = service.snapshot()
  expect(snapshot.now?.coverage).toBe('unknown')
  expect(snapshot.now?.unknown).toEqual(expect.arrayContaining([{ root, planId: 'broken' }]))
  expect(snapshot.now?.items.find((item) => item.taskId === 'live')).toMatchObject({ stage: 'worker', planId: 'main', root })
  expect(snapshot.repos[0]?.generation).toBeTypeOf('number')
})

it('invalidates a cached plan-state when the repository is refreshed even if the plan revision did not move', async () => {
  const root = await makeRepo()
  await initPlan(root, 'g', NOW)
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => running, now: () => NOW })
  await service.refresh(root)
  const first = await service.planState(root, 'main')
  // Runtime-only movement with the same revision: rewrite the record in place.
  const file = planPath(root, 'main')
  const raw = JSON.parse(await readFile(file, 'utf8')) as { updatedAt: string }
  raw.updatedAt = new Date(NOW.getTime() + 60_000).toISOString()
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`)
  await service.refresh(root)
  const second = await service.planState(root, 'main')
  expect(first.rev).toBe(second.rev)
  expect(second.updatedAt).not.toBe(first.updatedAt)
  expect(second.generation).not.toBe(first.generation)
  await expect(service.planState(root, '  ')).rejects.toThrow()
})
