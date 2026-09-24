import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, type RunBackend, listDraftJobs, loadDraft } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-24T12:00:00Z')
const good = { id: 'bye-plan', goal: 'Bye', source: 'chat', lanes: ['core'], tasks: [], decisions: [] as unknown[] }

type FakeRun = { done: boolean; answer?: string; prompt: string }
function fakeBackends(runs: Map<string, FakeRun>): Backends {
  const backend: RunBackend = {
    id: 'codex',
    launch: async ({ promptFile }) => { const id = `run_fake-${runs.size + 1}`; runs.set(id, { done: false, prompt: await readFile(promptFile, 'utf8') }); return id },
    status: async (id) => ({ status: runs.get(id)!.done ? 'completed' : 'running', terminal: runs.get(id)!.done, exitCode: 0 }),
    events: async (id) => { const run = runs.get(id)!; return run.answer === undefined ? [] : [{ ts: '', type: 'final', data: run.answer }] },
    steer: async () => {},
    cancel: async () => {},
  }
  return { forAgent: async () => backend }
}

async function host(root: string, runs: Map<string, FakeRun>) {
  const backends = fakeBackends(runs)
  const native: Native = { confirm: async () => true, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const call = async (method: 'GET' | 'POST', name: string, body: Record<string, string> = {}) => {
    const route = routes.find((r) => r.path === `/crewboard/api/${name}`)
    if (!route) throw new Error(`no route ${name}`)
    const url = method === 'GET' ? `${route.path}?${new URLSearchParams({ repo: root, ...body })}` : route.path
    const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify({ repo: root, ...body }))] : []) as unknown as IncomingMessage
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; value?: any; error?: string } }
  }
  return { service, call }
}

it('starts a draft as a job, keeps a refused answer for repair and turns the repair into a draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-draft-job-routes-'))
  await writeFile(join(root, 'bye.txt'), '# Bye')
  const runs = new Map<string, FakeRun>()
  const { call } = await host(root, runs)
  const started = await call('POST', 'plan-draft-from', { file: 'bye.txt' })
  expect(started).toMatchObject({ status: 200, json: { ok: true, value: { job: { status: 'running', spec: 'bye.txt', agent: expect.any(String) } } } })
  const id: string = started.json.value.job.id
  expect(runs.get('run_fake-1')!.prompt).toContain('PlanDraft JSON Schema')
  Object.assign(runs.get('run_fake-1')!, { done: true, answer: JSON.stringify({ ...good, decisions: [7] }) })
  const listed = await call('GET', 'plan-draft-jobs')
  expect(listed.json.value).toMatchObject([{ id, status: 'needs_repair', findings: [{ path: 'decisions[0]' }] }])
  expect((await call('GET', 'plan-draft-job', { id })).json.value).toMatchObject({ job: { id, status: 'needs_repair' }, answer: expect.stringContaining('"decisions":[7]') })
  expect(await call('POST', 'plan-draft-job-repair', { id })).toMatchObject({ status: 200, json: { value: { status: 'running', attempts: 2 } } })
  expect(runs.get('run_fake-2')!.prompt).toContain('`decisions[0]`')
  Object.assign(runs.get('run_fake-2')!, { done: true, answer: JSON.stringify(good) })
  expect((await call('GET', 'plan-draft-jobs')).json.value).toEqual([])
  expect((await call('GET', 'plan-draft-job', { id })).json.value.job).toMatchObject({ status: 'completed', draftId: 'bye-plan' })
  expect(await loadDraft(root, 'bye-plan')).toMatchObject({ source: { name: 'bye.txt' } })
  expect(await call('POST', 'plan-draft-job-repair', { id })).toMatchObject({ status: 409, json: { error: 'not_repairable' } })
})

it('a restarted host finishes a job the previous host started, on its own refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-draft-job-restart-'))
  await writeFile(join(root, 'bye.txt'), '# Bye')
  const runs = new Map<string, FakeRun>()
  const first = await host(root, runs)
  const id: string = (await first.call('POST', 'plan-draft-from', { file: 'bye.txt' })).json.value.job.id
  // The first host is gone before the worker finishes.
  Object.assign(runs.get('run_fake-1')!, { done: true, answer: JSON.stringify(good) })
  const second = await host(root, runs)
  await second.service.refresh(root)
  expect((await listDraftJobs(root)).find((job) => job.id === id)).toMatchObject({ status: 'completed', draftId: 'bye-plan' })
})

it('saves an uploaded or pasted spec under .orchestration/specs and drafts it like a repository file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-spec-upload-'))
  const runs = new Map<string, FakeRun>()
  const { call } = await host(root, runs)
  const uploaded = await call('POST', 'spec-upload', { name: 'Product Brief.md', text: '# Brief\n\nShip the welcome screen.' })
  expect(uploaded).toMatchObject({ status: 200, json: { ok: true, value: { path: '.orchestration/specs/2026-09-24-product-brief.md', job: { status: 'running', spec: '.orchestration/specs/2026-09-24-product-brief.md' } } } })
  expect(await readFile(join(root, '.orchestration/specs/2026-09-24-product-brief.md'), 'utf8')).toContain('Ship the welcome screen')
  expect(runs.get('run_fake-1')!.prompt).toContain('Ship the welcome screen')
  const pasted = await call('POST', 'spec-upload', { text: '# Billing rework\nMove invoices to the new API.' })
  expect(pasted.json.value.path).toBe('.orchestration/specs/2026-09-24-billing-rework.md')
  expect((await call('GET', 'spec-files')).json.value).toEqual(expect.arrayContaining(['.orchestration/specs/2026-09-24-product-brief.md', '.orchestration/specs/2026-09-24-billing-rework.md']))
  expect(await call('POST', 'spec-upload', { name: 'brief.pdf', text: '%PDF-1.7' })).toMatchObject({ status: 415, json: { error: 'unsupported_type' } })
  expect(await call('POST', 'spec-upload', { name: '../../escape.md', text: '# x' })).toMatchObject({ status: 400, json: { error: 'bad_name' } })
  expect(await call('POST', 'spec-upload', { name: 'big.md', text: 'x'.repeat(256 * 1024 + 1) })).toMatchObject({ status: 413, json: { error: 'too_large' } })
  expect(runs.size).toBe(2)
})
