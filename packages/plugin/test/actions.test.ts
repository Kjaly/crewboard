import { mkdtemp, readFile, writeFile, truncate } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, type RunBackend, initPlan, loadPlan, loadRepoPreferences, loadSidebarOrder, newTask, updatePlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const A = '/crewboard/api'
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
    end(chunk?: string | Buffer) {
      if (chunk) res.body += chunk.toString()
    },
  } as FakeRes & { writeHead: unknown; end: unknown }
  return res
}

function fakeReq(method: string, url: string, body: unknown, headers: Record<string, string>) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers })
  return req
}

async function setup(confirmAnswer = true) {
  const root = await mkdtemp(join(tmpdir(), 'orch-act-'))
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'b', title: 'B' }), runs: [{ runId: 'run_dsh-b', agent: 'dsh', startedAt: '2026-09-22T11:59:00Z' }] })
    p.tasks.push(newTask({ id: 'c', title: 'C' }))
    return p
  })
  const calls: string[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-new',
    events: async () => [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async (id) => {
      calls.push(`steer ${id}`)
    },
    cancel: async (id) => {
      calls.push(`cancel ${id}`)
    },
  }
  const backends: Backends = { forAgent: async () => backend }
  const prompts: string[] = []
  const native: Native = {
    confirm: async (_title, message) => {
      prompts.push(message)
      return confirmAnswer
    },
    notify: async () => {},
  }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW, prefsFor: () => loadRepoPreferences({}, root), orderFor: () => loadSidebarOrder({}, root) })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) => {
    const pathname = url.split('?')[0]
    const route = routes.find((r) => r.path === pathname)
    if (!route) throw new Error(`no route ${pathname}`)
    const res = fakeRes()
    await route.handler(fakeReq(method, url, body, headers), res as unknown as ServerResponse)
    const isJson = res.headers?.['content-type']?.startsWith('application/json')
    return { status: res.status, headers: res.headers, json: isJson ? (JSON.parse(res.body) as unknown) : undefined, text: res.body }
  }
  return { root, calls, prompts, call, service }
}

