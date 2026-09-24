import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { type Backends, type Exec, loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import { OrchestraService } from '../src/host/service.js'

const API = '/crewboard/api'
const backend: Backends = { forAgent: async () => { throw new Error('backend must not be used') } }
const now = new Date('2026-09-23T12:00:00Z')

async function setup() {
  const root = await makeRepo()
  const confirm = vi.fn(async () => true)
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backend, now: () => now })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backend, native: { confirm, notify: async () => {} }, env: {}, home: root, now: () => now })
  const call = async (method: string, name: string, body?: Record<string, unknown>) => {
    const url = `${API}/${name}`
    const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify({ repo: root, ...body }))] : []) as unknown as IncomingMessage
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(status: number) { this.status = status; return this }, end(text?: string) { this.body += text ?? '' } }
    const route = routes.find((r) => r.path === url.split('?')[0])
    if (!route) throw new Error(`missing route: ${url}`)
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, body: JSON.parse(res.body) as { ok: boolean; error?: string; value?: unknown } }
  }
  return { root, call, confirm }
}

it('writes a validated recipe through the guarded route without executing it', async () => {
  const { root, call } = await setup()
  await writeFile(join(root, 'package-lock.json'), '{}')
  const info = await call('GET', `recipe?repo=${encodeURIComponent(root)}`)
  expect(info.body.value).toMatchObject({ recipe: null, detected: { setup: ['npm ci'], baseline: 'npm test' } })
  const saved = await call('POST', 'recipe-save', { recipe: { setup: ['touch DO_NOT_RUN'], baseline: 'npm test', timeoutSec: 120 } })
  expect(saved.status).toBe(200)
  expect(await readFile(join(root, '.orchestration/recipes.json'), 'utf8')).toContain('DO_NOT_RUN')
  expect(await stat(join(root, 'DO_NOT_RUN')).then(() => true, () => false)).toBe(false)
  const invalid = await call('POST', 'recipe-save', { recipe: { setup: [], timeoutSec: 0 } })
  expect(invalid.status).toBe(400)
})

it('creates, labels, guards, and removes the example through host routes', async () => {
  const { root, call, confirm } = await setup()
  expect((await call('POST', 'example-create', { lang: 'ru' })).status).toBe(200)
  expect(await loadPlan(root)).toMatchObject({ example: true, exampleLang: 'ru', goal: 'Посмотрите, как работает план' })
  for (const [name, body] of [['run', { task: 'analytics' }], ['relaunch', { task: 'build' }], ['steer', { task: 'api', message: 'x' }], ['accept', { task: 'build' }], ['reject', { task: 'build', reason: 'x' }], ['accept-batch', { tasks: ['build'] }], ['pos', { planId: 'orchestra-example', expectedRev: 2, positions: [] }]] as const) {
    const refused = await call('POST', name, body)
    expect(refused).toMatchObject({ status: 409, body: { error: 'example_plan' } })
  }
  expect(confirm).not.toHaveBeenCalled()
  // Review, the run ledger and the task review read the synthetic store, clearly marked as example data.
  const cost = (await call('GET', `cost?repo=${encodeURIComponent(root)}`)).body.value as { synthetic?: boolean; runs: Array<{ runId: string; cashUsd?: { source: string }; apiEquivalentUsd?: { source: string }; availability?: { cash: string } }>; tasks: Array<{ taskId: string; reviewWaitMs: number; runIds: string[] }> }
  expect(cost.synthetic).toBe(true)
  expect(cost.runs.length).toBeGreaterThanOrEqual(7)
  expect(cost.runs.some((run) => run.cashUsd?.source === 'example_fixture')).toBe(true)
  expect(cost.runs.some((run) => run.apiEquivalentUsd?.source === 'example_fixture')).toBe(true)
  expect(cost.runs.some((run) => !run.cashUsd && !run.apiEquivalentUsd && run.availability?.cash === 'unavailable')).toBe(true)
  expect(cost.tasks.find((task) => task.taskId === 'build')?.reviewWaitMs).toBeGreaterThan(60 * 60_000)
  expect(cost.tasks.find((task) => task.taskId === 'copy')?.runIds).toHaveLength(2)
  const trace = (await call('GET', `trace?repo=${encodeURIComponent(root)}&id=build`)).body.value as { synthetic?: boolean; records: unknown[]; cost: { apiEquivalentUsd?: unknown } }
  expect(trace.synthetic).toBe(true)
  expect(trace.records.length).toBeGreaterThan(3)
  expect(trace.cost.apiEquivalentUsd).toBeDefined()
  const review = (await call('GET', `task-review?repo=${encodeURIComponent(root)}&task=copy`)).body.value as { synthetic?: boolean; attempts: unknown[]; decisions: Array<{ type: string }> }
  expect(review).toMatchObject({ synthetic: true })
  expect(review.attempts).toHaveLength(2)
  expect(review.decisions.map((decision) => decision.type)).toEqual(['reject', 'accept'])
  expect((await call('POST', 'example-remove')).status).toBe(200)
  for (const path of ['.orchestration/plans/orchestra-example.json', '.orchestration/example', '.orchestration/runs/run_example-build-1']) expect(await stat(join(root, path)).then(() => true, () => false)).toBe(false)
})

it('the welcome list calls a signed-out Codex «sign in», never «ready», and checks the launch binary', async () => {
  const root = await makeRepo()
  const seen: string[] = []
  const exec: Exec = async (cmd, args) => {
    seen.push(`${cmd} ${args.join(' ')}`)
    if (cmd === '/opt/fake/codex' && args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.154.0', stderr: '', timedOut: false }
    if (cmd === '/opt/fake/codex' && args.join(' ') === 'login status') return { code: 1, stdout: 'Not logged in', stderr: '', timedOut: false }
    return { code: 127, stdout: '', stderr: 'not found', timedOut: false }
  }
  const env = { CREWBOARD_CODEX_COMMAND: '/opt/fake/codex' }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backend, now: () => now })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backend, native: { confirm: async () => true, notify: async () => {} }, env, home: root, now: () => now, exec })
  const route = routes.find((r) => r.path === `${API}/onboarding-workers`)
  if (!route) throw new Error('missing route')
  const req = Readable.from([]) as unknown as IncomingMessage
  Object.assign(req, { method: 'GET', url: `${API}/onboarding-workers?repo=${encodeURIComponent(root)}`, headers: { [CLIENT_HEADER]: '1' } })
  const res = { status: 0, body: '', writeHead(status: number) { this.status = status; return this }, end(text?: string) { this.body += text ?? '' } }
  await route.handler(req, res as unknown as ServerResponse)
  const workers = (JSON.parse(res.body) as { value: Array<{ id: string; status: string }> }).value
  const codex = workers.find((w) => w.id.startsWith('codex'))
  expect(codex?.status).toBe('sign_in')
  expect(workers.filter((w) => w.status === 'ready')).toEqual([])
  expect(seen).toContain('/opt/fake/codex login status')
  expect(seen.some((line) => line.startsWith('codex '))).toBe(false)
})
