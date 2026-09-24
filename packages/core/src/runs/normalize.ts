import { basename } from 'node:path'
import type { RawEvent } from '../runs/raw-event.js'

export type NormKind = 'action' | 'file' | 'message' | 'steer' | 'problem' | 'final'
/**
 * Why a run failed, when the runner knows more than a line of text (B01, B19): the screen and the CLI say it in the
 * reader's language from these fields; `text` stays the fallback.
 */
export type FailureReason = { code: 'rate_limited'; resetsAt?: string } | { code: 'interrupted'; workerPid?: number; workerStopped: boolean }
export type NormEvent = { ts: string; kind: NormKind; text: string; reason?: FailureReason }

// Backend noise observed on 2026-09-22: OpenCode lifecycle `progress` events,
// heartbeats and reasoning streams carry no user-facing progress.
const NOISE_TYPES = new Set(['progress', 'heartbeat', 'thinking_delta', 'thinking', 'session', 'usage', 'end'])
const FILE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch'])
const MAX_TEXT = 200

const hhmm = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
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
    case 'steer':
      return { ts, kind: 'steer', text: clip(asText(ev.data)) }
    case 'final':
      return { ts, kind: 'final', text: clip(asText(ev.data)) }
    case 'rate_limited': {
      const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as { resetsAt?: unknown }
      const resetsAt = typeof d.resetsAt === 'string' ? d.resetsAt : undefined
      return { ts, kind: 'problem', text: `Лимит Claude исчерпан${resetsAt ? `, сброс в ${hhmm(resetsAt)}` : ''}`, reason: { code: 'rate_limited', ...(resetsAt ? { resetsAt } : {}) } }
    }
    case 'run_interrupted': {
      const d = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as { workerPid?: unknown; workerStopped?: unknown }
      const workerPid = typeof d.workerPid === 'number' ? d.workerPid : undefined
      const workerStopped = d.workerStopped === true
      // A run started before the worker was recorded names no worker: nothing is known about it.
      const outcome = workerPid ? `; воркер (pid ${workerPid}) ${workerStopped ? 'остановлен' : 'уже не работал'}` : ''
      return { ts, kind: 'problem', text: `Супервизор запуска исчез${outcome}`, reason: { code: 'interrupted', ...(workerPid ? { workerPid } : {}), workerStopped } }
    }
    case 'permission_denied':
      return { ts, kind: 'problem', text: clip(`выход за песочницу отклонён: ${asText(ev.data)}`) }
    default:
      return null
  }
}

export function normalize(events: RawEvent[]): NormEvent[] {
  const out: NormEvent[] = []
  for (const ev of events) {
    const n = toNorm(ev)
    if (!n) continue
    const prev = out.at(-1)
    if (n.kind === 'message' && prev?.kind === 'message') {
      prev.text += n.text
      continue
    }
    out.push(n)
  }
  for (const e of out) if (e.kind === 'message') e.text = clip(e.text.replace(/\s+/g, ' ').trim())
  return out
}
