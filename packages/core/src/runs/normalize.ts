import { basename } from 'node:path'
import type { RawEvent } from '../runs/raw-event.js'
import type { FailureReason } from './failure.js'

export type NormKind = 'action' | 'file' | 'message' | 'steer' | 'problem' | 'final'
export type { FailureReason } from './failure.js'

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
export type NormEvent = { ts: string; kind: NormKind; text: string; reason?: FailureReason; note?: EventNote; open?: true }

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

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)
const asText = (data: unknown) => (typeof data === 'string' ? data : JSON.stringify(data ?? ''))

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
        return { ts, kind: FILE_TOOLS.has(tool) ? 'file' : 'action', text: clip(describeTool(tool, d.input)) }
      }
      const text = asText(ev.data)
      return { ts, kind: /^(edit|write|create|update)\b/i.test(text) ? 'file' : 'action', text: clip(text) }
    }
    case 'tool_completed': {
      const d = ev.data as ToolData | undefined
      if (d && typeof d === 'object' && d.status === 'error') return { ts, kind: 'problem', text: clip(`${d.tool ?? 'tool'} failed`) }
      return null
    }
    case 'result':
      return { ts, kind: 'final', text: clip(asText(ev.data)) }
    case 'answer_delta':
      return { ts, kind: 'message', text: asText(ev.data) }
    case 'error':
    case 'failed':
    case 'run_failed':
      return { ts, kind: 'problem', text: clip(asText(ev.data)) }
    case 'steer': {
      const note = eventNoteOf(ev.data)
      return note ? { ts, kind: 'steer', text: eventNoteText(note), note } : { ts, kind: 'steer', text: clip(asText(ev.data)) }
    }
    case 'final':
      return { ts, kind: 'final', text: clip(asText(ev.data)) }
    case 'rate_limited': {
      const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as { resetsAt?: unknown }
      const resetsAt = typeof d.resetsAt === 'string' ? d.resetsAt : undefined
      return { ts, kind: 'problem', text: `Usage limit reached${resetsAt ? `, resets at ${resetsAt}` : ''}`, reason: { code: 'rate_limited', ...(resetsAt ? { resetsAt } : {}) } }
    }
    case 'run_interrupted': {
      const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as { workerPid?: unknown; workerStopped?: unknown }
      const workerPid = typeof d.workerPid === 'number' ? d.workerPid : undefined
      const workerStopped = d.workerStopped === true
      // A run started before the worker was recorded names no worker: nothing is known about it.
      const outcome = workerPid ? `; worker pid ${workerPid} ${workerStopped ? 'was stopped' : 'had already exited'}` : ''
      return { ts, kind: 'problem', text: `The run's supervisor exited${outcome}`, reason: { code: 'interrupted', ...(workerPid ? { workerPid } : {}), workerStopped } }
    }
    case 'permission_denied': {
      const note: EventNote = { code: 'sandbox_denied', detail: clip(asText(ev.data)) }
      return { ts, kind: 'problem', text: clip(eventNoteText(note)), note }
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
  for (const raw of events) {
    const data = parseEventData(raw.data)
    if (raw.type === 'tool_completed') {
      const callId = callIdOf(data)
      if (callId) closed.add(callId)
    }
    const n = toNorm(raw)
    if (!n) continue
    const prev = out.at(-1)
    if (n.kind === 'message' && prev?.kind === 'message') {
      prev.text += n.text
      continue
    }
    if (raw.type === 'tool_started' && (n.kind === 'action' || n.kind === 'file')) {
      const callId = callIdOf(data)
      if (callId) openedBy.set(callId, n)
    }
    out.push(n)
  }
  for (const e of out) if (e.kind === 'message') e.text = clip(e.text.replace(/\s+/g, ' ').trim())
  for (const [callId, event] of openedBy) if (!closed.has(callId)) event.open = true
  return out
}
