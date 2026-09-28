import { basename } from 'node:path'
import type { RawEvent } from '../runs/raw-event.js'
import type { FailureReason } from './failure.js'

export type NormKind = 'action' | 'file' | 'message' | 'steer' | 'problem' | 'final'
export type { FailureReason } from './failure.js'

/**
 * What a tool call actually does, read from the backend's own tool name — never guessed from a file name.
 * `other` is a known tool whose operation Crewboard does not claim to know.
 */
export type ToolOperation = 'read' | 'write' | 'command' | 'other'
/** The structured meaning of one tool call, present only when the backend sent real tool metadata. */
export type ToolDetail = { name: string; op: ToolOperation; target?: string }
/** Which layer a `problem` belongs to, so a tool error is not read as a run failure. */
export type ProblemOrigin = 'tool' | 'run' | 'permission' | 'limit' | 'interrupt'

/**
 * What Crewboard's own runner wrote into a run's feed, as a code (fo1, B33): the screen and the CLI say it from
 * their dictionaries. `detail` is free text that rides along (the sandbox request a worker made).
 */
export const EVENT_NOTE_CODES = ['stop_requested', 'stop_after_report', 'steer_after_finish', 'sandbox_denied'] as const
export type EventNoteCode = (typeof EVENT_NOTE_CODES)[number]
export type EventNote = { code: EventNoteCode; detail?: string }
/**
 * `reason` — why a run failed, when the runner knows more than a line of text (B01, B19, fo1); `note` — a line
 * Crewboard itself wrote. The screen and the CLI say both in the reader's language; `text` is the English fallback.
 * `open` (st2) — an `action`/`file` event from a tool/command start whose result has not arrived in this feed yet;
 * only set on backends that pair a start with its result by `callId` (Claude, Codex, dsh — B33's CLI backends).
 */
export type NormEvent = {
  ts: string
  kind: NormKind
  /** The 200-character, single-line summary every consumer already reads (the CLI and older screens). */
  text: string
  /** Public answer/message/final text with its line breaks kept, bounded; absent on non-public events. */
  display?: string
  /** The source text was longer than the display bound, so `display` is a truthful prefix. */
  truncated?: true
  /** A merged message keeps its first `ts` as identity; this is the time of its last actual chunk. */
  updatedAt?: string
  /** Structured tool meaning, only when the backend sent tool metadata. */
  tool?: ToolDetail
  /** Problems only: the layer that raised it. */
  origin?: ProblemOrigin
  reason?: FailureReason
  note?: EventNote
  open?: true
}

/**
 * The legacy machine shape of a normalized event: exactly the fields every consumer read before the Activity
 * work, and nothing else. Machine surfaces (`crewboard task show --json`, `orchestra_task`, `orchestra_events`)
 * project through this so a browser's bounded `display` text and tool metadata never ride into every
 * orchestrator call; the browser's own `detail.events` keeps the rich fields.
 */
export type CompactNormEvent = Pick<NormEvent, 'ts' | 'kind' | 'text'> & Pick<NormEvent, 'reason' | 'note' | 'open'>

export function compactNormEvent(event: NormEvent): CompactNormEvent {
  return {
    ts: event.ts,
    kind: event.kind,
    text: event.text,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.note ? { note: event.note } : {}),
    ...(event.open ? { open: event.open } : {}),
  }
}

export const compactNormEvents = (events: readonly NormEvent[]): CompactNormEvent[] => events.map(compactNormEvent)

/** English fallback of a runner note, for readers that do not know the codes (agents reading JSON). */
const NOTE_TEXT: Record<EventNoteCode, string> = {
  stop_requested: 'stop requested',
  stop_after_report: 'stop after the final report: the run finishes as completed',
  steer_after_finish: 'a direction arrived after the run finished and was not delivered',
  sandbox_denied: 'a request to leave the sandbox was refused',
}

/** Runner lines older builds wrote in Russian only: stored feeds still read in the interface language. */
const LEGACY_NOTES: Record<string, EventNoteCode> = {
  'остановка по запросу': 'stop_requested',
  'остановка после финального отчёта: запуск завершается как выполненный': 'stop_after_report',
  'поправка пришла после завершения запуска и не доставлена': 'steer_after_finish',
}

