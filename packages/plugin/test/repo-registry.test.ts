import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, addRegisteredRepo, createPlan, initPlan, newTask, readRepoRegistry, setCurrentPlan, updatePlan, worktreeLocation } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import { OrchestraService } from '../src/host/service.js'
import { inboxItems } from '../src/client/sidebar-model.js'

const NOW = new Date('2026-09-24T12:00:00Z')
const idle: Backends = { forAgent: async () => { throw new Error('no backend in this test') } }

/** A git repository in a real temp path (macOS reports /private/var…), plus an isolated HOME for the list. */
async function gitRepo(name = 'repo'): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'orch-rg1-')))
  const root = join(parent, name)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return root
}
const worktree = (main: string, path: string, branch: string) => execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', branch, path])
/** A second spelling of `root` through a symlinked parent, like `/tmp` → `/private/tmp` on macOS. */
async function linkedSpelling(root: string): Promise<string> {
  const link = join(await realpath(await mkdtemp(join(tmpdir(), 'orch-rg1-link-'))), 'via')
  await symlink(dirname(root), link)
  return join(link, basename(root))
}
const isolatedEnv = async () => {
  const home = await mkdtemp(join(tmpdir(), 'orch-rg1-home-'))
  return { home, env: { HOME: home, CREWBOARD_REPOS_FILE: join(home, 'crewboard', 'repos.json') } as NodeJS.ProcessEnv }
}

function service(opts: { repos?: string[]; registered?: () => string[] }) {
  return new OrchestraService({ config: { repos: opts.repos ?? [], refreshMs: 60_000 }, registered: opts.registered, backendsFor: () => idle, now: () => NOW })
}

describe('the repository list the host serves', () => {
  it('serves a repository from Crewboard’s list and picks up a new entry without a restart', async () => {
    const { home, env } = await isolatedEnv()
    const a = await gitRepo()
    await initPlan(a, 'Listed', NOW)
    const svc = service({ registered: () => readRepoRegistry(env, home) })
    await svc.refresh()
    expect(svc.snapshot().repos).toEqual([])
    await addRegisteredRepo(a, env, home)
    await svc.refresh()
    expect(svc.snapshot().repos.map((r) => ({ root: r.root, goal: r.goal, sources: r.sources }))).toEqual([{ root: a, goal: 'Listed', sources: ['crewboard'] }])
  })

  it('shows a plan in a git worktree of a listed repository, marked, and never a task copy', async () => {
    const main = await gitRepo()
    await initPlan(main, 'Main plan', NOW)
    const hub = join(main, '.worktrees', 'harness-hub')
    worktree(main, hub, 'hub')
    await initPlan(hub, 'Hub plan', NOW)
    // A Crewboard task copy with a plan inside (a worker ran the CLI there): not a place of its own.
    const task = worktreeLocation(main, 't1', 'Task one').path
    worktree(main, task, 'orch/t1-task-one')
    await initPlan(task, 'Task copy', NOW)
    // A worktree without a plan stays out too.
    worktree(main, join(dirname(main), 'plain'), 'plain')

    const svc = service({ repos: [main] })
    await svc.refresh()
    const repos = svc.snapshot().repos
    expect(repos.map((r) => r.root)).toEqual([main, hub])
    expect(repos[1]).toMatchObject({ root: hub, goal: 'Hub plan', worktreeOf: main, sources: ['worktree'], family: { root: main } })
    expect(svc.repositories().some((r) => r.root === task)).toBe(false)
  })

  it('finds the main checkout and sibling worktrees from a listed worktree', async () => {
    const main = await gitRepo()
    await initPlan(main, 'Main plan', NOW)
    const ap = join(main, '.worktrees', 'ap-a')
    const hub = join(main, '.worktrees', 'harness-hub')
    worktree(main, ap, 'ap-a')
    worktree(main, hub, 'hub')
    await initPlan(ap, 'AP', NOW)
    await initPlan(hub, 'Hub plan', NOW)
    const svc = service({ repos: [ap] })
    await svc.refresh()
    expect(svc.snapshot().repos.map((r) => r.root).sort()).toEqual([main, ap, hub].sort())
  })

  it('serves one folder once whatever path form each list uses, and its worktrees group under it', async () => {
    const main = await gitRepo('acme-web')
    const linked = await linkedSpelling(main)
    await initPlan(main, 'Example', NOW)
    await updatePlan(main, (p) => {
      p.tasks.push({ ...newTask({ id: 'e1', title: 'E1' }), status: 'in_review' })
      return p
    })
    const hub = join(main, '.worktrees', 'hub')
    worktree(main, hub, 'hub')
    await initPlan(hub, 'Hub plan', NOW)
    // The setting names the symlinked spelling, Crewboard's list and git the real one.
    const svc = service({ repos: [linked, `${linked}/`], registered: () => [main] })
    await svc.refresh()
    const repos = svc.snapshot().repos
    expect(repos.map((r) => r.root)).toEqual([linked, hub])
    expect(repos[0]).toMatchObject({ sources: ['profile', 'crewboard'], family: { root: linked } })
    expect(repos[1]).toMatchObject({ worktreeOf: main, family: { root: linked } })
    expect(inboxItems(svc.snapshot()).filter((i) => i.root === linked || i.root === main)).toHaveLength(1)
  })

  it('shows a listed folder that no longer exists as missing, and the rest of the snapshot still builds', async () => {
    const a = await gitRepo()
    await initPlan(a, 'Alive', NOW)
    const gone = join(await mkdtemp(join(tmpdir(), 'orch-rg1-gone-')), 'deleted-repo')
    const svc = service({ registered: () => [gone, a] })
    const seen: number[] = []
    svc.subscribe((s) => seen.push(s.repos.length))
    await svc.refresh()
    expect(seen).toEqual([2])
    const [missing, alive] = svc.snapshot().repos
    expect(missing).toMatchObject({ root: gone, missing: true, hasPlan: false, degraded: false, tasks: [] })
    expect(alive).toMatchObject({ root: a, goal: 'Alive' })
  })

  it('«Needs you» counts an in-review task of a plan that is not the open one', async () => {
    const a = await gitRepo()
    await initPlan(a, 'Open plan', NOW)
    await createPlan(a, 'harness', 'Harness', NOW)
    await updatePlan(a, (p) => {
      p.tasks.push({ ...newTask({ id: 'h1', title: 'H1' }), status: 'in_review' })
      return p
    }, 5, 'harness')
    // `createPlan` made harness current; the person has main open.
    await setCurrentPlan(a, 'main')
    const svc = service({ registered: () => [a] })
    await svc.refresh()
    const snapshot = svc.snapshot()
    expect(snapshot.repos[0]?.planId).toBe('main')
    expect(inboxItems(snapshot)).toMatchObject([{ root: a, planId: 'harness', kind: 'plan', count: 1 }])
  })
})