describe('action routes', () => {
  it('creates a dependent follow-up with a linked contract and never launches it', async () => {
    const { root, call } = await setup()
    const response = await call('POST', `${A}/task-upsert`, { repo: root, id: 'fix-review', parent: 'c', title: 'Fix review', class: 'review', lane: 'Review', depends: true, note: 'Fix the check', replace: false })
    expect(response.status).toBe(200)
    const plan = await loadPlan(root)
    const task = plan.tasks.find((item) => item.id === 'fix-review')
    expect(task).toMatchObject({ deps: ['c'], class: 'review', lane: 'Review', status: 'ready', runs: [], contract: '.orchestration/contracts/main/fix-review.md' })
    const contract = await readFile(join(root, task!.contract!), 'utf8')
    expect(contract).toContain('c: C')
    expect(contract).toContain('Verdict:')
    expect(contract).toContain('Fix the check')
  })
  it('keeps a replacement runnable by omitting its superseded parent as a dependency', async () => {
    const { root, call } = await setup()
    const response = await call('POST', `${A}/task-upsert`, { repo: root, id: 'replacement', parent: 'c', title: 'Replacement', depends: true, note: 'Try another approach', replace: true })
    expect(response.status).toBe(200)
    const plan = await loadPlan(root)
    expect(plan.tasks.find((task) => task.id === 'c')?.status).toBe('superseded')
    expect(plan.tasks.find((task) => task.id === 'replacement')?.deps).toEqual([])
  })
  it('serves changed file bytes with before/after and refuses unknown paths', async () => {
    const { root, call } = await setup()
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
    await writeFile(join(root, 'old.svg'), '<svg>before</svg>')
    await writeFile(join(root, 'report.html'), 'before')
    git('add', '.'); git('commit', '-m', 'base')
    const wt = join(root, 'task-b')
    git('worktree', 'add', '-b', 'task/b', wt)
    await writeFile(join(wt, 'old.svg'), '<svg>after</svg>')
    await writeFile(join(wt, 'report.html'), '<h1>after</h1>')
    await writeFile(join(wt, 'new.png'), 'png data')
    await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'b')!.worktree = { path: wt, branch: 'task/b' }; return p })
    const url = (file: string, side: string) => `${A}/file?repo=${encodeURIComponent(root)}&id=b&file=${encodeURIComponent(file)}&side=${side}`
    expect((await call('GET', url('old.svg', 'before'))).text).toBe('<svg>before</svg>')
    expect(await call('GET', url('old.svg', 'after'))).toMatchObject({ status: 200, text: '<svg>after</svg>', headers: { 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff' } })
    expect((await call('GET', url('report.html', 'after'))).headers?.['content-security-policy']).toBe('sandbox')
    expect(await call('GET', url('new.png', 'before'))).toMatchObject({ status: 404, json: { error: 'no_before' } })
    expect(await call('GET', url('missing.txt', 'after'))).toMatchObject({ status: 404, json: { error: 'unknown_file' } })
    expect(await call('GET', url('../old.svg', 'after'))).toMatchObject({ status: 404, json: { error: 'unknown_file' } })
    await writeFile(join(wt, 'huge.png'), '')
    await truncate(join(wt, 'huge.png'), 25 * 1024 * 1024 + 1)
    expect(await call('GET', url('huge.png', 'after'))).toMatchObject({ status: 413, json: { error: 'too_large' } })
    execFileSync('git', ['-C', wt, 'add', 'old.svg', 'report.html', 'new.png'])
    execFileSync('git', ['-C', wt, 'commit', '-m', 'task changes'])
    git('merge', '--no-ff', '-m', 'Merge task/b', 'task/b')
    // Accepted and merged while the worktree still exists: the range comes from the merge.
    expect((await call('GET', url('old.svg', 'before'))).text).toBe('<svg>before</svg>')
    expect((await call('GET', url('old.svg', 'after'))).text).toBe('<svg>after</svg>')
    git('worktree', 'remove', '--force', wt)
    expect((await call('GET', url('old.svg', 'before'))).text).toBe('<svg>before</svg>')
    expect((await call('GET', url('old.svg', 'after'))).text).toBe('<svg>after</svg>')
    expect(await call('GET', url('new.png', 'before'))).toMatchObject({ status: 404, json: { error: 'no_before' } })
  })
  it('guards POST routes by method, content type, client header and repo', async () => {
    const { root, call } = await setup()
    expect((await call('GET', `${A}/stop`)).status).toBe(405)
    expect((await call('POST', `${A}/stop`, { repo: root, task: 'b' }, { 'content-type': 'text/plain', [CLIENT_HEADER]: '1' })).status).toBe(415)
    expect((await call('POST', `${A}/stop`, { repo: root, task: 'b' }, { 'content-type': 'application/json' })).status).toBe(403)
    expect(await call('POST', `${A}/stop`, { repo: '/elsewhere', task: 'b' })).toMatchObject({ status: 400, json: { ok: false, error: 'unknown_repo' } })
  })

  it('accepts only after the human confirms in a native dialog', async () => {
    const declined = await setup(false)
    expect(await declined.call('POST', `${A}/accept`, { repo: declined.root, task: 'c' })).toMatchObject({ status: 409, json: { error: 'declined' } })
    expect((await loadPlan(declined.root)).tasks.find((t) => t.id === 'c')?.status).toBe('ready')
    const ok = await setup(true)
    expect(await ok.call('POST', `${A}/accept`, { repo: ok.root, task: 'c' })).toMatchObject({ status: 200, json: { ok: true } })
    expect((await loadPlan(ok.root)).tasks.find((t) => t.id === 'c')?.status).toBe('accepted')
    expect(ok.prompts[0]).toContain('c')
  })

  // vr1: accepting ahead of the orchestrator's check stays possible, but the dialog says so and Review records it.
  it('asks about an unfinished orchestrator check and records the acceptance as unchecked', async () => {
    const { root, call, prompts } = await setup(true)
    await updatePlan(root, (p) => {
      const c = p.tasks.find((t) => t.id === 'c')!
      c.status = 'in_review'
      c.runs.push({ runId: 'run_dsh-c', agent: 'dsh', startedAt: '2026-09-22T11:00:00Z', finishedAt: '2026-09-22T11:10:00Z', outcome: 'completed' })
      c.check = { state: 'checking', runId: 'run_dsh-c', at: '2026-09-22T11:11:00Z' }
      return p
    })
    expect((await call('POST', `${A}/accept`, { repo: root, task: 'c' })).status).toBe(200)
    expect(prompts[0]).toMatch(/^The orchestrator has not finished checking c — accept without it\?/)
    const review = await call('GET', `${A}/task-review?repo=${encodeURIComponent(root)}&task=c`)
    expect((review.json as { value: { decisions: Array<{ check?: string }> } }).value.decisions.at(-1)?.check).toBe('unchecked')
  })

  it('stores the orchestrator check setting per repository and per plan', async () => {
    const { root, call } = await setup(true)
    expect(await call('POST', `${A}/orchestrator-check`, { repo: root, scope: 'repo', value: true })).toMatchObject({ status: 200, json: { value: { enabled: true, source: 'repository', repository: true } } })
    expect(await call('POST', `${A}/orchestrator-check`, { repo: root, scope: 'plan', value: false })).toMatchObject({ status: 200, json: { value: { enabled: false, source: 'plan', plan: false } } })
    expect(await call('POST', `${A}/orchestrator-check`, { repo: root, scope: 'plan', value: null })).toMatchObject({ json: { value: { enabled: true, source: 'repository' } } })
    expect((await call('POST', `${A}/orchestrator-check`, { repo: root, scope: 'plan', value: 'yes' })).status).toBe(400)
  })

  it('rejects with a required reason after confirmation', async () => {
    const { root, call } = await setup(true)
    expect(await call('POST', `${A}/reject`, { repo: root, task: 'c' })).toMatchObject({ status: 400, json: { error: 'bad_request' } })
    expect((await call('POST', `${A}/reject`, { repo: root, task: 'c', reason: 'нет тестов' })).status).toBe(200)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'c')).toMatchObject({ status: 'rejected', notes: [{ type: 'reject', text: 'нет тестов' }] })
  })

  it('returns a clear refusal for a finished run without sending a steer', async () => {
    const { root, call, calls } = await setup()
    await updatePlan(root, (p) => { const run = p.tasks.find((t) => t.id === 'b')!.runs[0]!; run.finishedAt = NOW.toISOString(); run.outcome = 'completed'; return p })
    const response = await call('POST', `${A}/steer`, { repo: root, task: 'b', message: 'preserve this correction' })
    expect(response).toMatchObject({ status: 200, json: { ok: true, value: { delivery: 'refused', state: 'refused', runState: 'completed', message: 'preserve this correction' } } })
    expect(calls).toEqual([])
  })

  it('steers and stops the running worker, and refuses to launch a running task', async () => {
    const { root, calls, call } = await setup()
    expect((await call('POST', `${A}/steer`, { repo: root, task: 'b', message: 'use vitest' })).status).toBe(200)
    expect((await call('POST', `${A}/stop`, { repo: root, task: 'b' })).status).toBe(200)
    expect(calls).toEqual(['steer run_dsh-b', 'cancel run_dsh-b'])
    expect(await call('POST', `${A}/run`, { repo: root, task: 'b', agent: 'dsh' })).toMatchObject({ status: 409, json: { error: 'running' } })
  })

  it('pins positions and serves task detail and diffs', async () => {
    const { root, call } = await setup()
    const rev = (await loadPlan(root)).rev
    expect((await call('POST', `${A}/pos`, { repo: root, planId: 'main', expectedRev: rev, positions: [{ task: 'c', pos: { x: 5, y: 6 } }] })).status).toBe(200)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'c')?.pos).toEqual({ x: 5, y: 6 })
    expect((await call('POST', `${A}/pos`, { repo: root, planId: 'main', expectedRev: rev + 1, positions: [{ task: 'c', pos: { x: 'a', y: 6 } }] })).status).toBe(400)
    const q = `repo=${encodeURIComponent(root)}`
    expect(await call('GET', `${A}/task?${q}&id=b`)).toMatchObject({ status: 200, json: { ok: true, value: { id: 'b', status: 'running' } } })
    expect(await call('GET', `${A}/task?${q}&id=zzz`)).toMatchObject({ status: 404, json: { error: 'unknown_task' } })
    expect(await call('GET', `${A}/diff?${q}&id=b&file=x.txt`)).toMatchObject({ status: 404, json: { error: 'no_worktree' } })
  })

  it('round-trips pinned and hidden flags through the profile store into the snapshot', async () => {
    const { root, call, service } = await setup()
    expect(await loadRepoPreferences({}, root)).toEqual({})
    expect(await call('POST', `${A}/repo-flag`, { repo: root, flag: 'pinned', value: true })).toMatchObject({ status: 200, json: { ok: true, value: { pinned: true } } })
    expect(await call('POST', `${A}/repo-flag`, { repo: root, flag: 'hidden', value: true })).toMatchObject({ status: 200, json: { ok: true, value: { pinned: true, hidden: true } } })
    expect(await loadRepoPreferences({}, root)).toEqual({ [root]: { pinned: true, hidden: true } })
    await service.refresh(root)
    const repo = service.snapshot().repos.find((r) => r.root === root)
    expect(repo).toMatchObject({ pinned: true, hidden: true })

    expect(await call('POST', `${A}/repo-flag`, { repo: root, flag: 'hidden', value: false })).toMatchObject({ status: 200, json: { ok: true, value: { pinned: true } } })
    expect(await loadRepoPreferences({}, root)).toEqual({ [root]: { pinned: true } })
    expect(service.snapshot().repos.find((r) => r.root === root)?.hidden).toBeUndefined()

    expect(await call('POST', `${A}/repo-flag`, { repo: root, flag: 'pinned', value: false })).toMatchObject({ status: 200, json: { ok: true, value: {} } })
    expect(await loadRepoPreferences({}, root)).toEqual({})
    expect((await call('POST', `${A}/repo-flag`, { repo: root, flag: 'wat', value: true })).status).toBe(400)
    expect((await call('POST', `${A}/repo-flag`, { repo: root, flag: 'pinned', value: 'yes' })).status).toBe(400)
  })

  it('round-trips the manual sidebar order through the profile store and resets on null', async () => {
    const { root, call, service } = await setup()
    const saved = await call('POST', `${A}/side-order`, { repo: root, order: { repos: ['/b', '/a'], plans: { '/a': [`/a/p2`, '/a/p1'] } } })
    expect(saved).toMatchObject({ status: 200, json: { ok: true, value: { repos: ['/b', '/a'], plans: { '/a': ['/a/p2', '/a/p1'] } } } })
    // The same profiles file loadSidebarOrder reads — this is what the next tab or reload sees.
    expect(await loadSidebarOrder({}, root)).toEqual({ repos: ['/b', '/a'], plans: { '/a': ['/a/p2', '/a/p1'] } })

    // A partial patch merges: the new plans entry lands next to the saved repository order.
    await call('POST', `${A}/side-order`, { repo: root, order: { plans: { '/b': ['/b/x'] } } })
    expect(await loadSidebarOrder({}, root)).toEqual({ repos: ['/b', '/a'], plans: { '/a': ['/a/p2', '/a/p1'], '/b': ['/b/x'] } })

    await service.refresh(root)
    expect(service.snapshot().order).toMatchObject({ repos: ['/b', '/a'] })

    expect(await call('POST', `${A}/side-order`, { repo: root, order: null })).toMatchObject({ status: 200, json: { ok: true, value: {} } })
    expect(await loadSidebarOrder({}, root)).toEqual({})

    expect((await call('POST', `${A}/side-order`, { repo: root })).status).toBe(400)
    expect((await call('POST', `${A}/side-order`, { repo: root, order: 'flat' })).status).toBe(400)
    expect((await call('POST', `${A}/side-order`, { repo: root, order: { repos: 'nope' } })).status).toBe(400)
  })
})

describe('route order', () => {
  it('registers a longer path before a shorter prefix of it', () => {
    const routes = actionRoutes({ service: { refresh: async () => {}, snapshot: () => ({ generatedAt: '', repos: [], workers: [] }) } as never, repos: [], backendsFor: () => ({}) as never, native: { confirm: async () => true, notify: async () => {} }, env: {}, home: '/tmp', now: () => new Date() })
    const paths = routes.map((route) => route.path)
    for (const [i, path] of paths.entries()) {
      for (const later of paths.slice(i + 1)) expect(later.startsWith(`${path}-`) || later.startsWith(`${path}/`)).toBe(false)
    }
  })
})
