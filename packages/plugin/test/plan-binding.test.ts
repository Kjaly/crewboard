import { mkdtemp, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, createPlan, currentPlanFile, initPlan, loadPlan, newTask, setCurrentPlan, setPlanArchived, updatePlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import { writeChats } from '../src/host/chat.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'
import { orchestraTools, toDshTool } from '../src/host/tools.js'

const NOW = new Date('2026-09-24T12:00:00Z')
const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }

async function twoPlans() {
  const root = await mkdtemp(join(tmpdir(), 'orch-binding-'))
  await initPlan(root, 'Plan A', NOW)
  await createPlan(root, 'plan-b', 'Plan B', NOW)
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const tools = orchestraTools({ service, repos: [root], backendsFor: () => backends, env: {}, home: root, now: () => NOW })
  const tool = (name: string) => tools.find((t) => t.name === name) as (typeof tools)[number]
  return { root, service, tool }
}

// B22 (ux2 F2): the chat of plan B kept writing into whatever plan was current.
it('a chat bound to plan B cannot write into plan A through the tools', async () => {
  const { root, tool } = await twoPlans()
  await writeChats(root, { 'plan-b': { sessionId: 'sess-b', wake: true, boundAt: NOW.toISOString() } })
  // The person switched the CLI to plan A after the chat was bound to B.
  await setCurrentPlan(root, 'main')
  const call = { sessionId: 'sess-b' }
  await tool('orchestra_task_upsert').execute({ id: 'x1', title: 'X1' }, call)
  expect((await loadPlan(root, 'plan-b')).tasks.map((t) => t.id)).toEqual(['x1'])
  expect((await loadPlan(root, 'main')).tasks).toEqual([])
  // Naming another plan is refused, not silently ignored.
  await expect(tool('orchestra_task_upsert').execute({ id: 'x2', title: 'X2', plan: 'main' }, call)).rejects.toThrow(/plan-b/)
  await expect(tool('orchestra_decision').execute({ id: 'd1', title: 'D', plan: 'main' }, call)).rejects.toThrow(/plan-b/)
  expect((await loadPlan(root, 'main')).tasks).toEqual([])
  // The plan the chat reads is its own plan too.
  expect(await tool('orchestra_plan').execute({}, call)).toMatchObject({ planId: 'plan-b', tasks: [{ id: 'x1' }] })
  // dsh passes the calling agent — its session id — as the second argument of `execute`.
  await toDshTool(tool('orchestra_task_upsert')).execute({ id: 'x3', title: 'X3' }, { agent: { id: 'sess-b' } })
  expect((await loadPlan(root, 'plan-b')).tasks.map((t) => t.id)).toEqual(['x1', 'x3'])
})

it('an unbound chat acts on the plan it names, else the current one', async () => {
  const { root, tool } = await twoPlans()
  await tool('orchestra_task_upsert').execute({ id: 'a1', title: 'A1', plan: 'main' }, { sessionId: 'other' })
  await tool('orchestra_task_upsert').execute({ id: 'b1', title: 'B1' })
  expect((await loadPlan(root, 'main')).tasks.map((t) => t.id)).toEqual(['a1'])
  expect((await loadPlan(root, 'plan-b')).tasks.map((t) => t.id)).toEqual(['b1'])
})

it('browsing an archived plan on the screen leaves .orchestration/current unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-archive-view-'))
  await initPlan(root, 'Sprint 1', NOW)
  await updatePlan(root, (p) => { p.tasks.push({ ...newTask({ id: 'old', title: 'Old' }), status: 'in_review' }); return p })
  await createPlan(root, 'sprint2', 'Sprint 2', NOW)
  await setPlanArchived(root, 'main', true)
  const pointer = await readFile(currentPlanFile(root), 'utf8')
  expect(pointer.trim()).toBe('sprint2')
  const native: Native = { confirm: async () => true, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const post = async (name: string, body: unknown) => {
    const route = routes.find((r) => r.path === `/crewboard/api/${name}`)!
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; error?: string } }
  }
  try {
    expect((await post('plan-use', { repo: root, plan: 'main' })).status).toBe(200)
    // The screen shows the archive…
    expect(service.snapshot().repos[0]).toMatchObject({ planId: 'main', tasks: [{ id: 'old' }] })
    // …the CLI, the agents and other people keep their current plan.
    expect(await readFile(currentPlanFile(root), 'utf8')).toBe(pointer)
    // The archive is read-only from the screen: a change needs the plan restored first.
    expect(await post('task-status', { repo: root, task: 'old', status: 'ready' })).toMatchObject({ status: 409, json: { error: 'plan_archived' } })
    expect((await loadPlan(root, 'main')).tasks[0]?.status).toBe('in_review')
    // Opening an active plan is still «use this plan».
    expect((await post('plan-use', { repo: root, plan: 'sprint2' })).status).toBe(200)
    expect(service.snapshot().repos[0]?.planId).toBe('sprint2')
  } finally {
    await setCurrentPlan(root, 'sprint2')
  }
})
