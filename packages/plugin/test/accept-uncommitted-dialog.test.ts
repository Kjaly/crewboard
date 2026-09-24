import { mkdtemp, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, type RunBackend, initPlan, newTask, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { HostLang } from '../src/host/i18n.js'
import { OrchestraService } from '../src/host/service.js'

// w1d (B17, D03): work the copy holds without a commit is not on the task branch — the accept dialog says so first.
const now = new Date('2026-09-24T10:00:00Z')

async function ask(lang: HostLang, route: 'accept' | 'accept-batch') {
  const root = await makeRepo()
  const copy = join(await mkdtemp(join(tmpdir(), 'orch-copy-')), 'a')
  await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD'])
  await writeFile(join(copy, 'a.ts'), 'export const a = 2\n')
  await initPlan(root, 'goal', now)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'a', title: 'A' }), status: 'in_review', worktree: { path: copy, branch: 'orch/a-a' } })
    return p
  })
  const backend: RunBackend = { id: 'dsh', launch: async () => 'run_x', events: async () => [], status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }), steer: async () => {}, cancel: async () => {} }
  const backends: Backends = { forAgent: async () => backend }
  const messages: string[] = []
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => now })
  const found = actionRoutes({ service, repos: [root], backendsFor: () => backends, native: {
    confirm: async (_title, message) => { messages.push(message); return false }, notify: async () => {},
  }, env: {}, home: root, now: () => now, lang: () => lang }).find((r) => r.path === `/crewboard/api/${route}`)!
  const body = route === 'accept' ? { repo: root, task: 'a' } : { repo: root, tasks: ['a'] }
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', url: found.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
  const res = { writeHead: () => res, end: () => {} } as unknown as ServerResponse
  await found.handler(req, res)
  return messages
}

it('warns before accepting work left uncommitted, in both languages', async () => {
  expect((await ask('en', 'accept'))[0]).toContain('The copy of a holds 1 file(s) no commit carries: the task branch does not contain this result')
  expect((await ask('ru', 'accept'))[0]).toContain('В копии a есть файлы без коммита (1): ветка задачи не содержит этот результат')
  expect((await ask('en', 'accept-batch'))[0]).toContain('The branch does not contain the result — files without a commit:\n• a — 1 file(s) not committed')
})
