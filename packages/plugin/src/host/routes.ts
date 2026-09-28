import type { IncomingMessage, ServerResponse } from 'node:http'
import { PlanIdError } from '@crewboard/core'
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
      // The full snapshot of one explicitly named plan, read-only: it never moves the CLI/agent `current` pointer
      // and never reconciles. Omitted `plan` falls back to the served current plan (legacy behavior). Query routes
      // register as prefixes and are matched exactly on the pathname.
      kind: 'prefix',
      path: `${API_PREFIX}/plan-state`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== `${API_PREFIX}/plan-state`) {
          json(res, 404, { ok: false, error: 'not_found' })
          return
        }
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const repo = url.searchParams.get('repo') ?? ''
        // `plan` omitted is legacy current-plan; a present but empty/whitespace plan fails closed.
        const hasPlan = url.searchParams.has('plan')
        const rawPlan = url.searchParams.get('plan')
        if (hasPlan && (!rawPlan || !rawPlan.trim())) {
          json(res, 400, { ok: false, error: 'bad_plan', message: 'plan must be a non-empty plan id' })
          return
        }
        if (!repo || !service.repositories().some((r) => r.root === repo)) {
          json(res, 400, { ok: false, error: 'unknown_repo', message: 'repo is not a dsh workspace or a configured repo' })
          return
        }
        try {
          json(res, 200, { ok: true, value: await service.planState(repo, hasPlan ? (rawPlan as string).trim() : undefined) })
        } catch (err) {
          if (err instanceof PlanIdError) json(res, 400, { ok: false, error: 'bad_plan', message: err.message })
          else json(res, 500, { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) })
        }
      },
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
        // The screen takes the quick first paint too (pf1); the full snapshot follows on the same stream.
        const off = service.subscribe((s) => send('snapshot', s), { partial: true })
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
