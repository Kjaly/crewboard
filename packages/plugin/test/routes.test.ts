import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Backends, initPlan } from '@crewboard/core'
import { createNotificationPresence } from '../src/host/presence.js'
import { orchestraRoutes } from '../src/host/routes.js'
import { OrchestraService } from '../src/host/service.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const idle: Backends = { forAgent: async () => Promise.reject(new Error('none')) }

function fakeRes() {
  const res = new EventEmitter() as EventEmitter & { status?: number; headers?: Record<string, string>; body: string; ended: boolean }
  res.body = ''
  res.ended = false
  Object.assign(res, {
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status
      res.headers = headers
      return res
    },
    write(chunk: string) {
      res.body += chunk
      return true
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk
      res.ended = true
    },
  })
  return res
}
const fakeReq = (method: string) => Object.assign(new EventEmitter(), { method }) as unknown as IncomingMessage

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'orch-rt-'))
  await initPlan(root, 'goal', NOW)
  const svc = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW })
  await svc.refresh()
  const routes = orchestraRoutes(svc, { pingMs: 60_000 })
  const route = (path: string) => {
    const r = routes.find((x) => x.path === path)
    if (!r) throw new Error(`no route ${path}`)
    return r
  }
  return { svc, route }
}

describe('orchestra routes', () => {
  it('serves the snapshot as JSON and rejects non-GET', async () => {
    const { route } = await setup()
    const res = fakeRes()
    route('/crewboard/api/state').handler(fakeReq('GET'), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, value: { repos: [{ goal: 'goal' }] } })
    const post = fakeRes()
    route('/crewboard/api/state').handler(fakeReq('POST'), post as unknown as ServerResponse)
    expect(post.status).toBe(405)
  })

  it('streams snapshots over SSE until the client disconnects', async () => {
    const { svc, route } = await setup()
    const req = fakeReq('GET')
    const res = fakeRes()
    route('/crewboard/api/events').handler(req, res as unknown as ServerResponse)
    expect(res.headers?.['content-type']).toContain('text/event-stream')
    expect(res.body.match(/event: snapshot/g)).toHaveLength(1)
    await svc.refresh()
    expect(res.body.match(/event: snapshot/g)).toHaveLength(2)
    req.emit('close')
    await svc.refresh()
    expect(res.body.match(/event: snapshot/g)).toHaveLength(2)
  })

  it('records and retires a browser-notification heartbeat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-rt-'))
    await initPlan(root, 'goal', NOW)
    const svc = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW })
    const presence = createNotificationPresence(30_000)
    const route = orchestraRoutes(svc, { presence }).find((x) => x.path === '/crewboard/api/notify-presence')
    if (!route) throw new Error('no notify-presence route')
    const post = (body: unknown) => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orchestra-client': '1' },
      }) as unknown as IncomingMessage
      const res = fakeRes()
      return Promise.resolve(route.handler(req, res as unknown as ServerResponse)).then(() => res)
    }
    const on = await post({ clientId: 'tab-1', enabled: true })
    expect(on.status).toBe(200)
    expect(presence.active()).toBe(true)
    const off = await post({ clientId: 'tab-1', enabled: false })
    expect(off.status).toBe(200)
    expect(presence.active()).toBe(false)
    // The client guard mirrors every other POST: without the header the request is refused.
    const forbidden = fakeRes()
    const bare = Object.assign(Readable.from([Buffer.from('{}')]), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }) as unknown as IncomingMessage
    await route.handler(bare, forbidden as unknown as ServerResponse)
    expect(forbidden.status).toBe(403)
  })
})
