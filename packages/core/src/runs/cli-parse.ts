// Translate Claude Code / Codex JSON streams into orch raw events (the same vocabulary the dsh runner
// emits), so normalize(), supervision rules and buildTrajectory() work unchanged.

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }

export type Parsed = {
  events: Array<[string, unknown]>
  sessionId?: string
  /** Claude `--replay-user-messages`: the text of a stdin user message the session has just taken. */
  replay?: string
  turnEnd?: { stopReason: string; failed?: boolean; error?: string; usdTotal?: number; usage: TurnUsage }
}

type Json = Record<string, unknown>
const ZERO: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }

function parse(line: string): Json | undefined {
  try {
    const v = JSON.parse(line) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
  } catch {
    return undefined
  }
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const content = (o: Json): Json[] => {
  const c = obj(o.message).content
  return Array.isArray(c) ? c.map(obj) : []
}

export function parseClaudeLine(line: string, tools: Map<string, string>): Parsed {
  const o = parse(line)
  const out: Parsed = { events: [] }
  if (!o) return out
  if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') {
    out.sessionId = o.session_id
  } else if (o.type === 'assistant') {
    for (const c of content(o)) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text) out.events.push(['answer_delta', c.text])
      else if (c.type === 'tool_use') {
        const tool = String(c.name ?? 'tool').toLowerCase()
        const callId = String(c.id ?? '')
        tools.set(callId, tool)
        out.events.push(['tool_started', { tool, status: 'running', input: obj(c.input), callId }])
      }
    }
  } else if (o.type === 'user' && o.isReplay === true) {
    const c = obj(o.message).content
    out.replay = typeof c === 'string' ? c : content(o).map((b) => (typeof b.text === 'string' ? b.text : '')).join('')
  } else if (o.type === 'user') {
    for (const c of content(o)) {
      if (c.type !== 'tool_result') continue
      const callId = String(c.tool_use_id ?? '')
      out.events.push(['tool_completed', { tool: tools.get(callId) ?? 'tool', status: c.is_error === true ? 'error' : 'completed', callId, output: c.content }])
    }
  } else if (o.type === 'rate_limit_event') {
    out.events.push(['rate_limit', obj(o.rate_limit_info)])
  } else if (o.type === 'result') {
    const u = obj(o.usage)
    out.turnEnd = {
      stopReason: String(o.subtype ?? 'success'),
      failed: o.is_error === true,
      ...(typeof o.total_cost_usd === 'number' ? { usdTotal: o.total_cost_usd } : {}),
      usage: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), reasoning: 0 },
    }
  }
  return out
}

const SHELL_WRAPPER = /^\S+ -l?c '(.*)'$/s

export function parseCodexLine(line: string): Parsed {
  const o = parse(line)
  const out: Parsed = { events: [] }
  if (!o) return out
  const item = obj(o.item)
  const callId = String(item.id ?? '')
  const done = o.type === 'item.completed'
  if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
    out.sessionId = o.thread_id
  } else if (o.type === 'item.started' || done) {
    if (item.type === 'command_execution') {
      const command = String(item.command ?? '')
      out.events.push(
        done
          ? ['tool_completed', { tool: 'bash', status: item.exit_code === 0 ? 'completed' : 'error', callId, output: item.aggregated_output }]
          : ['tool_started', { tool: 'bash', status: 'running', input: { command: SHELL_WRAPPER.exec(command)?.[1] ?? command }, callId }],
      )
    } else if (item.type === 'file_change') {
      const first = Array.isArray(item.changes) ? obj(item.changes[0]) : {}
      out.events.push(
        done
          ? ['tool_completed', { tool: 'edit', status: item.status === 'failed' ? 'error' : 'completed', callId, output: item.changes }]
          : ['tool_started', { tool: 'edit', status: 'running', input: typeof first.path === 'string' ? { path: first.path } : {}, callId }],
      )
    } else if (item.type === 'agent_message' && done && typeof item.text === 'string') {
      out.events.push(['answer_delta', `${item.text}\n`])
    } else if (item.type === 'error' && done) {
      out.events.push(['warning', String(item.message ?? '')])
    }
  } else if (o.type === 'turn.completed') {
    const u = obj(o.usage)
    const cached = num(u.cached_input_tokens)
    out.turnEnd = {
      stopReason: 'completed',
      usage: { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens), reasoning: num(u.reasoning_output_tokens) },
    }
  } else if (o.type === 'turn.failed') {
    out.turnEnd = { stopReason: 'failed', failed: true, error: String(obj(o.error).message ?? 'turn failed'), usage: { ...ZERO } }
  } else if (o.type === 'error') {
    out.events.push(['warning', String(o.message ?? '')])
  }
  return out
}
