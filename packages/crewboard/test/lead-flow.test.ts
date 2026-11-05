import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { AssignmentView, GoalEvent } from '../src/model/types.js'
import { createFakeBackend } from './fake-backend.js'

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-lead-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  return dir
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

async function start() {
  const fake = createFakeBackend()
  // Never read the developer's real transcripts from tests.
  const env = { ...process.env, CREWBOARD_HOME: await mkdtemp(join(tmpdir(), 'cb-home-')), CREWBOARD_CLAUDE_PROJECTS: await mkdtemp(join(tmpdir(), 'cb-claude-')), CREWBOARD_CODEX_SESSIONS: await mkdtemp(join(tmpdir(), 'cb-codex-')), CREWBOARD_DSH_SESSIONS: await mkdtemp(join(tmpdir(), 'cb-dsh-')) }
  const app = createApp({ env, backendFor: () => async () => fake.backend, tickMs: 60_000 })
  const server = await app.listen(0)
  const client = new Client({ name: 'test-lead', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)))
  closers.push(() => server.close(), () => client.close())
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> }
    const text = r.content[0]?.text ?? ''
    return { isError: r.isError === true, text, json: () => JSON.parse(text) as unknown }
  }
  return { app, server, fake, call, env, project: await gitRepo() }
}

describe('lead over MCP', () => {
  it('lists goals and starts work with a named branch and writable root', async () => {
    const { app, call, project, fake } = await start()
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Goal', criteria: [] })).json() as { goalId: string }
    const result = await call('crewboard_assign', { project, goalId, title: 'Work', criteria: [], resultKind: 'branch', provider: 'codex', branch: 'feature/example', writableRoots: [project] })
    expect(result.isError).toBe(false)
    await app.tick()
    expect(fake.runs).toHaveLength(1)
    expect(fake.launches[0]?.writableRoots).toEqual([await import('node:fs/promises').then(({ realpath }) => realpath(project))])
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: fake.runs[0]!.cwd, encoding: 'utf8' }).trim()).toBe('feature/example')
    const goals = (await call('crewboard_goals', { project })).json() as Array<{ goalId: string }>
    expect(goals.some((g) => g.goalId === goalId)).toBe(true)
    for (const patch of [{ branch: 'bad branch' }, { branch: 'feature/example' }, { writableRoots: ['/does-not-exist'] }]) {
      expect((await call('crewboard_assign', { project, goalId, title: 'Invalid', criteria: [], resultKind: 'branch', provider: 'codex', ...patch })).isError).toBe(true)
    }
  })

  it('remembers which client leads the goal, and a takeover', async () => {
    const { server, project } = await start()
    const connect = async (name: string) => {
      const c = new Client({ name, version: '1.0.0' })
      await c.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)))
      closers.push(() => c.close())
      return async (tool: string, args: Record<string, unknown>) => JSON.parse(((await c.callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>
    }
    const codex = await connect('codex-mcp-client')
    const { goalId } = (await codex('crewboard_start_goal', { project, title: 'Кухня', criteria: [] })) as { goalId: string }
    const leadOf = async () => ((await (await fetch(`${server.url}/api/projects`)).json()) as Array<{ goals: Array<{ goalId: string; lead?: string }> }>)[0]!.goals.find((g) => g.goalId === goalId)?.lead
    expect(await leadOf()).toBe('Codex')
    const claude = await connect('claude-code')
    await claude('crewboard_adopt_goal', { project, goalId })
    expect(await leadOf()).toBe('Claude Code')
    const events = (await (await fetch(`${server.url}/api/goals/${goalId}/events?project=${encodeURIComponent(project)}&assignmentId=${goalId}`)).json()) as GoalEvent[]
    expect(events.find((e) => e.type === 'adopted')).toMatchObject({ client: 'claude-code' })
    // The old lead's chat may still read the project's inbox; that does not take the goal back.
    await fetch(`${server.url}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, goalId, assignmentId: goalId, action: 'discuss' }) })
    expect(((await codex('crewboard_inbox', { project })) as unknown as GoalEvent[]).length).toBeGreaterThan(0)
    expect(await leadOf()).toBe('Claude Code')
  })

  it('lists the registered agents and refuses an unknown one', async () => {
    const { server, call, project } = await start()
    const { agents } = (await call('crewboard_agents', {})).json() as { agents: Array<{ id: string; readOnly: boolean }> }
    expect(agents.map((a) => a.id)).toEqual(['claude', 'codex', 'deepseek'])
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Кухня', criteria: [] })).json() as { goalId: string }
    const refused = await call('crewboard_assign', { project, goalId, title: 'Панель', criteria: [], resultKind: 'local', provider: 'nope' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('claude')
    const tree = (await (await fetch(`${server.url}/api/goals/${goalId}?project=${encodeURIComponent(project)}`)).json()) as AssignmentView
    expect(tree.children).toEqual([])
  })

  it('hands a dropped lead its unconfirmed events again', async () => {
    const { app, server, fake, call, project } = await start()
    fake.script({ final: '<crewboard-question>Шторка или слой?</crewboard-question>' })
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Кухня', criteria: [] })).json() as { goalId: string }
    await call('crewboard_assign', { project, goalId, title: 'Панель', criteria: [], resultKind: 'local', provider: 'codex' })
    await app.tick()
    await app.tick()
    expect(((await call('crewboard_inbox', { project })).json() as GoalEvent[]).map((e) => e.type)).toEqual(['question'])
    const next = new Client({ name: 'next-lead', version: '1.0.0' })
    await next.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)))
    closers.push(() => next.close())
    const r = (await next.callTool({ name: 'crewboard_inbox', arguments: { project } })) as { content: Array<{ text: string }> }
    expect((JSON.parse(r.content[0]!.text) as GoalEvent[]).map((e) => e.type)).toEqual(['question'])
  })

  it('runs a goal from assignment through a question and an answer to a closed result', async () => {
    const { app, server, fake, call, project } = await start()
    fake.script({ final: '<crewboard-question>Шторка или слой?</crewboard-question>' }, { final: '<crewboard-report>Готово</crewboard-report>' })

    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Кухня', criteria: ['Собирается сама'] })).json() as { goalId: string }
    const { assignmentId } = (await call('crewboard_assign', { project, goalId, title: 'Панель', criteria: ['Одной рукой'], resultKind: 'local', provider: 'codex' })).json() as { assignmentId: string }
    await app.tick()
    await app.tick()

    const waited = await fetch(`${server.url}/api/lead/wait?project=${encodeURIComponent(project)}&timeoutMs=200`)
    expect(waited.status).toBe(200)
    const inbox = (await call('crewboard_inbox', { project })).json() as GoalEvent[]
    expect(inbox.map((e) => e.type)).toEqual(['question'])
    expect((await call('crewboard_inbox', { project })).json()).toEqual([])
    // What the lead already took does not wake its next wait.
    expect((await fetch(`${server.url}/api/lead/wait?project=${encodeURIComponent(project)}&timeoutMs=200`)).status).toBe(204)

    await call('crewboard_answer', { project, goalId, assignmentId, text: 'Шторка' })
    expect(fake.runs[1]!.prompt).toContain('Шторка')
    await app.tick()
    expect(((await call('crewboard_inbox', { project })).json() as GoalEvent[]).map((e) => e.type)).toEqual(['reported'])

    await call('crewboard_close', { project, goalId, assignmentId, summary: 'Принято по критериям' })
    const tree = (await call('crewboard_status', { project, goalId })).json() as AssignmentView
    expect(tree.children.find((c) => c.id === assignmentId)?.status).toBe('done')
  })

  it.each([
    ['a path that does not exist', async () => '/nonexistent/crewboard-project'],
    ['a folder outside git', () => mkdtemp(join(tmpdir(), 'cb-nogit-'))],
  ])('refuses %s without stopping the server', async (_name, path) => {
    const { server, call } = await start()
    const r = await call('crewboard_start_goal', { project: await path(), title: 'x', criteria: [] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('project')
    expect(await (await fetch(`${server.url}/api/health`)).json()).toEqual({ ok: true })
  })

  it('cancels a goal branch with its live work', async () => {
    const { app, fake, call, project } = await start()
    fake.setFallback({ hold: true })
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Кухня', criteria: [] })).json() as { goalId: string }
    const { assignmentId: box } = (await call('crewboard_assign', { project, goalId, title: 'Короб', criteria: [], resultKind: 'local', provider: 'codex' })).json() as { assignmentId: string }
    const { assignmentId: geo } = (await call('crewboard_assign', { project, goalId, parentId: box, title: 'Тесты', criteria: [], resultKind: 'local', provider: 'claude' })).json() as { assignmentId: string }
    await app.tick()
    await call('crewboard_cancel', { project, goalId, assignmentId: box, reason: 'курс изменён' })
    expect(fake.cancelled.length).toBe(2)
    const tree = (await call('crewboard_status', { project, goalId })).json() as AssignmentView
    expect(tree.children[0]!.status).toBe('cancelled')
    expect(tree.children[0]!.children.find((c) => c.id === geo)?.status).toBe('cancelled')
  })
  it('answers an unknown MCP session with 404 so the lead re-initialises after a restart', async () => {
    const { server } = await start()
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'gone-after-restart' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(404)
  })

  it('does not pile timer ticks up behind a slow one', async () => {
    const { app, fake, call, project } = await start()
    fake.setFallback({ hold: true })
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Кухня', criteria: [] })).json() as { goalId: string }
    await call('crewboard_assign', { project, goalId, title: 'Короб', criteria: [], resultKind: 'local', provider: 'codex' })
    fake.stats.status = 0
    fake.stats.statusDelayMs = 50
    await Promise.all(Array.from({ length: 10 }, () => app.tick()))
    expect(fake.stats.status).toBeLessThanOrEqual(2)
  })

  it('waits for news across projects', async () => {
    const { server, call, project } = await start()
    const other = await gitRepo()
    const response = await fetch(`${server.url}/api/lead/wait?project=${encodeURIComponent(project)}&project=${encodeURIComponent(other)}&timeoutMs=1`)
    expect(response.status).toBe(204)
    const { goalId } = (await call('crewboard_start_goal', { project: other, title: 'I', criteria: [] })).json() as { goalId: string }
    await fetch(`${server.url}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: other, goalId, assignmentId: goalId, action: 'discuss' }) })
    const result = await fetch(`${server.url}/api/lead/wait?project=${encodeURIComponent(project)}&project=${encodeURIComponent(other)}&timeoutMs=50`)
    expect(result.status).toBe(200)
    expect((await result.json() as { projects: Array<{ project: string }> }).projects.map((p) => p.project)).toEqual([await realpath(other)])
  })

  it('registers a project only when a goal starts in it', async () => {
    const { server, call, env, project } = await start()
    const other = await gitRepo()
    await fetch(`${server.url}/api/lead/wait?project=${encodeURIComponent(other)}&timeoutMs=1`)
    await call('crewboard_start_goal', { project, title: 'Кухня', criteria: [] })
    const { readFile, realpath } = await import('node:fs/promises')
    const listed = (JSON.parse(await readFile(join(env.CREWBOARD_HOME, 'projects.json'), 'utf8')) as { projects: string[] }).projects
    expect(listed).toEqual([await realpath(project)])
  })

  it('tells the lead to wait with the crewboard command', async () => {
    const { server } = await start()
    const client = new Client({ name: 'instructions', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)))
    const text = client.getInstructions() ?? ''
    await client.close()
    expect(text).toContain('crewboard wait --project')
    // The command was renamed for the release; the old name must not linger in what the lead reads.
    expect(text).not.toContain(`crewboard${'-app'}`)
  })
})

