import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Live } from './live.js'
import { MCP_IDLE_MS } from './model/thresholds.js'
import type { RunSteps } from './workers/steps.js'

export type Api = {
  /** One MCP server for the transport session with this id, so its inbox session and requests share the id. */
  mcp: (session: string) => McpServer
  /** An MCP request by this session: its taken inbox batch keeps hiding events for the hold window from now. */
  activity?: (session: string) => void
  wait: (project: string, timeoutMs: number) => Promise<number>
  goals: (project: string) => Promise<unknown>
  goal: (project: string, goalId: string) => Promise<unknown>
  projects: () => Promise<unknown>
  agents: () => Promise<unknown>
  agentsConfig: () => Promise<unknown>
  saveAgentsConfig: (body: Record<string, unknown>) => Promise<unknown>
  models: (agent: string, refresh: boolean) => Promise<unknown>
  doctor: () => Promise<unknown>
  usage: () => Promise<unknown>
  events: (project: string, goalId: string, assignmentId: string) => Promise<unknown>
  history: (project: string, goalId: string) => Promise<unknown>
  analytics: (project: string, goalId: string) => Promise<unknown>
  steps: (project: string, runId: string, since: number) => Promise<RunSteps | undefined>
  answer: (body: Record<string, unknown>) => Promise<void>
  request: (body: Record<string, unknown>) => Promise<{ requestId: string }>
  withdrawRequest: (body: Record<string, unknown>) => Promise<void>
  emergencyStop: (body: Record<string, unknown>) => Promise<void>
  /** Maps a thrown error to an HTTP status: 409 for a moved-on state, 400 otherwise. */
  statusOf: (error: unknown) => number
  live: Live
  /** Where the built screen lives (dist/ui); absent when running from sources. */
  uiDir?: string
}

const ASSETS: Record<string, string> = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' }
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' }

const PING_MS = 25_000

/**
 * A page on another site can POST text/plain without a preflight: screen writes accept only declared JSON from this
 * origin. Returns the refusal already sent, or undefined when the request may go on.
 */
