import { mkdtemp, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, type Exec, type RunBackend, initPlan, nodeExec, loadPlan, newTask, savePreset, setRepositoryPreset, updatePlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import { ORCHESTRA_PROMPT } from '../src/host/prompt.js'
import { OrchestraService } from '../src/host/service.js'
import { orchestraTools } from '../src/host/tools.js'

// wp1 (2026-09-24): chat tools are agents and stay inside the preset; screen actions are the person.

const NOW = new Date('2026-09-24T12:00:00Z')

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'orch-authority-'))
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  await writeFile(join(root, 'c.md'), 'do it\n')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'a', title: 'A', contract: 'c.md' }))
    return p
  })
  const env = { HOME: root }
  await savePreset({ id: 'claude', label: 'Claude', routing: { code: ['claude/opus'], design: ['claude/opus'], review: ['claude/opus'], research: ['claude/opus'] } }, env)
  await setRepositoryPreset(root, 'claude', env)
  const launched: string[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async ({ agent }) => { launched.push(agent); return 'run_dsh-new' },
    events: async () => [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW, env })
  const deps = { service, repos: [root], backendsFor: () => backends, env, home: root, now: () => NOW }
  const tools = orchestraTools(deps)
  const tool = (name: string) => tools.find((t) => t.name === name)!
  // The worker CLI is faked: preflight sees a working `dsh`, git still runs for the worktree.
  const exec: Exec = async (cmd, args, opts) => (cmd === 'dsh' ? { code: 0, stdout: 'dsh 1.0.0', stderr: '', timedOut: false } : nodeExec(cmd, args, opts))
  const routes = actionRoutes({ ...deps, exec, native: { confirm: async () => true, notify: async () => {} } })
  const post = async (name: string, body: unknown) => {
    const route = routes.find((r) => r.path === `/crewboard/api/${name}`)!
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: `/crewboard/api/${name}`, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { body: '', status: 0, writeHead(status: number) { res.status = status; return res }, end(chunk?: string) { if (chunk) res.body += chunk } }
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; value?: unknown; error?: string; message?: string } }
  }
  const task = async (id: string) => (await loadPlan(root)).tasks.find((t) => t.id === id)
  return { root, service, tool, post, task, launched }
}

describe('chat tools under the preset', () => {
  it('orchestra_task_upsert refuses a worker outside the preset with the allowed list', async () => {
    const { tool, task } = await setup()
    await expect(tool('orchestra_task_upsert').execute({ id: 'b', title: 'B', worker: 'devin' })).rejects.toThrow(/not in the preset “Claude”.*may choose only: claude\/opus.*Ask the person/)
    expect(await task('b')).toBeUndefined()
    await expect(tool('orchestra_task_upsert').execute({ id: 'a', worker: 'codex/gpt-6-sol' })).rejects.toThrow(/may choose only: claude\/opus/)
    expect((await task('a'))?.worker).toBeUndefined()
  })

  it('accepts a worker inside the preset as the agent\'s choice, and auto clears it', async () => {
    const { tool, task } = await setup()
    await tool('orchestra_task_upsert').execute({ id: 'a', worker: 'claude/opus' })
    expect(await task('a')).toMatchObject({ worker: 'claude/opus', workerSource: 'agent' })
    await tool('orchestra_task_upsert').execute({ id: 'a', worker: 'auto' })
    expect((await task('a'))?.workerSource).toBeUndefined()
  })

  it('orchestra_run refuses an agent outside the preset and launches nothing', async () => {
    const { tool, launched } = await setup()
    await expect(tool('orchestra_run').execute({ task: 'a', agent: 'devin' })).rejects.toMatchObject({ code: 'outside_preset' })
    expect(launched).toEqual([])
  })

  it('tells the model not to pass a worker and to ask the person', async () => {
    const { tool } = await setup()
    expect(tool('orchestra_run').description).toMatch(/Do not pass `agent`/)
    expect(JSON.stringify(tool('orchestra_task_upsert').parameters)).toMatch(/ask the person/)
    expect(ORCHESTRA_PROMPT).toMatch(/Do not pass a worker to orchestra_task_upsert or orchestra_run.*ask the person/)
  })
})

describe('screen actions are the person', () => {
  it('runs a worker picked on the screen outside the preset and the snapshot marks it', async () => {
    const { root, service, post, task, launched } = await setup()
    const r = await post('run', { repo: root, task: 'a', agent: 'dsh' })
    expect(r.json).toMatchObject({ ok: true, value: { agent: 'dsh' } })
    expect(launched).toEqual(['dsh'])
    expect(await task('a')).toMatchObject({ worker: 'dsh', workerSource: 'person' })
    await service.refresh(root)
    expect(service.snapshot().repos[0]?.tasks.find((t) => t.id === 'a')).toMatchObject({ worker: 'dsh', workerSource: 'person', outsidePreset: true })
  })
})
