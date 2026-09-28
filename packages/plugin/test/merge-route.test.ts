import { writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, type RunBackend, initPlan, loadPlan, newTask, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { HostLang } from '../src/host/i18n.js'
import { OrchestraService } from '../src/host/service.js'
import { orchestraTools } from '../src/host/tools.js'

// mg1 (B18): the screen's Merge — the host checks first, asks the person natively, then merges; agents have no tool for it.
const now = new Date('2026-09-24T10:00:00Z')
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

async function setup(lang: HostLang, answer: boolean) {
  const root = await makeRepo()
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, 'README.txt'), 'task\n')
  await git(copy, 'commit', '-q', '-am', 'a')
  await initPlan(root, 'goal', now)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'a', title: 'A' }), status: 'accepted', worktree: { path: copy, branch: 'orch/a-a', base: 'main' } })
    return p
  })
  const backend: RunBackend = { id: 'dsh', launch: async () => 'run_x', events: async () => [], status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }), steer: async () => {}, cancel: async () => {} }
  const backends: Backends = { forAgent: async () => backend }
  const asked: string[] = []
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => now })
  const deps = { service, repos: [root], backendsFor: () => backends, env: { CREWBOARD_WORKTREE_CONFIG: join(root, '..', 'worktrees.json') }, home: root, now: () => now, lang: () => lang }
  const route = actionRoutes({ ...deps, native: { confirm: async (_title, message) => { asked.push(message); return answer }, notify: async () => {} } }).find((r) => r.path === '/crewboard/api/merge')!
  const call = async (body: Record<string, unknown>) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ repo: root, task: 'a', ...body }))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    let status = 0
    let sent = ''
    const res = { writeHead: (code: number) => { status = code; return res }, end: (text: string) => { sent = text } } as unknown as ServerResponse
    await route.handler(req, res)
    return { status, body: JSON.parse(sent) }
  }
  return { root, asked, call, tools: orchestraTools(deps) }
}

it('asks natively and merges only on yes', async () => {
  const declined = await setup('en', false)
  const before = (await git(declined.root, 'rev-parse', 'HEAD')).stdout
  expect(await declined.call({})).toMatchObject({ status: 409, body: { ok: false, error: 'declined' } })
  expect(declined.asked[0]).toBe(`Merge task a (orch/a-a) into main in ${declined.root} with a merge commit?`)
  expect((await git(declined.root, 'rev-parse', 'HEAD')).stdout).toBe(before)

  const accepted = await setup('en', true)
  const merged = await accepted.call({ strategy: 'squash' })
  expect(merged).toMatchObject({ status: 200, body: { ok: true, value: { task: 'a', into: 'main', strategy: 'squash', copy: 'kept_recent' } } })
  expect((await loadPlan(accepted.root)).tasks[0]?.merged).toMatchObject({ into: 'main', strategy: 'squash' })
  expect(await accepted.call({ strategy: 'rebase' })).toMatchObject({ status: 400 })
})

it('refuses a conflicting merge before asking, with the CLI text in the host language and the paths', async () => {
  const { root, asked, call } = await setup('ru', true)
  await writeFile(join(root, 'README.txt'), 'main\n')
  await git(root, 'commit', '-q', '-am', 'main moves')
  const result = await call({})
  expect(result).toMatchObject({ status: 409, body: { ok: false, error: 'conflicts', paths: ['README.txt'] } })
  expect(result.body.message).toContain('Слияние задачи a в main даст конфликт в 1 файлах: README.txt')
  expect(asked).toEqual([])
})

it('gives agents no merge tool', async () => {
  const { tools } = await setup('en', true)
  expect(tools.map((tool) => tool.name).filter((name) => /merge/i.test(name))).toEqual([])
})