/**
 * The server answers only to its own loopback names. A page whose DNS name is re-pointed at 127.0.0.1 (DNS rebinding)
 * would otherwise be same-origin with us and could read goals, post requests and drive the lead's MCP tools.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
function refuseForeignHost(req: IncomingMessage, res: ServerResponse): true | undefined {
  const host = String(req.headers.host ?? '')
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  if (LOOPBACK.has(name ?? '')) return undefined
  json(res, 403, { error: 'unknown host name refused' })
  return true
}

function refuseForeignPost(req: IncomingMessage, res: ServerResponse): true | undefined {
  const origin = req.headers.origin
  if (origin && origin !== `http://${req.headers.host}`) {
    json(res, 403, { error: 'cross-origin request refused' })
    return true
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'content-type must be application/json' })
    return true
  }
  return undefined
}

const MAX_WAIT_MS = 600_000

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as unknown) : undefined
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
}

/** One local HTTP server: MCP for the lead at /mcp, the JSON API and the lead's long-poll wait under /api. */
export function createHttpServer(api: Api, opts: { now?: () => number; mcpIdleMs?: number } = {}) {
  const now = opts.now ?? Date.now
  const idleMs = opts.mcpIdleMs ?? MCP_IDLE_MS
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const lastSeen = new Map<string, number>()
  /** Closes MCP sessions idle longer than the limit: each lead restart leaves one, and its client re-initialises on 404. */
  const sweep = async () => {
    const cutoff = now() - idleMs
    for (const [id, transport] of sessions) {
      if ((lastSeen.get(id) ?? 0) > cutoff) continue
      sessions.delete(id)
      lastSeen.delete(id)
      await transport.close().catch(() => undefined)
    }
  }
  const streams = new Set<ServerResponse>()

  /** Server-sent events: `hello` on connect, `change` per journal append, a comment as keep-alive. */
  const live = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write('event: hello\ndata: {}\n\n')
    streams.add(res)
    const unsubscribe = api.live.subscribe((c) => res.write(`event: change\ndata: ${JSON.stringify(c)}\n\n`))
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
    req.on('close', () => {
      clearInterval(ping)
      unsubscribe()
      streams.delete(res)
    })
  }

  const mcp = async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    const body = req.method === 'POST' ? await readBody(req) : undefined
    if (existing && typeof sessionId === 'string') {
      lastSeen.set(sessionId, now())
      api.activity?.(sessionId)
      return existing.handleRequest(req, res, body)
    }
    // A session this process does not know (the server restarted): 404 tells an MCP client to initialise again.
    if (typeof sessionId === 'string') return json(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })
    if (req.method !== 'POST' || !isInitializeRequest(body)) return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session' }, id: null })
    // The id is made here, not inside the transport, so the MCP server's inbox session is this transport session.
    const id = randomUUID()
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: (initialized) => {
        sessions.set(initialized, transport)
        lastSeen.set(initialized, now())
        api.activity?.(initialized)
      },
    })
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId)
        lastSeen.delete(transport.sessionId)
      }
    }
    await api.mcp(id).connect(transport)
    return transport.handleRequest(req, res, body)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (refuseForeignHost(req, res)) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const project = url.searchParams.get('project') ?? ''
    if (url.pathname === '/mcp') return mcp(req, res)
    if (url.pathname === '/api/live') return live(req, res)
    if (url.pathname === '/api/health') return json(res, 200, { ok: true })
    if (url.pathname === '/api/lead/wait') {
      const timeoutMs = Math.min(Number(url.searchParams.get('timeoutMs')) || MAX_WAIT_MS, MAX_WAIT_MS)
      const pending = await api.wait(project, timeoutMs)
      if (pending > 0) return json(res, 200, { pending })
      return res.writeHead(204).end()
    }
    if (url.pathname === '/api/projects') return json(res, 200, await api.projects())
    if (req.method === 'GET' && url.pathname === '/api/models') return json(res, 200, await api.models(url.searchParams.get('agent') ?? '', url.searchParams.get('refresh') === '1'))
    if (url.pathname === '/api/agents-config') {
      if (req.method === 'GET') return json(res, 200, await api.agentsConfig())
      if (req.method === 'PUT') {
        if (refuseForeignPost(req, res)) return
        return json(res, 200, await api.saveAgentsConfig(((await readBody(req)) ?? {}) as Record<string, unknown>))
      }
      return json(res, 405, { error: 'method not allowed' })
    }
    if (url.pathname === '/api/agents') return json(res, 200, await api.agents())
    if (url.pathname === '/api/doctor') return json(res, 200, await api.doctor())
    if (url.pathname === '/api/usage') return json(res, 200, await api.usage())
    if (req.method === 'POST' && (url.pathname === '/api/answer' || url.pathname === '/api/request' || url.pathname === '/api/request/withdraw' || url.pathname === '/api/emergency-stop')) {
      if (refuseForeignPost(req, res)) return
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>
      if (url.pathname === '/api/request') return json(res, 200, await api.request(body))
      if (url.pathname === '/api/request/withdraw') {
        await api.withdrawRequest(body)
        return res.writeHead(204).end()
      }
      await (url.pathname === '/api/answer' ? api.answer(body) : api.emergencyStop(body))
      return res.writeHead(204).end()
    }
    if (url.pathname === '/api/goals') return json(res, 200, await api.goals(project))
    const runSteps = /^\/api\/runs\/([^/]+)\/steps$/.exec(url.pathname)
    if (req.method === 'GET' && runSteps?.[1]) {
      let runId: string
      try {
        runId = decodeURIComponent(runSteps[1])
      } catch {
        return json(res, 404, { error: 'run not found' })
      }
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) return json(res, 404, { error: 'run not found' })
      const since = Number(url.searchParams.get('since') ?? 0)
      if (!Number.isSafeInteger(since) || since < 0) return json(res, 400, { error: 'since must be a non-negative integer' })
      const result = await api.steps(project, runId, since)
      return result ? json(res, 200, result) : json(res, 404, { error: 'run not found' })
    }
    const goalAnalytics = /^\/api\/goals\/([^/]+)\/analytics$/.exec(url.pathname)
    if (goalAnalytics?.[1]) return json(res, 200, await api.analytics(project, decodeURIComponent(goalAnalytics[1])))
    const goalHistory = /^\/api\/goals\/([^/]+)\/history$/.exec(url.pathname)
    if (goalHistory?.[1]) return json(res, 200, await api.history(project, decodeURIComponent(goalHistory[1])))
    const goalEvents = /^\/api\/goals\/([^/]+)\/events$/.exec(url.pathname)
    if (goalEvents?.[1]) return json(res, 200, await api.events(project, decodeURIComponent(goalEvents[1]), url.searchParams.get('assignmentId') ?? ''))
    const goal = /^\/api\/goals\/([^/]+)$/.exec(url.pathname)
    if (goal?.[1]) return json(res, 200, await api.goal(project, decodeURIComponent(goal[1])))
    const asset = ASSETS[url.pathname]
    if (asset && req.method === 'GET') {
      const body = api.uiDir ? await readFile(join(api.uiDir, asset)).catch(() => undefined) : undefined
      if (!body) return res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('The screen is not built: run pnpm build')
      return res.writeHead(200, { 'content-type': TYPES[asset.split('.').pop() ?? ''] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body)
    }
    return json(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, api.statusOf(error), { error: error instanceof Error ? error.message : String(error) })
      else res.end()
    })
  })
  return {
    sweep,
    sessionCount: () => sessions.size,
    listen(port: number): Promise<{ url: string; close(): Promise<void> }> {
      return new Promise((resolve, reject) => {
        // A busy port (EADDRINUSE) and the like reject the start instead of crashing the process.
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          const address = server.address()
          const actual = typeof address === 'object' && address ? address.port : port
          resolve({
            url: `http://127.0.0.1:${actual}`,
            close: async () => {
              await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)))
              for (const res of streams) res.end()
              server.closeAllConnections()
              await new Promise<void>((done) => server.close(() => done()))
            },
          })
        })
      })
    },
  }
}
