import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, type DshWorkspace, loadPlan, planPath } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Route } from '../src/host/dsh.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const idle: Backends = { forAgent: async () => Promise.reject(new Error('no backend in this test')) }
const native: Native = { confirm: async () => true, notify: async () => {} }

type Json = { ok: boolean; value?: Record<string, unknown>; error?: string }
const call = async (routes: Route[], name: string, body: unknown): Promise<{ status: number; json: Json }> => {
  const route = routes.find((r) => r.path === `/crewboard/api/${name}`)
  if (!route) throw new Error(`no route ${name}`)
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
  const res = {
    status: 0,
    body: '',
    writeHead(s: number) {
      res.status = s
      return res
    },
    end(c?: string) {
      if (c) res.body += c
    },
  }
  await route.handler(req, res as unknown as ServerResponse)
  return { status: res.status, json: JSON.parse(res.body) as Json }
}

describe('plan-init over HTTP', () => {
  it('sees a dsh workspace without a plan and creates one on demand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-plan-init-'))
    const workspace: DshWorkspace = { id: 'w1', path: root, title: 'Мой воркспейс' }
    const workspaces = () => [workspace]
    const service = new OrchestraService({ config: { repos: [], refreshMs: 60_000 }, workspaces, backendsFor: () => idle, now: () => NOW })
    const routes = actionRoutes({ service, repos: [], workspaces, backendsFor: () => idle, native, env: {}, home: root, now: () => NOW })

    await service.refresh()
    expect(service.snapshot().repos[0]).toMatchObject({ root, title: 'Мой воркспейс', hasPlan: false, degraded: false })

    const created = await call(routes, 'plan-init', { repo: root, goal: 'Первый план' })
    expect(created.status).toBe(200)
    expect(created.json).toMatchObject({ ok: true, value: { root, title: 'Мой воркспейс', hasPlan: true, goal: 'Первый план' } })
    expect((await loadPlan(root)).goal).toBe('Первый план')
    expect(planPath(root)).toBe(join(root, '.orchestration', 'plan.json'))

    const again = await call(routes, 'plan-init', { repo: root, goal: 'Второй план' })
    expect(again).toMatchObject({ status: 409, json: { ok: false, error: 'plan_exists' } })
  })

  it('refuses a repo that is neither a workspace nor a configured repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-plan-init-unknown-'))
    const service = new OrchestraService({ config: { repos: [], refreshMs: 60_000 }, workspaces: () => [], backendsFor: () => idle, now: () => NOW })
    const routes = actionRoutes({ service, repos: [], workspaces: () => [], backendsFor: () => idle, native, env: {}, home: root, now: () => NOW })
    expect(await call(routes, 'plan-init', { repo: root, goal: 'x' })).toMatchObject({ status: 400, json: { ok: false, error: 'unknown_repo' } })
  })
})
