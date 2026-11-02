import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoalEvent } from '../src/model/types.js'
import type { ProjectSummary } from '../src/owner.js'
import { startApp } from './helpers.js'

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

async function escalated() {
  const t = await startApp()
  running.push(t)
  t.fake.script({ final: '<crewboard-question>Шторка или слой?\n\n- Шторка снизу\n- Слой</crewboard-question>' }, { hold: true })
  const { goalId } = await t.call<{ goalId: string }>('crewboard_start_goal', { project: t.project, title: 'Кухня', criteria: [] })
  const { assignmentId } = await t.call<{ assignmentId: string }>('crewboard_assign', { project: t.project, goalId, title: 'Панель', criteria: [], resultKind: 'local', provider: 'claude' })
  await t.app.tick()
  await t.call('crewboard_inbox', { project: t.project })
  await t.call('crewboard_escalate', { project: t.project, goalId, assignmentId, why: 'вопрос вкуса' })
  const answer = (body: Record<string, unknown>) =>
    fetch(`${t.server.url}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: t.project, goalId, assignmentId, ...body }) })
  return { ...t, goalId, assignmentId, answer }
}

describe('owner answer', () => {
  it('reaches the worker and the lead, and only once', async () => {
    const t = await escalated()
    const before = (await (await fetch(`${t.server.url}/api/projects`)).json()) as ProjectSummary[]
    expect(before[0]!.goals[0]!.counts.waiting_owner).toBe(1)

    expect((await t.answer({ text: 'Шторка снизу' })).status).toBe(204)
    const own = (await (await fetch(`${t.server.url}/api/goals/${t.goalId}/events?project=${encodeURIComponent(t.project)}&assignmentId=${t.assignmentId}`)).json()) as GoalEvent[]
    expect(own.findLast((e) => e.type === 'answered')).toMatchObject({ actor: 'owner', text: 'Шторка снизу' })
    expect(t.fake.runs.at(-1)!.prompt).toContain('Шторка снизу')
    const inbox = await t.call<GoalEvent[]>('crewboard_inbox', { project: t.project })
    expect(inbox.map((e) => [e.type, e.actor])).toEqual([['answered', 'owner']])
    expect((await t.answer({ text: 'Шторка снизу' })).status).toBe(409)
  })

  it.each([
    ['no text', {}],
    ['empty text', { text: '   ' }],
    ['unknown assignment', { text: 'да', assignmentId: 'a-nope' }],
  ])('refuses %s with 400', async (_name, body) => {
    const t = await escalated()
    expect((await t.answer(body)).status).toBe(400)
  })

  it.each([
    ['a body that is not declared JSON', { 'content-type': 'text/plain' }, 415],
    ['a request from another site', { 'content-type': 'application/json', origin: 'https://evil.example' }, 403],
  ])('refuses %s', async (_name, headers, status) => {
    const t = await escalated()
    const res = await fetch(`${t.server.url}/api/answer`, { method: 'POST', headers, body: JSON.stringify({ project: t.project, goalId: t.goalId, assignmentId: t.assignmentId, text: 'да' }) })
    expect(res.status).toBe(status)
  })

  // A site whose DNS name re-points to 127.0.0.1 sends its own name as Host and Origin: same-origin, but not ours.
  it.each([
    ['a screen write', 'POST', '/api/answer'],
    ['the lead\'s MCP endpoint', 'POST', '/mcp'],
    ['a read of the goals', 'GET', '/api/projects'],
  ])('refuses %s addressed to a foreign host name', async (_name, method, path) => {
    const t = await escalated()
    const port = new URL(t.server.url).port
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${t.server.url}${path}`, { method, headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }) : undefined)
    })
    expect(status).toBe(403)
  })

  it('answers history for a goal without a transcript plainly', async () => {
    const t = await escalated()
    const h = await (await fetch(`${t.server.url}/api/goals/${t.goalId}/history?project=${encodeURIComponent(t.project)}`)).json()
    expect(h).toEqual({ available: false, truncated: false, items: [] })
  })
})

