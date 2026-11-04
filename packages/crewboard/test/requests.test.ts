import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProjectContext } from '../src/app.js'
import { createLeadCommands } from '../src/lead/commands.js'
import { flatten } from '../src/model/project.js'
import { ConflictError, goalTree } from '../src/owner.js'
import * as requests from '../src/requests.js'
import { createEventStore } from '../src/store/event-store.js'
import { createInbox } from '../src/store/inbox.js'
import { runsDir } from '../src/store/paths.js'
import { createSupervisor } from '../src/supervisor.js'
import { builtinAgents } from '../src/workers/agents.js'
import { createPool } from '../src/workers/pool.js'
import { createStepsReader } from '../src/workers/steps.js'
import { createFakeBackend } from './fake-backend.js'
import { afterEach, describe, expect, it } from 'vitest'
import { LEAD_OFFLINE_MS } from '../src/model/thresholds.js'
import type { AssignmentView, GoalEvent, RequestAction } from '../src/model/types.js'
import { startApp } from './helpers.js'

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

async function setup(opts: { now?: () => Date } = {}) {
  const t = await startApp(opts)
  running.push(t)
  t.fake.setFallback({ hold: true })
  const { goalId } = await t.call<{ goalId: string }>('crewboard_start_goal', { project: t.project, title: 'Кухня', criteria: [] })
  const { assignmentId } = await t.call<{ assignmentId: string }>('crewboard_assign', { project: t.project, goalId, title: 'Короб', criteria: [], resultKind: 'local', provider: 'codex' })
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${t.server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: t.project, goalId, ...body }) })
  const ask = async (body: Record<string, unknown>) => post('/api/request', { assignmentId, ...body })
  const node = async (id = assignmentId) => {
    const tree = (await (await fetch(`${t.server.url}/api/goals/${goalId}?project=${encodeURIComponent(t.project)}`)).json()) as AssignmentView
    const find = (n: AssignmentView): AssignmentView | undefined => (n.id === id ? n : n.children.map(find).find(Boolean))
    return find(tree)!
  }
  const decide = (requestId: string, decision: 'accepted' | 'declined', reason?: string) =>
    t.call('crewboard_decide_request', { project: t.project, goalId, assignmentId, requestId, decision, ...(reason ? { reason } : {}) })
  return { ...t, goalId, assignmentId, ask, post, node, decide }
}

describe('the lead closing work', () => {
  it('stops a run still working on it, and does not close finished work again', async () => {
    const t = await setup()
    await t.call('crewboard_close', { project: t.project, goalId: t.goalId, assignmentId: t.assignmentId, summary: 'good enough' })
    expect(t.fake.cancelled.length).toBe(1)
    expect((await t.node()).status).toBe('done')
    await expect(t.call('crewboard_close', { project: t.project, goalId: t.goalId, assignmentId: t.assignmentId, summary: 'again' })).rejects.toThrow(/done/)
  })
})

