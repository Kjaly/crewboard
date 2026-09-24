import type { RawEvent } from './raw-event.js'
import { describeTool, parseEventData } from './normalize.js'

export type LedgerKind = 'request' | 'model' | 'tool' | 'edit' | 'check' | 'steer' | 'problem' | 'final'
export type LedgerTokens = { input: number; output: number; cacheRead: number }
export type LedgerRecord = {
  stepId: string
  index: number
  kind: LedgerKind
  label: string
  startedAt: number
  durationMs: number | null
  timing?: 'exact' | 'approximate' | 'open'
  tokens?: LedgerTokens
  isError: boolean
  input?: string
  output?: string
  turn: number
  state?: string
  contextUsed?: number
  costUsd?: number
}

export type LedgerExtra = {
  at: string
  kind: 'check' | 'edit' | 'final' | 'steer'
  label: string
  input?: string
  output?: string
  state?: string
  isError?: boolean
}

const asText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? '')
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const short = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 160)
const valid = (value: number) => Number.isFinite(value)
const kindOfTool = (tool: string, label: string): LedgerKind => /^(edit|write|patch|multiedit|apply_patch)$/i.test(tool) ? 'edit' : /(?:test|check|lint|typecheck|build)/i.test(label) ? 'check' : 'tool'
const steerState = (raw: string): string => /abandoned|failed|rejected|cancelled|dropped|incomplete/.test(raw) ? 'abandoned' : /completed|applied|acknowledged|merged/.test(raw) ? 'acknowledged' : /request_sent|delivered|sent|running/.test(raw) ? 'sent' : /queued|accepted|delivering|awaiting/.test(raw) ? 'queued' : raw

