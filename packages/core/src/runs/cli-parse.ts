// Translate Claude Code / Codex JSON streams into orch raw events (the same vocabulary the dsh runner
// emits), so normalize(), supervision rules and buildTrajectory() work unchanged.

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite?: number; cacheWritePartial?: boolean; reasoning: number }

export type Parsed = {
  events: Array<[string, unknown]>
  sessionId?: string
  /** Claude `--replay-user-messages`: the text of a stdin user message the session has just taken. */
  replay?: string
  turnEnd?: { stopReason: string; failed?: boolean; error?: string; usdTotal?: number; usage: TurnUsage }
  /** Claude `background_tasks_changed`: every background task (shell, monitor, subagent) the session still runs. */
  background?: BackgroundTask[]
  /** Claude `task_notification`: a background task ended; the CLI wakes an open session with it as a new turn. */
  backgroundDone?: { id: string; status: string; summary: string }
  /** Claude `rate_limit_event` with `status: rejected`: the account hit its limit; `resetsAt` is ISO when known. */
  rateLimited?: RateLimited
}

export type RateLimited = { resetsAt?: string; type?: string }

export type BackgroundTask = { id: string; type: string; description: string }

type Json = Record<string, unknown>
const ZERO: TurnUsage = { input: 0, output: 0, cacheRead: 0, reasoning: 0 }

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
  } else if (o.type === 'system' && o.subtype === 'background_tasks_changed' && Array.isArray(o.tasks)) {
    out.background = o.tasks.map(obj).map((t) => ({ id: String(t.task_id ?? ''), type: String(t.task_type ?? 'task'), description: String(t.description ?? '') }))
  } else if (o.type === 'system' && o.subtype === 'task_started' && o.is_backgrounded === true) {
    out.events.push(['background_started', { id: String(o.task_id ?? ''), type: String(o.task_type ?? 'task'), description: String(o.description ?? '') }])
  } else if (o.type === 'system' && o.subtype === 'task_notification') {
    out.backgroundDone = { id: String(o.task_id ?? ''), status: String(o.status ?? 'unknown'), summary: String(o.summary ?? '') }
    out.events.push(['background_finished', out.backgroundDone])
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
    const info = obj(o.rate_limit_info)
    out.events.push(['rate_limit', info])
    if (info.status === 'rejected') {
      // `resetsAt` is Unix seconds (Claude Code 2.1, 2026-09).
      const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? new Date(info.resetsAt * 1000).toISOString() : undefined
      out.rateLimited = { ...(resetsAt ? { resetsAt } : {}), ...(typeof info.rateLimitType === 'string' ? { type: info.rateLimitType } : {}) }
      out.events.push(['rate_limited', out.rateLimited])
    }
  } else if (o.type === 'result') {
    const u = obj(o.usage)
    // A failed turn is read from `is_error`, not from `subtype` or the exit code: a run that hit the usage limit ends
    // with `subtype: success`, `is_error: true`, the reason in `result` and exit code 0.
    const failed = o.is_error === true
    const error = !failed ? undefined : typeof o.result === 'string' && o.result.trim() ? o.result.trim() : Array.isArray(o.errors) && o.errors.length ? o.errors.map(String).join('; ') : String(o.subtype ?? 'error')
    out.turnEnd = {
      stopReason: String(o.subtype ?? 'success'),
      failed,
      ...(error ? { error } : {}),
      ...(typeof o.total_cost_usd === 'number' ? { usdTotal: o.total_cost_usd } : {}),
      usage: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), ...(typeof u.cache_creation_input_tokens === 'number' ? { cacheWrite: num(u.cache_creation_input_tokens) } : {}), reasoning: 0 },
    }
  }
  return out
}

/** OpenCode `run --format json` sums a turn's tokens/cost across one or more `step_finish` lines (rb1). */
export type OpencodeTurnState = { usage: TurnUsage; costUsd: number; cacheWriteSteps: number; cacheWriteStepsObserved: number }
export const opencodeTurnState = (): OpencodeTurnState => ({ usage: { ...ZERO }, costUsd: 0, cacheWriteSteps: 0, cacheWriteStepsObserved: 0 })