describe('owner requests decided by the lead', () => {
  it('stops work once the lead accepts, and the lead hears about the request first', async () => {
    const t = await setup()
    const { requestId } = (await (await t.ask({ action: 'stop' })).json()) as { requestId: string }
    expect((await t.node()).request).toMatchObject({ state: 'pending', action: 'stop' })
    const inbox = await t.call<GoalEvent[]>('crewboard_inbox', { project: t.project })
    expect(inbox.map((e) => e.type)).toContain('owner_requested')
    await t.decide(requestId, 'accepted')
    expect(t.fake.cancelled.length).toBe(1)
    const after = await t.node()
    expect(after.status).toBe('cancelled')
    expect(after.doing).toMatchObject({ kind: 'cancelled', code: 'owner_stop' })
    expect(after.request).toBeUndefined()
  })

  it('launches an accepted handoff with its model and effort and keeps the chain', async () => {
    const t = await setup()
    await writeFile(join(t.env.CREWBOARD_HOME, 'agents.json'), JSON.stringify({ agents: { codex: { effort: 'low' }, claude: { effort: 'medium' } } }))
    const before = await t.node()
    expect(before.model).toBe('gpt-6.1-sol')
    expect(before.effort).toBeUndefined()
    const { agents: choices } = await t.call<{ agents: Array<{ id: string; models: unknown[]; efforts: string[]; defaultEffort: string | null }> }>('crewboard_agents', {})
    expect(choices.find((a) => a.id === 'claude')).toMatchObject({ models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus' }, { id: 'fable' }, { id: 'haiku' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' })
    expect(choices.find((a) => a.id === 'deepseek')).toMatchObject({ efforts: [], defaultEffort: null })
    const httpChoices = await (await fetch(`${t.server.url}/api/agents`)).json() as typeof choices
    for (const choice of choices) expect(httpChoices.find((a) => a.id === choice.id)).toMatchObject({ models: choice.models, efforts: choice.efforts, defaultEffort: choice.defaultEffort })
    const refused = await t.ask({ action: 'handoff', provider: 'claude', effort: 'ultra' })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('allowed levels: low, medium, high, xhigh, max') })
    const { requestId } = (await (await t.ask({ action: 'handoff', provider: 'claude', model: 'opus', effort: 'high' })).json()) as { requestId: string }
    expect(t.fake.launches).toHaveLength(1)
    expect((await t.node()).request).toMatchObject({ model: 'opus', effort: 'high', state: 'pending' })
    await t.decide(requestId, 'accepted')
    const after = await t.node()
    expect(after).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high' })
    expect(after.handoffs).toEqual([{ from: 'codex', to: 'claude' }])
    expect(t.fake.launches.at(-1)).toMatchObject({ agent: 'claude/opus', model: 'opus', effort: 'high' })
    const inbox = await t.call<GoalEvent[]>('crewboard_inbox', { project: t.project })
    expect(inbox.find((e) => e.type === 'owner_requested')).toMatchObject({ model: 'opus', effort: 'high' })
    const { requestId: back } = await (await t.ask({ action: 'handoff', provider: 'codex' })).json() as { requestId: string }
    await t.decide(back, 'accepted')
    expect(t.fake.launches.at(-1)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'low' })
    expect(await t.node()).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' })
  })

  it('hands work to the same agent with another model or effort, and refuses a handover that changes nothing', async () => {
    const t = await setup()
    const same = await t.ask({ action: 'handoff', provider: 'codex' })
    expect(same.status).toBe(400)
    expect(await same.json()).toMatchObject({ error: expect.stringContaining('changes nothing') })
    const { requestId } = (await (await t.ask({ action: 'handoff', provider: 'codex', model: 'gpt-6-astra', effort: 'high' })).json()) as { requestId: string }
    await t.decide(requestId, 'accepted')
    expect(t.fake.launches.at(-1)).toMatchObject({ model: 'gpt-6-astra', effort: 'high' })
    expect(await t.node()).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' })
  })

  it('needs a reason to decline and shows it on the node', async () => {
    const t = await setup()
    const { requestId } = (await (await t.ask({ action: 'stop' })).json()) as { requestId: string }
    await expect(t.decide(requestId, 'declined')).rejects.toThrow(/reason/)
    await t.decide(requestId, 'declined', 'Нужна для сборочной инструкции')
    expect((await t.node()).request).toMatchObject({ state: 'declined', reason: 'Нужна для сборочной инструкции' })
  })

  it('refuses a second request while the first waits', async () => {
    const t = await setup()
    expect((await t.ask({ action: 'stop' })).status).toBe(200)
    expect((await t.ask({ action: 'clarify', text: 'ещё' })).status).toBe(409)
  })

  it('refuses to carry out a request the node no longer allows', async () => {
    const t = await setup()
    const { requestId } = (await (await t.ask({ action: 'stop' })).json()) as { requestId: string }
    await t.call('crewboard_close', { project: t.project, goalId: t.goalId, assignmentId: t.assignmentId, summary: 'готово' })
    const before = (await (await fetch(`${t.server.url}/api/goals/${t.goalId}/events?project=${encodeURIComponent(t.project)}&assignmentId=${t.assignmentId}`)).json()) as GoalEvent[]
    await expect(t.decide(requestId, 'accepted')).rejects.toThrow(/done/)
    const after = (await (await fetch(`${t.server.url}/api/goals/${t.goalId}/events?project=${encodeURIComponent(t.project)}&assignmentId=${t.assignmentId}`)).json()) as GoalEvent[]
    expect(after.length).toBe(before.length)
  })

  it('starts queued work early once the lead agrees', async () => {
    const t = await setup()
    const { assignmentId: later } = await t.call<{ assignmentId: string }>('crewboard_assign', { project: t.project, goalId: t.goalId, title: 'Инструкция', criteria: [], resultKind: 'local', provider: 'deepseek', after: [t.assignmentId] })
    expect((await t.node(later)).status).toBe('queued')
    const { requestId } = (await (await t.post('/api/request', { assignmentId: later, action: 'start_now' })).json()) as { requestId: string }
    await t.call('crewboard_decide_request', { project: t.project, goalId: t.goalId, assignmentId: later, requestId, decision: 'accepted' })
    expect((await t.node(later)).runId).toBeTruthy()
  })

  it('stops at once even while the lead is online', async () => {
    const t = await setup()
    expect((await t.post('/api/emergency-stop', { assignmentId: t.assignmentId })).status).toBe(204)
    expect((await t.node()).status).toBe('cancelled')
    const inbox = await t.call<GoalEvent[]>('crewboard_inbox', { project: t.project })
    expect(inbox.some((e) => e.type === 'cancelled' || e.type === 'owner_requested')).toBe(true)
  })

  it('does not offer to revive work under a finished parent', async () => {
    const t = await setup()
    const { assignmentId: child } = await t.call<{ assignmentId: string }>('crewboard_assign', { project: t.project, goalId: t.goalId, parentId: t.assignmentId, title: 'Деталь', criteria: [], resultKind: 'local', provider: 'codex' })
    await t.call('crewboard_cancel', { project: t.project, goalId: t.goalId, assignmentId: t.assignmentId, reason: 'курс' })
    expect((await t.post('/api/request', { assignmentId: child, action: 'revive', text: 'верни' })).status).toBe(409)
  })

  it('keeps a pending request visible and decidable after a discussion note', async () => {
    const t = await setup()
    const { requestId } = (await (await t.ask({ action: 'stop' })).json()) as { requestId: string }
    expect((await t.ask({ action: 'discuss' })).status).toBe(200)
    expect((await t.node()).request).toMatchObject({ id: requestId, state: 'pending' })
    await t.decide(requestId, 'accepted')
    expect((await t.node()).status).toBe('cancelled')
  })

  it('drops a pending request once the work is closed, so it can be reopened', async () => {
    const t = await setup()
    await t.ask({ action: 'stop' })
    await t.call('crewboard_close', { project: t.project, goalId: t.goalId, assignmentId: t.assignmentId, summary: 'готово' })
    const n = await t.node()
    expect(n.request).toBeUndefined()
    expect((await t.ask({ action: 'reopen', text: 'ещё кнопку' })).status).toBe(200)
  })

  it('counts a lead that waits for news as present', async () => {
    let clock = Date.now()
    const t = await setup({ now: () => new Date(clock) })
    clock += LEAD_OFFLINE_MS + 60_000
    await fetch(`${t.server.url}/api/lead/wait?project=${encodeURIComponent(t.project)}&timeoutMs=1`)
    const projects = (await (await fetch(`${t.server.url}/api/projects`)).json()) as Array<{ goals: Array<{ leadOnline: boolean }> }>
    expect(projects[0]!.goals[0]!.leadOnline).toBe(true)
  })
})

