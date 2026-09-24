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
  const usage: RunUsage = { sessionId, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let usd = 0
  let priced = true
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
    usage.inputTokens += r.inputTokens ?? 0
    usage.outputTokens += r.outputTokens ?? 0
    usage.cacheReadTokens += r.cacheReadTokens ?? 0
    usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (r.cacheWriteTokens ?? 0)
    usage.reasoningTokens += r.reasoningTokens ?? 0
    if (r.priced === false || typeof r.usd !== 'number') priced = false
    else usd += r.usd
  }
  if (usage.calls === 0) return { ...usage, pending: true, source: 'dsh_bill_records' }
  if (priced) usage.usd = round6(usd)
  usage.source = 'dsh_bill_records'
  usage.cashSourceId = sessionId
  return usage
}
