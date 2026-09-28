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

// mk1: the screen's Mark as merged… — the person's native yes and a reason; agents have no tool for it.
const now = new Date('2026-09-25T10:00:00Z')
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

async function setup(lang: HostLang, answer: boolean) {
  const root = await makeRepo()
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, 'README.txt'), 'task\n')
  // A hub on a detached HEAD: nothing needs to be checked out.
  await git(root, 'checkout', '-q', '--detach')
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
  const route = actionRoutes({ ...deps, native: { confirm: async (_title, message) => { asked.push(message); return answer }, notify: async () => {} } }).find((r) => r.path === '/crewboard/api/mark-merged')!
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

it('asks natively with the reason and records it only on yes, on a detached HEAD', async () => {
  const declined = await setup('en', false)
  expect(await declined.call({ reason: 'landed by hand' })).toMatchObject({ status: 409, body: { ok: false, error: 'declined' } })
  expect(declined.asked[0]).toBe(`Record task a (orch/a-a) as merged into main in ${declined.root}, because: “landed by hand”? Git is not touched; tasks that depend on it may start.`)
  expect((await loadPlan(declined.root)).tasks[0]?.merged).toBeUndefined()

  const accepted = await setup('ru', true)
  expect(await accepted.call({ reason: 'перенесено руками' })).toMatchObject({ status: 200, body: { ok: true, value: { task: 'a', into: 'main' } } })
  expect(accepted.asked[0]).toContain('потому что: «перенесено руками»')
  expect((await loadPlan(accepted.root)).tasks[0]?.merged).toMatchObject({ into: 'main', how: 'person', by: 'person', reason: 'перенесено руками' })
  expect(await accepted.call({ reason: 'again' })).toMatchObject({ status: 409, body: { ok: false, error: 'already_merged' } })
})

it('needs a reason', async () => {
  const { call, asked } = await setup('en', true)
  expect(await call({})).toMatchObject({ status: 400 })
  expect(asked).toEqual([])
})

it('gives agents no mark-merged tool', async () => {
  const { tools } = await setup('en', true)
  expect(tools.map((tool) => tool.name).filter((name) => /merge/i.test(name))).toEqual([])
})