/** `opencode run --format json`: one process per turn (like Codex), `sessionID` on every line, no incremental text deltas. */
export function parseOpencodeLine(line: string, turn: OpencodeTurnState): Parsed {
  const o = parse(line)
  const out: Parsed = { events: [] }
  if (!o) return out
  if (typeof o.sessionID === 'string') out.sessionId = o.sessionID
  const part = obj(o.part)
  if (o.type === 'tool_use' && part.type === 'tool') {
    const tool = String(part.tool ?? 'tool').toLowerCase()
    const callId = String(part.callID ?? '')
    const state = obj(part.state)
    const input = obj(state.input)
    // `opencode run` is synchronous: a tool call already has its final state by the time it reaches stdout.
    out.events.push(['tool_started', { tool, status: 'running', input, callId }])
    out.events.push(['tool_completed', { tool, status: state.status === 'error' ? 'error' : 'completed', callId, output: state.output }])
  } else if (o.type === 'text' && typeof part.text === 'string' && part.text) {
    out.events.push(['answer_delta', part.text])
  } else if (o.type === 'step_finish') {
    const tokens = obj(part.tokens)
    const cache = obj(tokens.cache)
    turn.usage.input += num(tokens.input)
    turn.usage.output += num(tokens.output)
    turn.usage.cacheRead += num(cache.read)
    turn.cacheWriteSteps += 1
    if (typeof cache.write === 'number') {
      turn.cacheWriteStepsObserved += 1
      turn.usage.cacheWrite = (turn.usage.cacheWrite ?? 0) + num(cache.write)
    }
    turn.usage.reasoning += num(tokens.reasoning)
    turn.costUsd += num(part.cost)
    // `reason: 'tool-calls'` is a mid-turn step boundary (more steps follow); anything else ends the turn.
    if (part.reason !== 'tool-calls') {
      out.turnEnd = { stopReason: String(part.reason ?? 'stop'), usage: { ...turn.usage, ...(turn.cacheWriteStepsObserved > 0 && turn.cacheWriteStepsObserved < turn.cacheWriteSteps ? { cacheWritePartial: true } : {}) }, usdTotal: turn.costUsd }
      turn.usage = { ...ZERO }
      turn.costUsd = 0
      turn.cacheWriteSteps = 0
      turn.cacheWriteStepsObserved = 0
    }
  } else if (o.type === 'error') {
    const data = obj(obj(o.error).data)
    const message = typeof data.message === 'string' && data.message ? data.message : typeof obj(o.error).name === 'string' ? String(obj(o.error).name) : 'opencode error'
    out.events.push(['warning', message])
    out.turnEnd = { stopReason: 'error', failed: true, error: message, usage: { ...turn.usage, ...(turn.cacheWriteStepsObserved > 0 && turn.cacheWriteStepsObserved < turn.cacheWriteSteps ? { cacheWritePartial: true } : {}) }, usdTotal: turn.costUsd }
    turn.usage = { ...ZERO }
    turn.costUsd = 0
    turn.cacheWriteSteps = 0
    turn.cacheWriteStepsObserved = 0
  }
  return out
}

/** Cursor Agent `--print --output-format stream-json`: the same envelope shape as Claude Code's `stream-json`. */
export function parseCursorLine(line: string, tools: Map<string, string>): Parsed {
  const o = parse(line)
  const out: Parsed = { events: [] }
  if (!o) return out
  if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') {
    out.sessionId = o.session_id
  } else if (o.type === 'assistant') {
    for (const c of content(o)) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text) out.events.push(['answer_delta', c.text])
    }
  } else if (o.type === 'tool_call') {
    const call = obj(o.tool_call)
    const toolKey = Object.keys(call).find((k) => k.toLowerCase().endsWith('toolcall'))
    const toolBody = toolKey ? obj(call[toolKey]) : call
    const tool = (toolKey ?? 'tool').replace(/ToolCall$/i, '').toLowerCase()
    const callId = String(o.call_id ?? '')
    if (o.subtype === 'started') {
      tools.set(callId, tool)
      out.events.push(['tool_started', { tool, status: 'running', input: obj(toolBody.args ?? toolBody.input), callId }])
    } else if (o.subtype === 'completed') {
      out.events.push(['tool_completed', { tool: tools.get(callId) ?? tool, status: toolBody.success === false ? 'error' : 'completed', callId, output: toolBody.result ?? toolBody.output }])
    }
  } else if (o.type === 'result') {
    if (typeof o.session_id === 'string') out.sessionId = o.session_id
    const failed = o.is_error === true
    const error = failed ? (typeof o.result === 'string' && o.result.trim() ? o.result.trim() : String(o.subtype ?? 'error')) : undefined
    out.turnEnd = {
      stopReason: String(o.subtype ?? 'success'),
      failed,
      ...(error ? { error } : {}),
      usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
    }
  }
  return out
}

/** Gemini CLI has no streaming/JSONL mode: one `--output-format json` object for the whole turn, read after exit. */
export function parseGeminiOutput(text: string): Parsed {
  const out: Parsed = { events: [] }
  let o: Json | undefined
  try {
    o = JSON.parse(text) as Json
  } catch {
    return out
  }
  if (!o || typeof o !== 'object') return out
  const err = obj(o.error)
  if (typeof err.message === 'string' && err.message) {
    out.events.push(['warning', err.message])
    out.turnEnd = { stopReason: 'error', failed: true, error: err.message, usage: { ...ZERO } }
    return out
  }
  const response = typeof o.response === 'string' ? o.response : ''
  if (response) out.events.push(['answer_delta', response])
  const stats = obj(o.stats)
  const models = obj(stats.models)
  const usage = { ...ZERO }
  for (const key of Object.keys(models)) {
    const t = obj(obj(models[key]).tokens)
    usage.input += num(t.prompt ?? t.promptTokenCount)
    usage.output += num(t.candidates ?? t.candidatesTokenCount)
    usage.cacheRead += num(t.cached ?? t.cachedContentTokenCount)
    usage.reasoning += num(t.thoughts ?? t.thoughtsTokenCount)
  }
  out.turnEnd = { stopReason: 'success', usage }
  return out
}

