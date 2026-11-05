import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type ProjectContext } from '../src/app.js'
import { createLeadMcp } from '../src/lead/mcp.js'
import { availableActions, flatten } from '../src/model/project.js'
import { LEAD_SILENT_PAUSE_MS } from '../src/model/thresholds.js'
import { REQUEST_ACTIONS, type AssignmentView, type GoalEvent } from '../src/model/types.js'
import { emergencyStop, requestAsOwner } from '../src/requests.js'
import { createEventStore } from '../src/store/event-store.js'
import { createInbox } from '../src/store/inbox.js'
import { runsDir } from '../src/store/paths.js'
import { createSupervisor, gitWorktree } from '../src/supervisor.js'
import { createAgents } from '../src/workers/agents.js'
import { createPool } from '../src/workers/pool.js'
import { createStepsReader } from '../src/workers/steps.js'
import { createFakeBackend } from './fake-backend.js'
import { gitRepo } from './helpers.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

/** Exercise the MCP wire protocol without opening a TCP socket (also works in the worker sandbox). */
async function start(now = () => new Date()) {
  const fake = createFakeBackend()
  const home = await mkdtemp(join(tmpdir(), 'cb-external-'))
  const env = { ...process.env, CREWBOARD_HOME: home, CREWBOARD_NO_CATALOG: '1', CREWBOARD_CLAUDE_PROJECTS: join(home, 'claude'), CREWBOARD_CODEX_SESSIONS: join(home, 'codex'), CREWBOARD_DSH_SESSIONS: join(home, 'dsh') }
  const app = createApp({ env, backendFor: () => async () => fake.backend, now })
  const server = createLeadMcp(app.commands)
  const client = new Client({ name: 'external-test', version: '1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(async () => { await client.close(); await server.close() })
  const call = async <T = unknown>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }
    if (result.isError) throw new Error(result.content[0]?.text)
    return JSON.parse(result.content[0]?.text ?? '') as T
  }
  return { app, fake, env, call, project: await gitRepo() }
}