/* ------------------------------------------------------------------ routes */

const A = '/crewboard/api'
const HEADERS = { 'content-type': 'application/json', [CLIENT_HEADER]: '1' }

async function routes(opts: { repos?: string[] } = {}) {
  const { home, env } = await isolatedEnv()
  const svc = new OrchestraService({ config: { repos: opts.repos ?? [], refreshMs: 60_000 }, registered: () => readRepoRegistry(env, home), backendsFor: () => idle, now: () => NOW })
  const list = actionRoutes({ service: svc, repos: opts.repos ?? [], backendsFor: () => idle, native: { confirm: async () => true, notify: async () => {} }, env, home, now: () => NOW })
  const call = async (name: string, body: unknown) => {
    const route = list.find((r) => r.path === `${A}/${name}`)
    if (!route) throw new Error(`no route ${name}`)
    const res = { status: 0, body: '', writeHead(status: number) { res.status = status; return res }, end(chunk?: string) { if (chunk) res.body += chunk } }
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: `${A}/${name}`, headers: HEADERS })
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; error?: string; value?: { root: string } } }
  }
  return { home, env, svc, call }
}

describe('repo-add and repo-remove', () => {
  it('adds a repository by an absolute path or ~, listing its root, and the next snapshot shows it', async () => {
    const { home, env, svc, call } = await routes()
    const repo = join(home, 'src', 'app')
    await mkdir(dirname(repo), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    const res = await call('repo-add', { path: '~/src/app/' })
    expect(res).toMatchObject({ status: 200, json: { ok: true, value: { root: await realpath(repo) } } })
    expect(readRepoRegistry(env, home)).toEqual([await realpath(repo)])
    expect(svc.snapshot().repos.map((r) => ({ root: r.root, hasPlan: r.hasPlan }))).toEqual([{ root: await realpath(repo), hasPlan: false }])
  })

  it.each([
    ['relative', () => 'src/app', 'repo_not_absolute'],
    ['missing', (home: string) => join(home, 'nope'), 'repo_not_found'],
    ['a file', (home: string) => join(home, 'file.txt'), 'repo_not_directory'],
    ['not git', (home: string) => join(home, 'plain'), 'repo_not_git'],
  ])('refuses a %s path with a stable code and writes nothing', async (_label, pathOf, code) => {
    const { home, env, call } = await routes()
    await writeFile(join(home, 'file.txt'), 'x')
    await mkdir(join(home, 'plain'))
    expect(await call('repo-add', { path: pathOf(home) })).toMatchObject({ status: 400, json: { ok: false, error: code } })
    expect(readRepoRegistry(env, home)).toEqual([])
  })

  it('refuses a repository that is already listed, from any source', async () => {
    const repo = await gitRepo()
    const { home, env, call } = await routes({ repos: [repo] })
    expect(await call('repo-add', { path: repo })).toMatchObject({ status: 409, json: { error: 'repo_already_listed' } })
    expect(readRepoRegistry(env, home)).toEqual([])
  })

  it('knows a listed folder under another spelling: «+» refuses it, «Remove from list» removes it', async () => {
    const repo = await gitRepo()
    const linked = await linkedSpelling(repo)
    const { home, env, svc, call } = await routes({ repos: [linked] })
    expect(await call('repo-add', { path: repo })).toMatchObject({ status: 409, json: { error: 'repo_already_listed' } })
    await addRegisteredRepo(repo, env, home)
    expect(await addRegisteredRepo(linked, env, home)).toBe(false)
    await svc.refresh()
    expect(svc.snapshot().repos.map((r) => ({ root: r.root, sources: r.sources }))).toEqual([{ root: linked, sources: ['profile', 'crewboard'] }])
    expect(await call('repo-remove', { root: linked })).toMatchObject({ status: 200, json: { ok: true } })
    expect(readRepoRegistry(env, home)).toEqual([])
  })

  it('removes a Crewboard-listed folder, even one that is gone, and never a profile repository', async () => {
    const kept = await gitRepo()
    const gone = join(await mkdtemp(join(tmpdir(), 'orch-rg1-gone-')), 'deleted')
    const { home, env, svc, call } = await routes({ repos: [kept] })
    await addRegisteredRepo(gone, env, home)
    await svc.refresh()
    expect(await call('repo-remove', { root: gone })).toMatchObject({ status: 200, json: { ok: true } })
    expect(readRepoRegistry(env, home)).toEqual([])
    expect(svc.snapshot().repos.map((r) => r.root)).toEqual([kept])
    expect(await call('repo-remove', { root: kept })).toMatchObject({ status: 409, json: { error: 'repo_not_removable' } })
  })
})