/** The request lifecycle without HTTP: a real journal, projection, inbox and supervisor. */
async function localRequest(action: Exclude<RequestAction, 'discuss'> = 'clarify') {
  const repo = await mkdtemp(join(tmpdir(), 'cb-request-'))
  const store = createEventStore(repo)
  const fake = createFakeBackend()
  fake.setFallback({ hold: true })
  const backendFor = async () => fake.backend
  const pool = createPool({ backendFor, runsDir: runsDir(repo), repo })
  const supervisor = createSupervisor({ repo, store, pool, now: () => new Date(), worktree: async () => repo })
  let chain: Promise<unknown> = Promise.resolve()
  const ctx: ProjectContext = {
    repo, store, supervisor, agents: builtinAgents, inbox: createInbox(store), steps: createStepsReader(store, backendFor),
    exclusive(fn) {
      const next = chain.then(() => fn(ctx))
      chain = next.catch(() => undefined)
      return next
    },
    register: async () => {}, tickOnce: () => supervisor.tick(),
  }
  const commands = createLeadCommands(async () => ctx, () => new Date())
  const { goalId } = await commands.startGoal({ project: repo, title: 'Request lifecycle', criteria: [] })
  const { assignmentId: blocker } = await commands.assign({ project: repo, goalId, title: 'Blocker', criteria: [], resultKind: 'local', provider: 'codex' })
  const { assignmentId } = await commands.assign({ project: repo, goalId, title: 'Work', criteria: [], resultKind: 'local', provider: 'codex', ...(action === 'start_now' || action === 'cancel' ? { after: [blocker] } : {}) })
  const at = { goalId, assignmentId }
  if (action === 'reopen') await commands.close({ project: repo, ...at, summary: 'Done' })
  if (action === 'revive') await commands.cancel({ project: repo, ...at, reason: 'Stopped' })
  const { requestId } = await requests.requestAsOwner(ctx, { ...at, action, text: 'Keep the handle', ...(action === 'handoff' ? { provider: 'claude', model: 'opus' } : {}) }, new Date())
  const decide = (decision: 'accepted' | 'declined' = 'accepted') => commands.decideRequest({ project: repo, ...at, requestId, decision, reason: 'Keep working' })
  const withdraw = () => requests.withdrawRequest(ctx, { ...at, requestId }, new Date())
  const node = async () => flatten(await goalTree(ctx, goalId, new Date())).find((n) => n.id === assignmentId)!
  return { ctx, fake, at, requestId, decide, withdraw, node }
}