describe('external work over MCP', () => {
  it('tracks nested batches, progress, stale open work and explicit outcomes without running a worker, even after a restart', async () => {
    let clock = Date.now()
    const t = await start(() => new Date(clock))
    const { project, call, fake } = t
    const { goalId } = await call<{ goalId: string }>('crewboard_start_goal', { project, title: 'External work', criteria: [] })
    const target = { project, goalId }
    const { assignmentId: root } = await call<{ assignmentId: string }>('crewboard_track', { ...target, title: 'Lead operation', kind: 'other', externalId: 'operation-1' })
    const { assignments } = await call<{ assignments: Array<{ key: string; assignmentId: string }> }>('crewboard_track_batch', {
      ...target,
      nodes: [
        { key: 'agent', parentKey: 'workflow', title: 'Review', kind: 'agent', model: 'review-model', externalId: 'agent-7', phase: 'reading' },
        { key: 'workflow', parentId: root, title: 'Workflow', kind: 'workflow', externalId: 'workflow-42' },
        { key: 'delegate', parentKey: 'workflow', title: 'porch', kind: 'delegate' },
        { key: 'leaf', parentKey: 'agent', title: 'Validation', kind: 'other' },
      ],
    })
    const ids = Object.fromEntries(assignments.map((a) => [a.key, a.assignmentId]))
    const agentId = ids.agent!
    await call('crewboard_track_update', { ...target, assignmentId: agentId, text: 'Checking changes', phase: 'checking' })
    await call('crewboard_track_update', { ...target, assignmentId: agentId, text: 'Checking tests' })
    const tree = await call<AssignmentView>('crewboard_status', target)
    const nodes = flatten(tree)
    expect(nodes).toHaveLength(6)
    expect(nodes.find((n) => n.id === agentId)).toMatchObject({
      parentId: ids.workflow, model: 'review-model', status: 'running',
      doing: { kind: 'text', text: 'Checking tests' },
      external: { kind: 'agent', externalId: 'agent-7', phase: 'checking', stale: false },
    })
    expect(nodes.find((n) => n.id === ids.leaf)?.parentId).toBe(agentId)
    expect((await call<Array<{ counts: { running: number } }>>('crewboard_goals', { project }))[0]?.counts.running).toBe(5)

    clock += LEAD_SILENT_PAUSE_MS + 60_000
    await t.app.tick()
    const stale = flatten(await call<AssignmentView>('crewboard_status', target)).slice(1)
    expect(stale.every((n) => n.external?.stale && n.status === 'waiting_answer')).toBe(true)
    expect((await call<Array<{ counts: { waiting_lead: number } }>>('crewboard_goals', { project }))[0]?.counts.waiting_lead).toBe(5)
    await expect(call('crewboard_track_finish', { ...target, assignmentId: root, outcome: 'success', summary: 'premature' })).rejects.toThrow()

    for (const assignmentId of [ids.leaf, agentId, ids.delegate, ids.workflow, root]) {
      await call('crewboard_track_finish', { ...target, assignmentId, outcome: assignmentId === ids.leaf ? 'failure' : 'success', summary: `Result ${assignmentId}` })
    }
    const restarted = createApp({ env: t.env, backendFor: () => async () => fake.backend, now: () => new Date(clock) })
    await restarted.tick()
    const finished = flatten(await restarted.commands.status(target)).slice(1)
    expect(finished.every((n) => n.status === 'done' && !n.external?.stale && !n.runId)).toBe(true)
    expect(finished.find((n) => n.id === ids.leaf)).toMatchObject({ external: { outcome: 'failure' }, doing: { kind: 'text', text: `Result ${ids.leaf}` } })
    expect(finished.find((n) => n.id === root)?.external?.outcome).toBe('success')
    await expect(call('crewboard_track_update', { ...target, assignmentId: agentId, text: 'too late' })).rejects.toThrow()
    const events = await createEventStore(project).read(goalId)
    expect(events.some((e) => e.type === 'run_started' || e.type === 'run_ended')).toBe(false)
    expect(fake.launches).toHaveLength(0)
    expect(fake.cancelled).toHaveLength(0)
    expect(fake.stats.status).toBe(0)
  })

  it('rejects invalid batches and unsupported lead or owner controls without writing their effects', async () => {
    const t = await start()
    const { project, call } = t
    const { goalId } = await call<{ goalId: string }>('crewboard_start_goal', { project, title: 'Controls', criteria: [] })
    const target = { project, goalId }
    const { assignmentId } = await call<{ assignmentId: string }>('crewboard_track', { ...target, title: 'Agent', kind: 'agent' })
    const at = { ...target, assignmentId }
    const store = createEventStore(project)
    const before = await store.read(goalId)
    for (const nodes of [
      [{ title: 'valid', kind: 'agent' }, { title: 'bad parent', kind: 'agent', parentId: 'missing' }],
      [{ title: 'bad ref', kind: 'agent', parentKey: 'missing' }],
      [{ title: 'one', kind: 'agent', key: 'same' }, { title: 'two', kind: 'agent', key: 'same' }],
      [{ title: 'one', kind: 'agent', key: 'a', parentKey: 'b' }, { title: 'two', kind: 'agent', key: 'b', parentKey: 'a' }],
    ]) await expect(call('crewboard_track_batch', { ...target, nodes })).rejects.toThrow()
    for (const [tool, args] of [
      ['crewboard_answer', { text: 'answer' }], ['crewboard_steer', { text: 'steer' }],
      ['crewboard_return', { note: 'return' }], ['crewboard_escalate', { text: 'question', why: 'why' }],
      ['crewboard_close', { summary: 'close' }], ['crewboard_cancel', { reason: 'cancel' }],
      ['crewboard_track_update', { assignmentId: goalId, text: 'not external' }],
      ['crewboard_track_finish', { assignmentId: goalId, outcome: 'success', summary: 'not external' }],
    ] as const) await expect(call(tool, { ...at, ...args })).rejects.toThrow()
    const external = flatten(await call<AssignmentView>('crewboard_status', target)).find((n) => n.id === assignmentId)!
    expect(availableActions(external)).toEqual(['discuss'])
    const supervisor = createSupervisor({ repo: project, store, pool: createPool({ repo: project, runsDir: runsDir(project), backendFor: async () => t.fake.backend }), worktree: gitWorktree, now: () => new Date() })
    const ctx: ProjectContext = {
      repo: project, store, supervisor, agents: createAgents(t.env), inbox: createInbox(store), steps: createStepsReader(store, async () => t.fake.backend),
      exclusive: (fn) => fn(ctx), register: async () => {}, tickOnce: () => supervisor.tick(),
    }
    for (const action of REQUEST_ACTIONS.filter((a) => a !== 'discuss')) {
      await expect(requestAsOwner(ctx, { goalId, assignmentId, action, text: 'please', provider: 'codex' }, new Date())).rejects.toThrow()
    }
    await expect(emergencyStop(ctx, { goalId, assignmentId }, new Date())).rejects.toThrow()
    await expect(supervisor.deliver(goalId, assignmentId, 'message')).rejects.toThrow()
    await expect(supervisor.reassign(goalId, assignmentId, 'codex')).rejects.toThrow()
    expect(await store.read(goalId)).toEqual(before)
    await call('crewboard_track_finish', { ...at, outcome: 'success', summary: 'done' })
    await expect(call('crewboard_track', { ...target, parentId: assignmentId, title: 'late', kind: 'agent' })).rejects.toThrow()
    expect(t.fake.launches).toHaveLength(0)
  })

  it('keeps goal_idle blocked by stale external work and clears an old idle notification when new external work starts', async () => {
    let clock = Date.now()
    const t = await start(() => new Date(clock))
    const { project, call } = t
    const { goalId } = await call<{ goalId: string }>('crewboard_start_goal', { project, title: 'Idle', criteria: [] })
    const target = { project, goalId }
    const { assignmentId: external } = await call<{ assignmentId: string }>('crewboard_track', { ...target, title: 'porch', kind: 'delegate' })
    const { assignmentId: worker } = await call<{ assignmentId: string }>('crewboard_assign', { ...target, title: 'Worker', criteria: [], resultKind: 'answer', provider: 'codex' })
    await t.app.tick()
    await t.app.tick()
    await call('crewboard_close', { ...target, assignmentId: worker, summary: 'accepted' })
    clock += LEAD_SILENT_PAUSE_MS + 60_000
    await t.app.tick()
    const inbox = createInbox(createEventStore(project))
    const idle = async () => (await inbox.pending()).filter((e) => e.type === 'progress' && e.code === 'goal_idle')
    expect(await idle()).toHaveLength(0)
    expect((await call<Array<{ counts: { waiting_lead: number; finished: number } }>>('crewboard_goals', { project }))[0]?.counts).toMatchObject({ waiting_lead: 1, finished: 1 })
    await expect(call('crewboard_close', { ...target, assignmentId: goalId, summary: 'premature' })).rejects.toThrow()
    await call('crewboard_track_finish', { ...target, assignmentId: external, outcome: 'failure', summary: 'external tool failed' })
    expect(await idle()).toHaveLength(1)
    const { assignmentId: next } = await call<{ assignmentId: string }>('crewboard_track', { ...target, title: 'Retry outside Crewboard', kind: 'other' })
    expect(await idle()).toHaveLength(0)
    await call('crewboard_track_finish', { ...target, assignmentId: next, outcome: 'success', summary: 'done' })
    expect(await idle()).toHaveLength(1)
    await t.app.tick()
    expect(await idle()).toHaveLength(1)
    await call('crewboard_close', { ...target, assignmentId: goalId, summary: 'goal accepted' })
    expect(await call<GoalEvent[]>('crewboard_inbox', { project })).toEqual([])
  })
})
