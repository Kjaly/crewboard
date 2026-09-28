import { readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, type LaunchInput, type RunBackend, initPlan, loadPlan, loadRepoPreferences, loadSidebarOrder, newTask, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-25T12:00:00Z')
const A = '/crewboard/api'
const HEADERS = { 'content-type': 'application/json', [CLIENT_HEADER]: '1' }

async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nParse the list.\n')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 't1', title: 'Parser', contract: 'contract.md' }), status: 'in_review', runs: [{ runId: 'run_dsh-a', agent: 'dsh/deepseek-flash', startedAt: '2026-09-25T11:00:00Z', finishedAt: '2026-09-25T11:10:00Z', outcome: 'completed' }] })
    p.tasks.push({ ...newTask({ id: 'd1', title: 'Pick', kind: 'decision' }), status: 'in_review' })
    return p
  })
  // A green preflight on record: the launch does not probe a real dsh.
  const green = { at: NOW.toISOString(), result: { ok: true, checks: [] } }
  await writeFile(join(root, '.orchestration/preflight-cache.json'), JSON.stringify({ dsh: green, 'dsh/deepseek-flash': green }))
  const launches: LaunchInput[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async (input) => {
      launches.push(input)
      return `run_dsh-${launches.length + 1}`
    },
    events: async () => [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const questions: string[] = []
  const native: Native = { confirm: async (_title, message) => { questions.push(message); return true }, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW, prefsFor: () => loadRepoPreferences({}, root), orderFor: () => loadSidebarOrder({}, root) })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const post = async (name: string, body: unknown) => {
    const route = routes.find((r) => r.path === `${A}/${name}`)
    if (!route) throw new Error(`no route ${name}`)
    const res = { body: '', status: 0, writeHead(status: number) { res.status = status; return res }, end(chunk?: string | Buffer) { if (chunk) res.body += chunk.toString() } }
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: `${A}/${name}`, headers: HEADERS })
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body || 'null') as { ok?: boolean; value?: { run?: { runId: string; agent: string } }; error?: string } }
  }
  return { root, post, launches, questions }
}

describe('POST reject with rerun (wk1, B29)', () => {
  it('V-wk1/route-rerun sends back, asks once natively and starts the same worker with the reason in the prompt', async () => {
    const { root, post, launches, questions } = await setup()
    const r = await post('reject', { repo: root, task: 't1', reason: 'the empty list crashes', rerun: true })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.value?.run).toMatchObject({ agent: 'dsh/deepseek-flash' })
    expect(questions).toEqual([expect.stringContaining('start it again now (the same worker)')])
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 't1')
    expect(task?.runs).toHaveLength(2)
    expect(task?.notes.at(-1)).toMatchObject({ type: 'reject', event: { kind: 'rejected', reason: 'the empty list crashes' } })
    const prompt = await readFile(launches[0]?.promptFile ?? '', 'utf8')
    expect(prompt.indexOf('the empty list crashes')).toBeGreaterThan(prompt.indexOf('Parse the list.'))
  })

  it('a person may pick another worker for the rerun', async () => {
    const { root, post } = await setup()
    const r = await post('reject', { repo: root, task: 't1', reason: 'try another worker', rerun: true, agent: 'dsh' })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.value?.run).toMatchObject({ agent: 'dsh' })
    expect((await loadPlan(root)).tasks.find((t) => t.id === 't1')).toMatchObject({ worker: 'dsh', workerSource: 'person' })
  })

  it('a decision has no run to repeat: refused before anything is sent back', async () => {
    const { root, post, launches } = await setup()
    const r = await post('reject', { repo: root, task: 'd1', reason: 'no', rerun: true })
    expect(r.status).toBe(409)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'd1')?.status).toBe('in_review')
    expect(launches).toHaveLength(0)
  })
})
