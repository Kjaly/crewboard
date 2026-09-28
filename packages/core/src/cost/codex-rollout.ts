import { readFile } from 'node:fs/promises'

type Metric = 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens'
type Counters = Partial<Record<Metric, number>>
export type CodexRolloutUsage = {
  actor: 'external_orchestrator'
  provenance: { file: string; observedAt: string }
  source: 'codex_rollout_event_msg_token_count'
  scope: 'explicit_rollout_file'
  snapshots: number
  duplicateSnapshots: number
  resets: number
  unallocatedBaseline: Counters
  models: Array<{ model?: string; snapshots: number } & Counters>
  coverage: Record<Metric, { state: 'observed' | 'unavailable'; reason?: 'missing_from_snapshots' }>
  latest?: { model?: string; lastInputTokens?: number; lastCachedInputTokens?: number; contextWindow?: number }
  cash: 'unavailable'
  quota: 'unavailable'
}

/** Reads only token_count usage and turn_context model metadata from this exact caller-supplied file. */
export async function readCodexRolloutUsage(file: string): Promise<CodexRolloutUsage> {
  const result: CodexRolloutUsage = { actor: 'external_orchestrator', provenance: { file, observedAt: new Date().toISOString() }, source: 'codex_rollout_event_msg_token_count', scope: 'explicit_rollout_file', snapshots: 0, duplicateSnapshots: 0, resets: 0, unallocatedBaseline: {}, models: [], coverage: { inputTokens: { state: 'unavailable', reason: 'missing_from_snapshots' }, outputTokens: { state: 'unavailable', reason: 'missing_from_snapshots' }, cachedInputTokens: { state: 'unavailable', reason: 'missing_from_snapshots' }, reasoningTokens: { state: 'unavailable', reason: 'missing_from_snapshots' } }, cash: 'unavailable', quota: 'unavailable' }
  const raw = await readFile(file, 'utf8')
  let model: string | undefined
  const previous: Counters = {}
  let hasBaseline = false
  const latestContext: { contextWindow?: number } = {}
  const metrics: Metric[] = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']
  for (const line of raw.split('\n')) {
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    // Model metadata only; never copy message, tool, or transcript content.
    if (row?.type === 'turn_context' && typeof row.payload?.model === 'string') model = row.payload.model
    if (row?.type !== 'event_msg' || row?.payload?.type !== 'token_count') continue
    const info = row.payload.info
    if (!info || typeof info !== 'object') continue
    const total = info.total_token_usage
    const last = info.last_token_usage
    const rawValues = [total?.input_tokens, total?.output_tokens, total?.cached_input_tokens, total?.reasoning_output_tokens, last?.input_tokens, last?.cached_input_tokens, info.model_context_window]
    if (rawValues.some((v) => v !== undefined && num(v) === undefined)) continue
    const current: Counters = {
      inputTokens: num(total?.input_tokens), outputTokens: num(total?.output_tokens),
      cachedInputTokens: num(total?.cached_input_tokens), reasoningTokens: num(total?.reasoning_output_tokens),
    }
    const contextWindow = num(info.model_context_window)
    if (contextWindow !== undefined) latestContext.contextWindow = contextWindow
    result.latest = { ...(model ? { model } : {}), ...(num(last?.input_tokens) !== undefined ? { lastInputTokens: num(last.input_tokens) } : {}), ...(num(last?.cached_input_tokens) !== undefined ? { lastCachedInputTokens: num(last.cached_input_tokens) } : {}), ...(latestContext.contextWindow !== undefined ? { contextWindow: latestContext.contextWindow } : {}) }
    const observedKeys = metrics.filter((key) => current[key] !== undefined)
    if (!observedKeys.length) continue
    for (const key of observedKeys) result.coverage[key] = { state: 'observed' }
    if (hasBaseline && observedKeys.every((key) => current[key] === previous[key])) { result.duplicateSnapshots++; continue }
    result.snapshots++
    const decreased = hasBaseline && observedKeys.some((key) => previous[key] !== undefined && current[key]! < previous[key]!)
    if (decreased) {
      result.resets++
      for (const key of metrics) delete previous[key]
    }
    if (!hasBaseline) {
      for (const key of observedKeys) result.unallocatedBaseline[key] = current[key]
      for (const key of observedKeys) previous[key] = current[key]
      hasBaseline = true
      continue
    }
    let bucket: (typeof result.models)[number] | undefined
    let addedDelta = false
    for (const key of observedKeys) {
      const value = current[key]!
      const before = previous[key]
      if (before === undefined && !decreased) {
        result.unallocatedBaseline[key] = (result.unallocatedBaseline[key] ?? 0) + value
        previous[key] = value
        continue
      }
      const delta = decreased || before === undefined ? value : value < before ? value : value - before
      previous[key] = value
      if (delta <= 0) continue
      bucket ??= result.models.find((entry) => entry.model === model)
      if (!bucket) { bucket = { ...(model ? { model } : {}), snapshots: 0 }; result.models.push(bucket) }
      bucket[key] = (bucket[key] ?? 0) + delta
      addedDelta = true
    }
    if (addedDelta && bucket) bucket.snapshots++
  }
  return result
}

const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
