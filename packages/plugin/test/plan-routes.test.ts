import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, currentPlanId, initPlan, listPlans, loadDraft, saveDraft } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-22T12:00:00Z')

it('creates, switches, archives and renames plans over HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-plan-routes-'))
  await initPlan(root, 'Старый', NOW)
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const native: Native = { confirm: async () => true, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const post = async (name: string, body: unknown) => {
    const route = routes.find((r) => r.path === `/crewboard/api/${name}`)
    if (!route) throw new Error(`no route ${name}`)
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; value?: { plan?: string }; error?: string } }
  }
  const created = await post('plan-new', { repo: root, goal: 'Рефактор чата' })
  expect(created).toMatchObject({ status: 200, json: { ok: true } })
  const id = created.json.value?.plan ?? ''
  expect(currentPlanId(root)).toBe(id)
  expect((await post('plan-use', { repo: root, plan: 'main' })).status).toBe(200)
  expect(currentPlanId(root)).toBe('main')
  expect((await post('plan-archive', { repo: root, plan: id })).status).toBe(200)
  expect((await listPlans(root)).find((p) => p.id === id)?.archived).toBe(true)
  expect((await post('plan-rename', { repo: root, plan: 'main', goal: 'Плагин' })).status).toBe(200)
  expect(await post('plan-use', { repo: root, plan: 'zzz' })).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
  expect(await post('plan-new', { repo: root, goal: 'x', plan: 'Bad Id' })).toMatchObject({ status: 400, json: { error: 'bad_plan' } })
})

it('requires native confirmation before approving a draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-draft-routes-'))
  await saveDraft(root, { id: 'draft-one', goal: 'Ship', source: 'chat', lanes: [], tasks: [], decisions: [] })
  let confirmed = false
  const native: Native = { confirm: async () => confirmed, notify: async () => {} }
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const post = async () => {
    const route = routes.find((r) => r.path === '/crewboard/api/plan-draft-approve')!
    const req = Readable.from([Buffer.from(JSON.stringify({ repo: root, id: 'draft-one' }))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return res.status
  }
  expect(await post()).toBe(409)
  expect(await loadDraft(root, 'draft-one')).toBeDefined()
  confirmed = true
  expect(await post()).toBe(200)
  expect((await listPlans(root)).map((p) => p.id)).toContain('draft-one')
})

it('refuses a draft whose graph cannot run before asking the human', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-draft-blocked-'))
  const task = { id: 'one', title: 'One', lane: 'core', class: 'code' as const, kind: 'implement' as const, deps: ['one'], contract: 'x', acceptance: ['ok'], sources: [] }
  await saveDraft(root, { id: 'draft-one', goal: 'Ship', source: 'chat', lanes: ['core'], tasks: [task], decisions: [] })
  let asked = false
  const native: Native = { confirm: async () => { asked = true; return true }, notify: async () => {} }
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const route = routes.find((r) => r.path === '/crewboard/api/plan-draft-approve')!
  const req = Readable.from([Buffer.from(JSON.stringify({ repo: root, id: 'draft-one' }))]) as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
  const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
  await route.handler(req, res as unknown as ServerResponse)
  expect(res.status).toBe(422)
  expect(JSON.parse(res.body)).toMatchObject({ error: 'draft_invalid' })
  expect(asked).toBe(false)
  expect(await listPlans(root)).toEqual([])
})