/** A lossless-enough review projection: never infer a completed duration or token usage from silence. */
export function buildLedger(events: RawEvent[], window: { startedAt: string; finishedAt?: string }, extras: LedgerExtra[] = []): LedgerRecord[] {
  const start = Date.parse(window.startedAt)
  const ordered = events.map((event, order) => ({ event, order, at: Date.parse(event.ts), data: parseEventData(event.data) }))
    .filter((item) => valid(item.at)).sort((a, b) => a.at - b.at || a.order - b.order)
  const records: LedgerRecord[] = []
  const tools = new Map<string, LedgerRecord>()
  const pending: LedgerRecord[] = []
  let turn = 0
  let cursor = valid(start) ? start : (ordered[0]?.at ?? 0)
  let modelStart: number | null = null
  let modelText = ''
  let modelContext: number | undefined
  let modelTokens: LedgerTokens | undefined
  let modelCost: number | undefined
  let modelApproximate = false
  const ids = new Map<string, number>()
  const add = (record: Omit<LedgerRecord, 'index' | 'stepId'>): LedgerRecord => {
    const base = `${record.startedAt.toString(36)}:${record.kind}`
    const occurrence = (ids.get(base) ?? 0) + 1
    ids.set(base, occurrence)
    const next = { ...record, timing: record.timing ?? (record.durationMs === null ? 'open' : 'exact'), stepId: `step:${base}:${occurrence.toString(36)}`, index: records.length + 1 }
    records.push(next)
    return next
  }
  const finishModel = (at: number) => {
    if (modelStart === null) return
    if (at > modelStart || modelText) add({ kind: 'model', label: short(modelText) || 'Model reply', startedAt: modelStart, durationMs: Math.max(0, at - modelStart), timing: modelApproximate ? 'approximate' : 'exact', isError: false, ...(modelText ? { output: modelText } : {}), ...(modelContext !== undefined ? { contextUsed: modelContext } : {}), ...(modelTokens ? { tokens: modelTokens } : {}), ...(modelCost !== undefined ? { costUsd: modelCost } : {}), turn: Math.max(1, turn) })
    modelStart = null
    modelText = ''
    modelContext = undefined
    modelTokens = undefined
    modelCost = undefined
    modelApproximate = false
  }
  for (const { event, at, data } of ordered) {
    const d = obj(data)
    if (event.type === 'turn_started') {
      finishModel(at)
      turn = typeof d.turn === 'number' ? d.turn : turn + 1
      const input = typeof d.fullText === 'string' ? d.fullText : typeof d.text === 'string' ? d.text : ''
      add({ kind: 'request', label: short(input) || `Turn ${turn}`, startedAt: at, durationMs: 0, isError: false, ...(input ? { input } : {}), turn })
      cursor = at
      modelStart = at
    } else if (event.type === 'tool_started') {
      if (d.status && d.status !== 'running') continue
      finishModel(at)
      const tool = typeof d.tool === 'string' ? d.tool : 'tool'
      const input = d.input === undefined ? (typeof data === 'string' ? data : undefined) : asText(d.input)
      const label = typeof data === 'string' ? short(data) : describeTool(tool, d.input as Record<string, unknown> | undefined)
      const record = add({ kind: kindOfTool(tool, label), label: short(label), startedAt: at, durationMs: null, isError: false, ...(input ? { input } : {}), turn: Math.max(1, turn) })
      const id = d.callId ?? d.call_id
      if (typeof id === 'string' && id) tools.set(id, record)
      else pending.push(record)
    } else if (event.type === 'tool_completed') {
      const id = d.callId ?? d.call_id
      const record = typeof id === 'string' ? tools.get(id) : pending.shift()
      if (record) {
        record.durationMs = Math.max(0, at - record.startedAt)
        record.timing = 'exact'
        record.isError = d.status === 'error' || d.status === 'failed'
        const result = d.output ?? d.result ?? d.content ?? d.error
        if (result !== undefined) record.output = asText(result)
        if (typeof id === 'string') tools.delete(id)
      }
      cursor = at
      modelStart = at
    } else if (event.type === 'answer_delta' || event.type === 'text') {
      if (event.type === 'text' && event.backend === 'devin') continue // Devin duplicates text as answer_delta.
      if (modelStart === null) { modelStart = Math.max(cursor, at); modelApproximate = true }
      modelText += asText(data)
    } else if (event.type === 'turn_ended' || event.type === 'turn_completed') {
      finishModel(at)
      cursor = at
    } else if (event.type === 'result' || event.type === 'final' || event.type === 'run_completed') {
      finishModel(at)
      if (event.type !== 'run_completed') add({ kind: 'final', label: short(asText(data)) || 'Final answer', startedAt: at, durationMs: 0, isError: false, output: asText(data), turn: Math.max(1, turn) })
    } else if (event.type === 'steer' || event.type.startsWith('steer_')) {
      const state = steerState(event.type === 'steer' ? 'sent' : event.type === 'steer_ack' ? String(d.status ?? 'acknowledged') : event.type.slice(6))
      add({ kind: 'steer', label: short(typeof data === 'string' ? data : String(d.text ?? d.status ?? state)), startedAt: at, durationMs: 0, isError: /abandoned|failed|rejected/.test(state), input: asText(data), turn: Math.max(1, turn), state })
    } else if (event.type === 'usage') {
      // ACP usage_update currently provides context occupancy, not per-step input/output counts.
      const used = Number(d.used)
      if (valid(used)) modelContext = used
      const input = Number(d.inputTokens ?? d.input_tokens)
      const output = Number(d.outputTokens ?? d.output_tokens)
      if (valid(input) && valid(output)) {
        modelTokens = { input, output, cacheRead: Number(d.cacheReadTokens ?? d.cache_read_tokens ?? 0) || 0 }
      }
      const cost = Number(d.costUsd ?? d.cost_usd)
      if (valid(cost)) modelCost = cost
    } else if (['error', 'failed', 'run_failed', 'permission_denied'].includes(event.type)) {
      finishModel(at)
      add({ kind: 'problem', label: short(asText(data)), startedAt: at, durationMs: 0, isError: true, output: asText(data), turn: Math.max(1, turn) })
    }
  }
  if (window.finishedAt) finishModel(Date.parse(window.finishedAt))
  else if (modelStart !== null) add({ kind: 'model', label: short(modelText) || 'Model reply', startedAt: modelStart, durationMs: null, isError: false, ...(modelText ? { output: modelText } : {}), ...(modelContext !== undefined ? { contextUsed: modelContext } : {}), ...(modelTokens ? { tokens: modelTokens } : {}), ...(modelCost !== undefined ? { costUsd: modelCost } : {}), turn: Math.max(1, turn) })
  for (const extra of extras) {
    const at = Date.parse(extra.at)
    if (!valid(at)) continue
    add({ kind: extra.kind, label: extra.label, startedAt: at, durationMs: 0, timing: 'approximate', isError: extra.isError ?? false, ...(extra.input ? { input: extra.input } : {}), ...(extra.output ? { output: extra.output } : {}), ...(extra.state ? { state: extra.state } : {}), turn: Math.max(1, turn) })
  }
  return records.sort((a, b) => a.startedAt - b.startedAt || a.index - b.index).map((record, index) => ({ ...record, index: index + 1 }))
}
