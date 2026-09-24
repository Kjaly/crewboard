import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_PREFIX } from '../shared/types.js'
import type { Route, RouteHandler } from './dsh.js'
import type { NotificationPresence } from './presence.js'
import type { OrchestraService } from './service.js'

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Same guard as every other POST: the custom header forces the CORS preflight this server never answers. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return {}
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size > 16 * 1024) return {}
    chunks.push(buf)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const onlyGet =
  (h: RouteHandler): RouteHandler =>
  (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }
    h(req, res)
  }

export function orchestraRoutes(service: OrchestraService, opts: { pingMs?: number; presence?: NotificationPresence } = {}): Route[] {
  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler: onlyGet((_req, res) => json(res, 200, { ok: true, value: service.snapshot() })),
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/notify-presence`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        if (req.headers['x-orchestra-client'] !== '1') {
          json(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const body = await readBody(req)
        const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
        if (!clientId) {
          json(res, 400, { ok: false, error: 'bad_request' })
          return
        }
        if (body.enabled === false) opts.presence?.clear(clientId)
        else opts.presence?.report(clientId)
        json(res, 200, { ok: true, value: null })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/events`,
      handler: onlyGet((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        res.write('retry: 2000\n\n')
        send('snapshot', service.snapshot())
        const off = service.subscribe((s) => send('snapshot', s))
        const ping = setInterval(() => res.write(': ping\n\n'), opts.pingMs ?? 20_000)
        const close = () => {
          clearInterval(ping)
          off()
        }
        req.on('close', close)
        res.on('error', close)
      }),
    },
  ]
}