/**
 * Grok `end.stopReason`, normalized like the porch adapter (`normalize_stream.py`): lowercase, `-` → `_`. Success is
 * `end_turn`/`endturn` (or empty); `error`, `rate_limit`, `cancelled` fail; `max_tokens` is an incomplete answer —
 * a failure the run must see, not a success; anything else is unknown and also fails closed.
 */
const GROK_FAIL_STOP = new Set(['error', 'rate_limit', 'ratelimit', 'cancelled', 'canceled', 'refusal'])
const GROK_INCOMPLETE_STOP = new Set(['max_tokens', 'maxtokens'])
const GROK_SUCCESS_STOP = new Set(['end_turn', 'endturn', ''])
const grokStop = (v: unknown): string => String(v ?? '').trim().replace('-', '_').toLowerCase()

/** Grok CLI `--output-format streaming-json`: newline-delimited `{type, ...}` events, `end` carries `stopReason`/sessionId. */
export function parseGrokLine(line: string): Parsed {
  const o = parse(line)
  const out: Parsed = { events: [] }
  if (!o) return out
  if (typeof o.sessionId === 'string') out.sessionId = o.sessionId
  const toolName = () => String(o.toolName ?? o.tool ?? o.name ?? o.kind ?? 'tool').toLowerCase()
  const callId = () => String(o.callId ?? o.id ?? '')
  if (o.type === 'text' && typeof o.data === 'string' && o.data) {
    out.events.push(['answer_delta', o.data])
  } else if (o.type === 'thought' && typeof o.data === 'string' && o.data) {
    out.events.push(['thinking_delta', o.data])
  } else if (o.type === 'tool_call' || o.type === 'tool_start' || o.type === 'tool_use') {
    out.events.push(['tool_started', { tool: toolName(), status: 'running', input: obj(o.input ?? o.args), callId: callId() }])
  } else if (o.type === 'tool_call_update') {
    const status = String(o.status ?? 'in_progress')
    if (['completed', 'complete', 'done', 'failed', 'error'].includes(status)) {
      out.events.push(['tool_completed', { tool: toolName(), status: status === 'failed' || status === 'error' || Boolean(o.error) ? 'error' : 'completed', callId: callId(), output: o.output ?? o.result }])
    } else {
      out.events.push(['progress', status])
    }
  } else if (o.type === 'tool_end' || o.type === 'tool_result') {
    out.events.push(['tool_completed', { tool: toolName(), status: o.error ? 'error' : 'completed', callId: callId(), output: o.output ?? o.result }])
  } else if (o.type === 'error') {
    const message = String(o.message ?? o.error ?? 'grok error')
    out.events.push(['warning', message])
    out.turnEnd = { stopReason: 'error', failed: true, error: message, usage: { ...ZERO } }
  } else if (o.type === 'end') {
    const stop = grokStop(o.stopReason)
    const fail = GROK_FAIL_STOP.has(stop) || GROK_INCOMPLETE_STOP.has(stop)
    const unknown = !GROK_SUCCESS_STOP.has(stop) && !fail
    const failed = fail || unknown
    const u = obj(o.usage)
    out.turnEnd = {
      stopReason: String(o.stopReason ?? 'end'),
      ...(failed ? { failed, error: String(o.error ?? (unknown ? `grok stopped: unknown_stop:${stop || 'missing'}` : `grok stopped: ${o.stopReason ?? stop}`)) } : {}),
      ...(typeof o.cost === 'number' ? { usdTotal: o.cost } : {}),
      usage: { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), ...(typeof u.cacheWrite === 'number' ? { cacheWrite: num(u.cacheWrite) } : {}), reasoning: num(u.reasoning) },
    }
  } else if (o.type === 'available_commands' || o.type === 'usage') {
    out.events.push(['progress', String(o.type)])
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
      usage: { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cacheRead: cached, ...(typeof u.cache_write_input_tokens === 'number' ? { cacheWrite: num(u.cache_write_input_tokens) } : {}), reasoning: num(u.reasoning_output_tokens) },
    }
  } else if (o.type === 'turn.failed') {
    out.turnEnd = { stopReason: 'failed', failed: true, error: String(obj(o.error).message ?? 'turn failed'), usage: { ...ZERO } }
  } else if (o.type === 'error') {
    out.events.push(['warning', String(o.message ?? '')])
  }
  return out
}