/**
 * A runner note in a raw `steer` or `warning` event: `{ code }` as written now, or one of the Russian lines older
 * builds wrote. Anything else is the worker's (or a person's) own text.
 */
export function eventNoteOf(data: unknown): EventNote | undefined {
  if (typeof data === 'string') {
    const code = LEGACY_NOTES[data.trim()]
    return code ? { code } : undefined
  }
  if (!data || typeof data !== 'object') return undefined
  const d = data as { code?: unknown; detail?: unknown }
  if (!(EVENT_NOTE_CODES as readonly unknown[]).includes(d.code)) return undefined
  return { code: d.code as EventNoteCode, ...(typeof d.detail === 'string' && d.detail ? { detail: d.detail } : {}) }
}

export const eventNoteText = (note: EventNote): string => `${NOTE_TEXT[note.code]}${note.detail ? `: ${note.detail}` : ''}`

// Backend noise observed on 2026-09-22: OpenCode lifecycle `progress` events,
// heartbeats and reasoning streams carry no user-facing progress.
const NOISE_TYPES = new Set(['progress', 'heartbeat', 'thinking_delta', 'thinking', 'session', 'usage', 'end'])
const FILE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch'])
const MAX_TEXT = 200
/** A public explanation keeps its paragraphs up to this per-message bound, measured in UTF-8 bytes. */
const MAX_DISPLAY_BYTES = 8 * 1024
/** The whole feed ships at most this much public display text, so a 2 s poll cannot carry a transcript. */
const MAX_DISPLAY_TOTAL_BYTES = 32 * 1024
const ELLIPSIS = '…'
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8')
/** A dropped display falls back to the 200-character summary; a smaller remainder is not worth shipping. */
const MIN_DISPLAY_BYTES = 200

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8')

/** The longest prefix of `s` that fits `max` UTF-8 bytes, never splitting a code point. */
function sliceBytes(s: string, max: number): string {
  if (utf8(s) <= max) return s
  let bytes = 0
  let end = 0
  for (const character of s) {
    const size = utf8(character)
    if (bytes + size > max) break
    bytes += size
    end += character.length
  }
  return s.slice(0, end)
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)
const asText = (data: unknown) => (typeof data === 'string' ? data : JSON.stringify(data ?? ''))

/**
 * A public explanation read from a result payload. A string is the worker's own words, JSON or not; an
 * object yields only a recognized public answer/text field. An unknown structure has no public text — its
 * legacy clipped summary stays the whole `text`, and a reasoning or usage object is never shown as chat.
 */
export function publicText(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  for (const key of ['answer', 'result', 'text', 'message', 'content', 'finalAnswer', 'final_answer']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/**
 * The operation a backend's tool name actually performs. An unknown tool gets no operation — a file name is
 * never read as proof of a write, so a legacy backend without metadata stays a generic step.
 */
const TOOL_OPERATIONS: Record<string, ToolOperation> = {
  read: 'read',
  write: 'write',
  edit: 'write',
  patch: 'write',
  multiedit: 'write',
  apply_patch: 'write',
  bash: 'command',
  shell: 'command',
  exec: 'command',
  terminal: 'command',
}

function toolPath(input: Record<string, unknown> | undefined): string | undefined {
  const value = input?.filePath ?? input?.file_path ?? input?.path
  return typeof value === 'string' ? value : undefined
}

/** Structured tool meaning from the backend's metadata alone; `undefined` when there is none to trust. */
export function toolDetail(tool: string, input: Record<string, unknown> | undefined): ToolDetail | undefined {
  const op = TOOL_OPERATIONS[tool]
  if (!op) return undefined
  if (op === 'command') {
    const command = typeof input?.command === 'string' ? input.command : undefined
    return { name: tool, op, ...(command ? { target: clip(command) } : {}) }
  }
  const path = toolPath(input)
  return { name: tool, op, ...(path ? { target: clip(path) } : {}) }
}

/** Public text with its paragraphs: line endings normalized, trailing spaces dropped, outer whitespace trimmed. */
const displayText = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()

/** Bound one public explanation, marking a real source truncation instead of pretending it was whole. */
const boundDisplay = (s: string): { display: string; truncated?: true } =>
  utf8(s) <= MAX_DISPLAY_BYTES ? { display: s } : { display: `${sliceBytes(s, MAX_DISPLAY_BYTES - ELLIPSIS_BYTES)}${ELLIPSIS}`, truncated: true }

/**
 * The aggregate bound, spent from the newest event backwards: the panel reads a rolling tail, so the latest
 * intent keeps its full text while ancient messages fall back to the 200-character summary. A message whose
 * display is dropped is marked truncated — the compact line is never presented as the whole public answer.
 */
function boundDisplays(events: NormEvent[]): void {
  let remaining = MAX_DISPLAY_TOTAL_BYTES
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event?.display) continue
    const size = utf8(event.display)
    if (size <= remaining) {
      remaining -= size
      continue
    }
    if (remaining >= MIN_DISPLAY_BYTES) {
      event.display = `${sliceBytes(event.display, remaining - ELLIPSIS_BYTES)}${ELLIPSIS}`
    } else {
      delete event.display
    }
    event.truncated = true
    remaining = 0
  }
}

