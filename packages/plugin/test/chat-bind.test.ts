import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initPlan, type Backends } from '@crewboard/core'
import type { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import { OrchestraService } from '../src/host/service.js'
import type { Native } from '../src/host/native.js'
import { API_PREFIX } from '../src/shared/types.js'
import { bindChat, planOfSession, readChats, unbindChat, writeChats } from '../src/host/chat.js'
import type { SessionControllerFace } from '../src/host/dsh.js'

const now = () => new Date('2026-09-22T12:00:00Z')
const sessions: SessionControllerFace = {
  create: async () => ({ sessionId: 'unused' }), prompt: async () => ({ accepted: true }), inspect: async (sessionId) => ({ sessionId }),
}
async function repo() { const root = await mkdtemp(join(tmpdir(), 'chat-bind-')); await initPlan(root, 'Цель', now()); return root }

describe('one plan per session', () => {
  it('replaces both conflicts and reports what was removed', async () => {
    const root = await repo()
    await initPlan(root, 'Другой', now(), 'other')
    await writeChats(root, {
      main: { sessionId: 'old-session', wake: false, boundAt: 'old' },
      other: { sessionId: 'new-session', wake: false, boundAt: 'old' },
    })
    const result = await bindChat({ sessions, now, newId: () => 'request' }, { root, planId: 'main', sessionId: 'new-session' })
    expect(result.replaced).toEqual({ planId: 'other', sessionId: 'old-session' })
    expect(await planOfSession(root, 'new-session')).toBe('main')
    expect(await readChats(root)).toEqual({ main: result.binding })
  })

  it('unbinds one plan while preserving other file fields and bindings', async () => {
    const root = await repo()
    const file = join(root, '.orchestration', 'chats.json')
    await writeFile(file, JSON.stringify({ main: { sessionId: 's1', wake: true, boundAt: 't' }, other: { sessionId: 's2', wake: false, boundAt: 'x' }, meta: { keep: true } }))
    await unbindChat(root, 'main')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ other: { sessionId: 's2', wake: false, boundAt: 'x' }, meta: { keep: true } })
  })
})

it('returns 503 for plan-split without sessions and creates no child plan', async () => {
  const root = await repo()
  const idle: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => idle, native: { confirm: async () => true, notify: async () => {} } as Native, env: {}, home: root, now })
  const route = routes.find((r) => r.path === `${API_PREFIX}/plan-split`)!
  const req = Readable.from([Buffer.from(JSON.stringify({ repo: root, from: 'main', id: 'child', goal: 'Потомок', tasks: ['missing'] }))]) as unknown as EventEmitter & { method: string; headers: Record<string, string>; url: string }
  Object.assign(req, { method: 'POST', url: `${API_PREFIX}/plan-split`, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
  const res = { body: '', status: 0, writeHead(status: number) { this.status = status }, end(body?: string) { this.body += body ?? '' } }
  await route.handler(req as never, res as never)
  expect(res.status).toBe(503)
  expect(await readChats(root)).toEqual({})
  const { loadPlan } = await import('@crewboard/core')
  await expect(loadPlan(root, 'child')).rejects.toThrow()
})
