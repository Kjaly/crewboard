/**
 * A human-readable report taken from the worker's own final answer (plan 2j). `orchestrator` (rt1): the
 * report of a root task or a decision the orchestrator stored with `verify --done` — `runId` is empty.
 */
export type RunReport = { runId: string; text: string; source: 'section' | 'final' | 'orchestrator'; truncated: boolean }

/** The report is capped at 1500 characters; a longer one is cut at a line boundary and marked with «…». */
export const REPORT_LIMIT = 1500

const HEADING = /^(#{1,6})\s*(.+?)\s*#*\s*$/
const REPORT_TITLES = /^(отчёт|отчет|итог|report)\s*:?$/i

// Events that end the current answer block: normalize() turns them into a non-message feed entry, and a new turn
// (bg1: the «waiting» answer of one turn and the report of the turn a background notification woke are two answers).
// Everything else (lifecycle noise, unknown types) is transparent, exactly as normalize() skips it.
const BREAK_TYPES = new Set(['tool_started', 'tool_completed', 'error', 'failed', 'run_failed', 'steer', 'permission_denied', 'final', 'turn_started'])

const asText = (data: unknown) => (typeof data === 'string' ? data : JSON.stringify(data ?? ''))
const isEvent = (v: unknown): v is { type?: unknown; data?: unknown } => !!v && typeof v === 'object'

/**
 * The last assistant message in the raw events of a run — the full text, not the 200-character feed clip.
 * Deltas of one answer are glued back together; a tool call or a `final` event starts a new answer.
 */
export function finalMessage(raw: unknown[]): string | undefined {
  const events = raw.filter(isEvent)
  let last = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type
    if (type === 'final' || type === 'answer_delta') {
      last = i
      break
    }
  }
  if (last < 0) return undefined
  if (events[last]?.type === 'final') {
    const text = asText(events[last]?.data)
    return text.trim() ? text : undefined
  }
  const parts: string[] = []
  for (let i = last; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type === 'answer_delta') {
      parts.unshift(asText(ev.data))
      continue
    }
    if (BREAK_TYPES.has(String(ev?.type))) break
  }
  const text = parts.join('')
  return text.trim() ? text : undefined
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (limit <= 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= limit) return { text, truncated: false }
  const cut = text.slice(0, limit)
  const nl = cut.lastIndexOf('\n')
  const base = nl >= 0 ? cut.slice(0, nl) : cut.slice(0, limit - 1)
  return { text: `${base.trimEnd()}…`, truncated: true }
}

/**
 * Extracts the «Отчёт» / «Итог» / «Report» section from a final answer, up to the next heading of the
 * same or a higher level. Without such a heading the whole answer is the report (`source: 'final'`).
 */
export function extractReport(runId: string, finalText: string, limit = REPORT_LIMIT): RunReport {
  const lines = finalText.split('\n')
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec((lines[i] ?? '').trim())
    if (m && REPORT_TITLES.test(m[2] ?? '')) {
      start = i
      level = (m[1] ?? '').length
      break
    }
  }
  if (start >= 0) {
    const body: string[] = []
    for (let i = start + 1; i < lines.length; i++) {
      const m = HEADING.exec((lines[i] ?? '').trim())
      if (m && (m[1] ?? '').length <= level) break
      body.push(lines[i] ?? '')
    }
    const t = truncate(body.join('\n').trim(), limit)
    return { runId, text: t.text, source: 'section', truncated: t.truncated }
  }
  const t = truncate(finalText.trim(), limit)
  return { runId, text: t.text, source: 'final', truncated: t.truncated }
}
