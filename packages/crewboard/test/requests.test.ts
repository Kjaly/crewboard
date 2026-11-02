import { afterEach, describe, expect, it } from 'vitest'
import { LEAD_OFFLINE_MS } from '../src/model/thresholds.js'
import type { AssignmentView, GoalEvent } from '../src/model/types.js'
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

  it('hands work to another provider and keeps the chain', async () => {
    const t = await setup()
    const { requestId } = (await (await t.ask({ action: 'handoff', provider: 'claude' })).json()) as { requestId: string }
    await t.decide(requestId, 'accepted')
    const after = await t.node()
    expect(after.provider).toBe('claude')
    expect(after.handoffs).toEqual([{ from: 'codex', to: 'claude' }])
    expect(t.fake.runs.at(-1)!.agent).toBe('claude/sonnet')
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

