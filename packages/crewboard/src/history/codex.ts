import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { TranscriptItem } from './transcript.js'

// Blocks Codex itself puts into a user turn (`<environment_context>`, `<user_instructions>`, …): not the owner's words.
// Blocks Codex itself puts into the user's turn (seen in Codex CLI 0.160–0.166 rollouts); the owner's own tags stay.
const CODEX_BLOCKS = ['environment_context', 'user_instructions', 'user_shell_command', 'turn_aborted', 'external_codex_apps_open_page', 'send_user_message_question_reply']
const INJECTED = new RegExp(`<(${CODEX_BLOCKS.join('|')})>[\\s\\S]*?<\\/\\1>`, 'g')
const clean = (text: string) => text.replace(INJECTED, '').trim()

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const texts = (content: unknown): string =>
  Array.isArray(content) ? content.map((b) => (typeof obj(b).text === 'string' ? (obj(b).text as string) : '')).join('') : ''
const parseArgs = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v) as unknown
  } catch {
    return {}
  }
}


// Codex in code mode calls MCP tools from JavaScript inside its `exec` tool: `tools.mcp__<server>__<tool>({...})`.
const CODE_CALL = /tools\.(mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_]+)\s*\(/g
const STRING_FIELD = /([A-Za-z_]\w*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)/g
/** The argument text of a call whose `(` sits at `open`, by matching brackets outside strings. */
const callArgs = (code: string, open: number): string => {
  let depth = 0
  let quote = ''
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return code.slice(open + 1, i)
  }
  return code.slice(open + 1)
}
/** The common escapes of a single-quoted or template string; anything else is kept as written. */
const unescapeJs = (text: string): string => text.replace(/\\([ntr`'\\])/g, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c)
/** The string fields of a JavaScript object literal (goalId, title, …): enough for the history, no evaluation. */
const stringFields = (text: string): Json => {
  const out: Json = {}
  for (const m of text.matchAll(STRING_FIELD)) {
    const raw = m[2] ?? ''
    try {
      out[m[1] as string] = raw.startsWith('"') ? (JSON.parse(raw) as string) : unescapeJs(raw.slice(1, -1))
    } catch {
      // A string this reader cannot decode is simply left out.
    }
  }
  return out
}
/** The ids crewboard results carry, in printed order, wherever they sit in the code's output (often JSON inside JSON). */
const resultIds = (text: string): { goalId: string[]; assignmentId: string[] } => {
  const ids = { goalId: [] as string[], assignmentId: [] as string[] }
  for (const m of text.matchAll(/\\*"(goalId|assignmentId)\\*"\s*:\s*\\*"([^"\\]+)/g)) {
    const list = ids[m[1] as 'goalId' | 'assignmentId']
    if (!list.includes(m[2] as string)) list.push(m[2] as string)
  }
  return ids
}
/** The id field each crewboard call creates: what its result is matched by when one exec makes several calls. */
const CREATES: Record<string, 'goalId' | 'assignmentId'> = { crewboard_start_goal: 'goalId', crewboard_assign: 'assignmentId' }

/**
 * One Codex session ("rollout") file, read line by line into the same items as a Claude Code transcript. The format is
 * undocumented (checked on Codex CLI 0.160–0.166, 2026-11-02): `session_meta` names the session and its working folder,
 * `response_item` lines carry messages, MCP calls (`function_call` with namespace `mcp__<server>`) and their output.
 * Anything unexpected is skipped, never thrown.
 */
export async function readCodexRollout(file: string): Promise<{ sessionId: string; cwd?: string; items: TranscriptItem[] }> {
  let sessionId = ''
  let cwd: string | undefined
  const items: TranscriptItem[] = []
  // Calls made from one `exec` share its call id: each gets `<id>#<n>`, and the exec's output answers all of them.
  const codeCalls = new Map<string, Array<{ id: string; tool: string }>>()
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    let e: Json
    try {
      e = obj(JSON.parse(line))
    } catch {
      continue
    }
    const ts = typeof e.timestamp === 'string' ? e.timestamp : ''
    const p = obj(e.payload)
    if (e.type === 'session_meta') {
      if (typeof p.id === 'string') sessionId = p.id
      if (typeof p.cwd === 'string') cwd = p.cwd
      continue
    }
    if (e.type !== 'response_item') continue
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = p.role === 'user' ? clean(texts(p.content)) : texts(p.content).trim()
      if (text) items.push({ kind: p.role === 'user' ? 'owner' : 'lead', ts, text, uuid: `${sessionId}:${items.length}` })
    } else if (p.type === 'function_call' && typeof p.name === 'string') {
      const name = typeof p.namespace === 'string' && p.namespace ? `${p.namespace}__${p.name}` : p.name
      items.push({ kind: 'tool', ts, name, toolUseId: String(p.call_id ?? ''), input: parseArgs(p.arguments) })
    } else if (p.type === 'custom_tool_call' && typeof p.input === 'string') {
      const ids: Array<{ id: string; tool: string }> = []
      for (const m of p.input.matchAll(CODE_CALL)) {
        const id = `${String(p.call_id ?? '')}#${ids.length}`
        ids.push({ id, tool: (m[1] as string).split('__').at(-1) ?? '' })
        items.push({ kind: 'tool', ts, name: m[1] as string, toolUseId: id, input: stringFields(callArgs(p.input, (m.index ?? 0) + m[0].length - 1)) })
      }
      if (ids.length) codeCalls.set(String(p.call_id ?? ''), ids)
    } else if (p.type === 'custom_tool_call_output' && codeCalls.has(String(p.call_id ?? ''))) {
      const found = resultIds(typeof p.output === 'string' ? p.output : texts(p.output))
      const calls = codeCalls.get(String(p.call_id ?? '')) ?? []
      for (const call of calls) {
        // One call takes the first ids printed. Several calls take ids by order, and only when the counts match: a
        // wrong id on a card is worse than none.
        const field = CREATES[call.tool]
        const same = field ? calls.filter((c) => CREATES[c.tool] === field) : []
        // A single goal printed is the goal of every call: work assigned with `goalId: g.goalId` right after starting it.
        const goal = found.goalId.length === 1 ? { goalId: found.goalId[0] } : {}
        const ids: Json =
          calls.length === 1
            ? { ...goal, ...(found.assignmentId[0] ? { assignmentId: found.assignmentId[0] } : {}) }
            : { ...goal, ...(field && same.length === found[field].length ? { [field]: found[field][same.indexOf(call)] } : {}) }
        items.push({ kind: 'tool_result', ts, toolUseId: call.id, text: JSON.stringify(ids) })
      }
    } else if (p.type === 'function_call_output') {
      const output = typeof p.output === 'string' ? p.output : texts(p.output)
      items.push({ kind: 'tool_result', ts, toolUseId: String(p.call_id ?? ''), text: output })
    }
  }
  return { sessionId: sessionId || file, ...(cwd ? { cwd } : {}), items }
}

/** The working folder a Codex session started in, from its first line alone: enough to skip other folders' sessions. */
export async function codexSessionCwd(file: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of lines) {
      try {
        const e = obj(JSON.parse(line))
        const cwd = obj(e.payload).cwd
        return e.type === 'session_meta' && typeof cwd === 'string' ? cwd : undefined
      } catch {
        return undefined
      }
    }
  } finally {
    lines.close()
  }
  return undefined
}