describe('request lifecycle without HTTP', () => {
  it.each(['clarify', 'stop', 'cancel', 'handoff', 'start_now', 'reopen', 'revive'] as const)('records a failed accepted %s for the owner and the lead', async (action) => {
    const t = await localRequest(action)
    if (action === 'clarify') t.fake.backend.steer = async () => { throw new Error('Worker unavailable; Bearer secret') }
    else if (action === 'stop') t.fake.backend.cancel = async () => { throw new Error('Worker unavailable') }
    else if (action === 'cancel') t.ctx.supervisor.cancelTree = async () => { throw new Error('Worker unavailable') }
    else t.fake.script({ refuse: 'Worker unavailable' })
    await expect(t.decide()).rejects.toThrow(/Worker unavailable/)
    const events = await t.ctx.store.read(t.at.goalId)
    expect(events).toContainEqual(expect.objectContaining({ type: 'request_decided', requestId: t.requestId, decision: 'accepted' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'request_completed', requestId: t.requestId, outcome: 'failed', reason: expect.stringContaining('Worker unavailable') }))
    expect((await t.node()).request).toMatchObject({ id: t.requestId, state: 'failed', reason: action === 'clarify' ? 'Worker unavailable; Bearer [redacted]' : 'Worker unavailable' })
    expect(await t.ctx.inbox.pending()).toContainEqual(expect.objectContaining({ type: 'request_completed', requestId: t.requestId, outcome: 'failed' }))
  })

  it.each(['pending', 'accepted', 'recovered', 'declined'] as const)('allows withdrawal only before a decision (%s)', async (state) => {
    const t = await localRequest()
    if (state === 'recovered') t.fake.finish((await t.node()).runId!, { fail: 'old run failed' })
    if (state !== 'pending') await t.decide(state === 'recovered' ? 'accepted' : state)
    if (state === 'accepted' || state === 'recovered') {
      expect(await t.ctx.store.read(t.at.goalId)).toContainEqual(expect.objectContaining({ type: 'request_completed', requestId: t.requestId, outcome: 'succeeded' }))
    }
    if (state === 'pending') {
      await t.withdraw()
      expect((await t.node()).request).toBeUndefined()
      expect(await t.ctx.inbox.pending()).toContainEqual(expect.objectContaining({ type: 'request_withdrawn', requestId: t.requestId, actor: 'owner' }))
      await expect(t.withdraw()).rejects.toBeInstanceOf(ConflictError)
    } else {
      await expect(t.withdraw()).rejects.toBeInstanceOf(ConflictError)
      expect((await t.ctx.store.read(t.at.goalId)).some((e) => e.type === 'request_withdrawn')).toBe(false)
    }
  })

  it.each(['accepted', 'declined'] as const)('refuses a %s decision after withdrawal without applying the action', async (decision) => {
    const t = await localRequest()
    await t.withdraw()
    const before = await t.ctx.store.read(t.at.goalId)
    await expect(t.decide(decision)).rejects.toThrow(/withdrawn/)
    expect(await t.ctx.store.read(t.at.goalId)).toEqual(before)
  })
})
