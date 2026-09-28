import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunUsage } from '../backend/types.js'

type BillRecord = {
  sessionId?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  usd?: number
  priced?: boolean
}

export const dshBillRecordsPath = (env: NodeJS.ProcessEnv, home: string): string =>
  join(env.DSH_HOME ?? join(home, '.dsh'), 'dsh-bill', 'records.jsonl')

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * dsh-bill backfills ACP sessions from their logs when `dsh web` starts, so a missing session
 * means "not recorded yet" (pending), never "free".
 */
export async function readDshBillUsage(recordsFile: string, sessionId: string): Promise<RunUsage> {
  const raw = await readFile(recordsFile, 'utf8').catch(() => '')
  const usage: RunUsage = { sessionId, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
  let usd = 0
  let priced = true
  let pricedCalls = 0
  let cacheWriteCallsObserved = 0
  const observed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let r: BillRecord
    try {
      r = JSON.parse(line) as BillRecord
    } catch {
      continue
    }
    if (r.sessionId !== sessionId) continue
    usage.calls += 1
    if (validCount(r.inputTokens)) { usage.inputTokens += r.inputTokens; observed.input += 1 }
    if (validCount(r.outputTokens)) { usage.outputTokens += r.outputTokens; observed.output += 1 }
    if (validCount(r.cacheReadTokens)) { usage.cacheReadTokens += r.cacheReadTokens; observed.cacheRead += 1 }
    if (validCount(r.cacheWriteTokens)) {
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + r.cacheWriteTokens
      cacheWriteCallsObserved += 1
    }
    if (validCount(r.reasoningTokens)) { usage.reasoningTokens += r.reasoningTokens; observed.reasoning += 1 }
    if (r.priced !== true || !validCount(r.usd)) priced = false
    else { usd += r.usd; pricedCalls += 1 }
  }
  if (usage.calls === 0) return { ...usage, pending: true, source: 'dsh_bill_records' }
  const state = (count: number) => count === 0 ? 'unavailable' as const : count < usage.calls ? 'partial' as const : 'known' as const
  usage.availability = {
    input: { ...(state(observed.input) !== 'unavailable' ? { value: usage.inputTokens } : {}), state: state(observed.input), source: 'dsh_bill_records', final: true },
    output: { ...(state(observed.output) !== 'unavailable' ? { value: usage.outputTokens } : {}), state: state(observed.output), source: 'dsh_bill_records', final: true },
    cacheRead: { ...(state(observed.cacheRead) !== 'unavailable' ? { value: usage.cacheReadTokens } : {}), state: state(observed.cacheRead), source: 'dsh_bill_records', final: true },
    cacheWrite: { ...(state(cacheWriteCallsObserved) !== 'unavailable' ? { value: usage.cacheWriteTokens } : {}), state: state(cacheWriteCallsObserved), source: 'dsh_bill_records', final: true },
    reasoning: { ...(state(observed.reasoning) !== 'unavailable' ? { value: usage.reasoningTokens } : {}), state: state(observed.reasoning), source: 'dsh_bill_records', final: true },
  }
  if (priced && pricedCalls === usage.calls) usage.usd = round6(usd)
  usage.availability.cash = { ...(pricedCalls > 0 ? { value: round6(usd) } : {}), state: priced && pricedCalls === usage.calls ? 'known' : pricedCalls > 0 ? 'partial' : 'unavailable', source: 'dsh_bill_records', final: true }
  usage.source = 'dsh_bill_records'
  usage.cashSourceId = sessionId
  return usage
}

const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