type ToolData = { tool?: string; status?: string; input?: Record<string, unknown> }

export function describeTool(tool: string, input: Record<string, unknown> | undefined): string {
  const pathValue = input?.filePath ?? input?.file_path ?? input?.path
  const path = typeof pathValue === 'string' ? pathValue : undefined
  if (tool === 'bash' && typeof input?.command === 'string') return input.command.split('\n')[0] ?? ''
  if (tool === 'read' && path) return `Read ${basename(path)}`
  if (path) return basename(path)
  return tool
}

/** OpenCode sends tool payloads as a JSON string; Devin sends plain text. */
export function parseEventData(data: unknown): unknown {
  if (typeof data !== 'string' || !data.trimStart().startsWith('{')) return data
  try {
    return JSON.parse(data) as unknown
  } catch {
    return data
  }
}

function toNorm(raw: RawEvent): NormEvent | null {
  const ev = { ...raw, data: parseEventData(raw.data) }
  const ts = ev.ts
  if (ev.type === 'progress' && ev.data && typeof ev.data === 'object' && 'unknownType' in ev.data) {
    const detail = ev.data as { unknownType: string; detail?: unknown }
    return { ts, kind: 'action', text: clip(`Unknown event ${detail.unknownType}: ${asText(detail.detail)}`) }
  }
  if (NOISE_TYPES.has(ev.type)) return null
  switch (ev.type) {
    case 'tool_started': {
      if (ev.data && typeof ev.data === 'object') {
        const d = ev.data as ToolData
        if (d.status !== 'running') return null
        const tool = d.tool ?? 'tool'
        const structured = toolDetail(tool, d.input)
        return { ts, kind: FILE_TOOLS.has(tool) ? 'file' : 'action', text: clip(describeTool(tool, d.input)), ...(structured ? { tool: structured } : {}) }
      }
      const text = asText(ev.data)
      return { ts, kind: /^(edit|write|create|update)\b/i.test(text) ? 'file' : 'action', text: clip(text) }
    }
    case 'tool_completed': {
      const d = ev.data as ToolData | undefined
      if (d && typeof d === 'object' && d.status === 'error') return { ts, kind: 'problem', text: clip(`${d.tool ?? 'tool'} failed`), origin: 'tool' }
      return null
    }
    case 'result': {
      const public_ = publicText(raw.data)
      return { ts, kind: 'final', text: clip(asText(ev.data)), ...(public_ !== undefined ? { display: public_ } : {}) }
    }
    case 'answer_delta': {
      // The summary keeps the legacy JSON shape for an old consumer; only a recognized public string is chat.
      const public_ = publicText(raw.data)
      return { ts, kind: 'message', text: asText(ev.data), ...(public_ !== undefined ? { display: public_ } : {}) }
    }
    case 'error':
    case 'failed':
    case 'run_failed':
      return { ts, kind: 'problem', text: clip(asText(ev.data)), origin: 'run' }
    case 'steer': {
      const note = eventNoteOf(ev.data)
      return note ? { ts, kind: 'steer', text: eventNoteText(note), note } : { ts, kind: 'steer', text: clip(asText(ev.data)) }
    }
    case 'final': {
      const public_ = publicText(raw.data)
      return { ts, kind: 'final', text: clip(asText(ev.data)), ...(public_ !== undefined ? { display: public_ } : {}) }
    }
    case 'rate_limited': {
      const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as { resetsAt?: unknown }
      const resetsAt = typeof d.resetsAt === 'string' ? d.resetsAt : undefined
      return { ts, kind: 'problem', text: `Usage limit reached${resetsAt ? `, resets at ${resetsAt}` : ''}`, origin: 'limit', reason: { code: 'rate_limited', ...(resetsAt ? { resetsAt } : {}) } }
    }
    case 'run_interrupted': {
      const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as { workerPid?: unknown; workerStopped?: unknown }
      const workerPid = typeof d.workerPid === 'number' ? d.workerPid : undefined
      const workerStopped = d.workerStopped === true
      // A run started before the worker was recorded names no worker: nothing is known about it.
      const outcome = workerPid ? `; worker pid ${workerPid} ${workerStopped ? 'was stopped' : 'had already exited'}` : ''
      return { ts, kind: 'problem', text: `The run's supervisor exited${outcome}`, origin: 'interrupt', reason: { code: 'interrupted', ...(workerPid ? { workerPid } : {}), workerStopped } }
    }
    case 'permission_denied': {
      const note: EventNote = { code: 'sandbox_denied', detail: clip(asText(ev.data)) }
      return { ts, kind: 'problem', text: clip(eventNoteText(note)), origin: 'permission', note }
    }
    default:
      return null
  }
}

