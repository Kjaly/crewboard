import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, type RunBackend, initPlan, newTask, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import type { HostLang } from '../src/host/i18n.js'
import { OrchestraService } from '../src/host/service.js'

// ck1 (B30): the panel's «Run checks here» — the host runs the contract's checks and answers with the task's detail.
const now = new Date('2026-09-25T10:00:00Z')
const RUN = 'run_dsh-r1'

async function setup(lang: HostLang, checks: string) {
  const root = await makeRepo()
  const copy = join(root, '..', 'repo-orch-a')
  await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'orch/a', copy, 'HEAD'])
  await writeFile(join(copy, 'a.ts'), 'export const a = 1\n')
  await mkdir(join(root, 'contracts'), { recursive: true })
  await writeFile(join(root, 'contracts', 'a.md'), `# A\n${checks}`)
  const evidence = `.orchestration/runs/${RUN}/evidence.json`
  await mkdir(join(root, '.orchestration', 'runs', RUN), { recursive: true })
  await writeFile(join(root, evidence), JSON.stringify({ version: 1, runId: RUN, worker: 'dsh', finalAnswer: 'Result: received', finalAnswerState: 'reported', claimLine: 'Result: received', files: [{ path: 'a.ts', added: 1, deleted: 0 }], filesState: 'reported', checks: [], checksState: 'reported', capturedAt: '2026-09-25T09:30:00Z' }))
  await initPlan(root, 'goal', now)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'a', title: 'A', contract: 'contracts/a.md' }), status: 'in_review', worktree: { path: copy, branch: 'orch/a' }, runs: [{ runId: RUN, agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:30:00Z', outcome: 'completed', evidence }] })
    return p
  })
  const backend: RunBackend = { id: 'dsh', launch: async () => 'run_x', events: async () => [], status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }), steer: async () => {}, cancel: async () => {} }
  const backends: Backends = { forAgent: async () => backend }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => now })
  const route = actionRoutes({ service, repos: [root], backendsFor: () => backends, env: { ...process.env }, home: root, now: () => now, lang: () => lang, native: { confirm: async () => false, notify: async () => {} } }).find((r) => r.path === '/crewboard/api/run-checks')!
  const call = async () => {
    const req = Readable.from([Buffer.from(JSON.stringify({ repo: root, task: 'a' }))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    let status = 0
    let sent = ''
    const res = { writeHead: (code: number) => { status = code; return res }, end: (text: string) => { sent = text } } as unknown as ServerResponse
    await route.handler(req, res)
    return { status, body: JSON.parse(sent) }
  }
  return { call }
}

it('runs the checks as a person and answers with the detail that carries them', async () => {
  const { call } = await setup('en', '<checks>\n- true\n- exit 4\n</checks>\n')
  const { status, body } = await call()
  expect(status).toBe(200)
  expect(body.value.evidence.crewboardChecks).toMatchObject({ by: 'person', checks: [{ command: 'true', exitCode: 0 }, { command: 'exit 4', exitCode: 4 }] })
  expect(body.value.verdict.facts).toContainEqual({ code: 'crewboard_checks', count: 1, total: 2, commands: ['exit 4'], tone: 'warn' })
})

it('a contract without checks is refused in the host language', async () => {
  const { call } = await setup('ru', '')
  expect(await call()).toMatchObject({ status: 409, body: { ok: false, error: 'checks_no_checks', message: expect.stringContaining('нет блока <checks>') } })
})
