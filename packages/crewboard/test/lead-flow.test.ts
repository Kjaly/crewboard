import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { AssignmentView, GoalEvent } from '../src/model/types.js'
import { createFakeBackend } from './fake-backend.js'
import { createLeadMcp } from '../src/lead/mcp.js'

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
  it('rejects reviews of missing or unreported work', async () => {
    const { call, project } = await start()
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Goal', criteria: [] })).json() as { goalId: string }
    const review = { project, goalId, title: 'Review', criteria: [], resultKind: 'answer', provider: 'codex' }
    expect((await call('crewboard_assign', { ...review, reviewOf: 'missing' })).isError).toBe(true)
    const { assignmentId } = (await call('crewboard_assign', { ...review, title: 'Work', resultKind: 'branch' })).json() as { assignmentId: string }
    expect((await call('crewboard_assign', { ...review, reviewOf: assignmentId })).isError).toBe(true)
  })
  it('reviews a branch version, detects later commits and returns findings', async () => {
    const { app, fake, call, project } = await start()
    const finding = { severity: 'high', file: 'README.md', line: 1, problem: 'Missing text', scenario: 'A reader opens it' }
    fake.script({ final: '<crewboard-report>Work complete</crewboard-report>' }, { final: `<crewboard-report>${JSON.stringify({ verdict: 'changes', findings: [finding] })}</crewboard-report>` }, { hold: true })
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Goal', criteria: [] })).json() as { goalId: string }
    const { assignmentId } = (await call('crewboard_assign', { project, goalId, title: 'Work', criteria: ['Readable'], resultKind: 'branch', provider: 'codex' })).json() as { assignmentId: string }
    await app.tick(); await app.tick()
    const workCwd = fake.runs[0]!.cwd
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workCwd, encoding: 'utf8' }).trim()
    const review = await call('crewboard_assign', { project, goalId, title: 'Review', criteria: [], resultKind: 'answer', provider: 'codex', reviewOf: assignmentId })
    expect(review.isError, review.text).toBe(false)
    const { assignmentId: reviewId } = review.json() as { assignmentId: string }
    await app.tick(); await app.tick()
    expect(fake.runs[1]).toMatchObject({ cwd: workCwd, readOnly: true })
    expect(fake.runs[1]!.prompt).toContain(head)
    expect(fake.runs[1]!.prompt).toContain('Readable')
    let tree = (await call('crewboard_status', { project, goalId })).json() as AssignmentView
    // A review gets the findings schema by default, and its checked result is what the lead reads.
    expect(tree.children.find((n) => n.id === reviewId)).toMatchObject({ result: { verdict: 'changes' } })
    expect(tree.children.find((n) => n.id === assignmentId)?.reviews?.[0]).toMatchObject({ id: reviewId, commit: head, verdict: 'changes', stale: false, findings: [finding] })
    await writeFile(join(workCwd, 'README.md'), 'changed')
    execFileSync('git', ['add', 'README.md'], { cwd: workCwd })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fix'], { cwd: workCwd })
    tree = (await call('crewboard_status', { project, goalId })).json() as AssignmentView
    expect(tree.children.find((n) => n.id === assignmentId)?.reviews?.[0]?.stale).toBe(true)
    expect((await call('crewboard_return', { project, goalId, assignmentId, reviewId })).isError).toBe(false)
    expect(fake.runs[2]!.prompt).toContain('Missing text')
  })
  it('accepts a schema over MCP and exposes the checked result in inbox and status', async () => {
    const fake = createFakeBackend()
    const app = createApp({ env: { ...process.env, CREWBOARD_NO_CATALOG: '1', CREWBOARD_HOME: await mkdtemp(join(tmpdir(), 'cb-schema-home-')) }, backendFor: () => async () => fake.backend })
    const mcp = createLeadMcp(app.commands)
    const client = new Client({ name: 'test-lead', version: '1.0.0' })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverTransport)
    await client.connect(clientTransport)
    closers.push(() => mcp.close(), () => client.close())
    const project = await gitRepo()
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }
      return { isError: response.isError === true, json: () => JSON.parse(response.content[0]!.text) as unknown }
    }
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Review', criteria: [] })).json() as { goalId: string }
    const schema = { type: 'object', properties: { verdict: { const: 'pass' } }, required: ['verdict'], additionalProperties: false }
    fake.script({ final: '{"handback":"<crewboard-report>Checked</crewboard-report>","result":{"verdict":"pass"}}' })
    const base = { project, goalId, title: 'Review files', criteria: [], resultKind: 'answer', provider: 'codex' }
    expect((await call('crewboard_assign', { ...base, schema: { type: 'invalid' } })).isError).toBe(true)
    const assigned = await call('crewboard_assign', { ...base, schema })
    expect(assigned.isError).toBe(false)
    const { assignmentId } = assigned.json() as { assignmentId: string }
    await app.tick()
    await app.tick()
    const events = (await call('crewboard_inbox', { project })).json() as GoalEvent[]
    expect(events.find((e) => e.type === 'reported' && e.assignmentId === assignmentId)).toMatchObject({ result: { verdict: 'pass' } })
    const status = (await call('crewboard_status', { project, goalId })).json() as AssignmentView
    expect(status.children.find((n) => n.id === assignmentId)).toMatchObject({ schema, result: { verdict: 'pass' } })
  })

  it('rejects invalid dependencies and reports a later cancellation once', async () => {
    const { app, call, project } = await start()
    const { goalId } = (await call('crewboard_start_goal', { project, title: 'Goal', criteria: [] })).json() as { goalId: string }
    const base = { project, goalId, title: 'Work', criteria: [], resultKind: 'local', provider: 'codex' }
    expect((await call('crewboard_assign', { ...base, after: ['missing'] })).isError).toBe(true)
    const { assignmentId } = (await call('crewboard_assign', base)).json() as { assignmentId: string }
    const { assignmentId: waiting } = (await call('crewboard_assign', { ...base, after: [assignmentId] })).json() as { assignmentId: string }
    // Every accepted edge points to an earlier assignment, so a new assignment cannot create a cycle.
    const tree = (await call('crewboard_status', { project, goalId })).json() as AssignmentView
    expect(tree.children.find((n) => n.id === waiting)?.after).toEqual([assignmentId])
    await call('crewboard_cancel', { project, goalId, assignmentId, reason: 'cancelled' })
    expect((await call('crewboard_assign', { ...base, after: [assignmentId] })).isError).toBe(true)
    await app.tick()
    await app.tick()
    const events = (await call('crewboard_inbox', { project })).json() as GoalEvent[]
    expect(events.filter((e) => e.type === 'progress' && e.code === 'blocked_dependency' && e.assignmentId === waiting)).toHaveLength(1)
    expect(((await call('crewboard_inbox', { project })).json() as GoalEvent[]).filter((e) => e.type === 'progress' && e.code === 'blocked_dependency')).toHaveLength(0)
  })
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