/** A tool call that writes a file, as the feed tells it apart. */
export const writesFile = (raw: RawEvent): boolean => toNorm(raw)?.kind === 'file'

/** The `callId` a raw event's data carries, when the backend paired a tool start with its result (st2). */
const callIdOf = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object') return undefined
  const callId = (data as { callId?: unknown }).callId
  return typeof callId === 'string' ? callId : undefined
}

export function normalize(events: RawEvent[]): NormEvent[] {
  const out: NormEvent[] = []
  // A tool/command start (st2) is «in flight» until its result arrives, matched by `callId`; a backend that
  // does not send one (Devin) is never marked open — its last action says nothing about whether it finished.
  const openedBy = new Map<string, NormEvent>()
  const closed = new Set<string>()
  // CLI processes can reuse item IDs after a new turn: a prior completion must not close a new call.
  let turnScope = 0
  for (const raw of events) {
    if (raw.type === 'turn_started') turnScope += 1
    const data = parseEventData(raw.data)
    if (raw.type === 'tool_completed') {
      const callId = callIdOf(data)
      if (callId) closed.add(`${turnScope}:${callId}`)
    }
    const n = toNorm(raw)
    if (!n) continue
    const prev = out.at(-1)
    if (n.kind === 'message' && prev?.kind === 'message') {
      prev.text += n.text
      if (n.display !== undefined) prev.display = (prev.display ?? '') + n.display
      // The message keeps its first `ts` for identity; the last real chunk time is what «last update» means.
      prev.updatedAt = n.ts
      continue
    }
    if (raw.type === 'tool_started' && (n.kind === 'action' || n.kind === 'file')) {
      const callId = callIdOf(data)
      if (callId) openedBy.set(`${turnScope}:${callId}`, n)
    }
    out.push(n)
  }
  for (const e of out) {
    if (e.kind === 'message') e.text = clip(e.text.replace(/\s+/g, ' ').trim())
    if ((e.kind === 'message' || e.kind === 'final') && e.display !== undefined) {
      const bounded = boundDisplay(displayText(e.display))
      if (bounded.display) e.display = bounded.display
      else delete e.display
      if (bounded.truncated) e.truncated = true
    }
  }
  boundDisplays(out)
  for (const [callId, event] of openedBy) if (!closed.has(callId)) event.open = true
  return out
}
