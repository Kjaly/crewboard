import type { RunUsage } from '../backend/types.js'
import type { Run } from '../plan/schema.js'
import type { RawEvent } from '../runs/raw-event.js'
import { canonicalWorkerId } from '../routing/identity.js'

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite?: number; reasoning: number }
export type RunCost = {
  runId: string
  agent: string
  durationSec?: number
  quotaDeltaPct?: number
  calls?: number
  tokens?: Tokens
  pending?: boolean
  rawAgent?: string
  canonicalWorkerId?: string
  model?: string
  /** The effort the run was launched with (ef1); absent — the CLI's default. */
  effort?: string
  provider?: string
  billingMode?: 'api' | 'subscription' | 'promotional' | 'unknown'
  /** The verified channel a run was launched on; a Claude API-key run's CLI dollar figure is an estimate. */
  authChannel?: 'anthropic-api-key'
  identityResolution?: 'launch_snapshot' | 'alias' | 'legacy_inferred' | 'unresolved'
  cashUsd?: { value: number; currency: 'USD'; source: string; sourceRecordId?: string }
  apiEquivalentUsd?: { value: number; currency: 'USD'; source: string; model?: string; rateDate?: string; priceVersion?: string }
  quotaMeasurements?: Array<{ sampleId: string; accountKey: string; provider: string; windowId: string; beforePct: number; afterPct: number; attribution: 'exclusive' | 'shared' | 'unknown'; reset?: boolean }>
  executionOutcome?: 'completed' | 'failed' | 'cancelled' | 'incomplete' | 'running' | 'unknown'
  attemptIndex?: number
  attemptParentRunId?: string
  attemptTrigger?: 'initial' | 'human_relaunch' | 'automatic_retry' | 'unknown'
  availability?: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'cash', 'known' | 'partial' | 'pending' | 'unavailable' | 'notApplicable'>
  metricObservations?: RunUsage['availability']
  reasoningIncludedInOutput?: boolean
}
/**
 * Money is two units that never add up (B08): `cashUsd` — what the runs were charged, `apiEquivalentUsd` — what
 * subscription runs would have cost at API rates, an estimate. Each is absent when no run reported it.
 */
export type AgentTotals = { runs: number; durationSec: number; cashUsd?: number; apiEquivalentUsd?: number; quotaDeltaPct?: number; tokens?: Tokens; cacheWriteCoverage?: { knownRuns: number; partialRuns: number; totalRuns: number }; pendingRuns?: number }

const USD = /"?(?:total_cost_usd|cost_usd)"?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/

/** Best effort: backends that report money do it as total_cost_usd/cost_usd; otherwise it stays unknown. */
export function extractUsd(events: RawEvent[]): number | undefined {
  let usd: number | undefined
  for (const e of events) {
    const text = typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? null)
    const m = USD.exec(text)
    if (m?.[1]) usd = Number(m[1])
  }
  return usd
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

export function runCost(run: Run, events: RawEvent[], usage?: RunUsage): RunCost {
  const canonical = run.canonicalWorkerId ?? canonicalWorkerId(run.agent)
  const cost: RunCost = { runId: run.runId, agent: canonical, rawAgent: run.rawAgent ?? run.agent, canonicalWorkerId: canonical, ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}), ...(run.provider ? { provider: run.provider } : {}), ...(run.billingMode ? { billingMode: run.billingMode } : {}), ...(run.authChannel ? { authChannel: run.authChannel } : {}), ...(run.attemptIndex ? { attemptIndex: run.attemptIndex } : {}), ...(run.attemptParentRunId ? { attemptParentRunId: run.attemptParentRunId } : {}), ...(run.attemptTrigger ? { attemptTrigger: run.attemptTrigger } : {}), identityResolution: run.identityResolution ?? (canonical !== run.agent ? 'alias' : 'legacy_inferred'), executionOutcome: run.finishedAt ? run.outcome ?? 'unknown' : 'running' }
  if (run.finishedAt) cost.durationSec = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)
  const usd = usage?.usd ?? (usage ? undefined : extractUsd(events))
  // A subscription worker is not charged per run: its dollar figure is an API-rate estimate, not cash.
  const family = canonical.split('/')[0]!.toLowerCase()
  const subscription = run.billingMode ? run.billingMode === 'subscription' || run.billingMode === 'promotional' : family.startsWith('claude') || family.startsWith('codex')
  // A Claude API-key run's CLI `total_cost_usd` is a client-side estimate that can differ from the invoice
  // (docs/en/headless, checked 2026-09-28): it is never recorded as cash. Historical subscription runs keep
  // their old `apiEquivalentUsd` reading.
  const claudeApiEstimate = run.authChannel === 'anthropic-api-key'
  if (usd !== undefined) {
    if (subscription) cost.apiEquivalentUsd = { value: usd, currency: 'USD', source: usage?.source ?? 'rate_estimate', ...(run.model ? { model: run.model } : {}), ...(usage?.rateDate ? { rateDate: usage.rateDate } : {}), ...(usage?.priceVersion ? { priceVersion: usage.priceVersion } : {}) }
    else if (claudeApiEstimate) cost.apiEquivalentUsd = { value: usd, currency: 'USD', source: usage?.source ? `${usage.source}_estimate` : 'claude_cli_estimate', ...(run.model ? { model: run.model } : {}), ...(usage?.rateDate ? { rateDate: usage.rateDate } : {}), ...(usage?.priceVersion ? { priceVersion: usage.priceVersion } : {}) }
    else cost.cashUsd = { value: usd, currency: 'USD', source: usage?.source ?? 'legacy_cost_record', ...(usage?.cashSourceId ? { sourceRecordId: usage.cashSourceId } : {}) }
  }
  if (usage?.apiEquivalentUsd !== undefined) cost.apiEquivalentUsd = { value: usage.apiEquivalentUsd, currency: 'USD', source: usage.source ?? 'rate_estimate', ...(run.model ? { model: run.model } : {}), ...(usage.rateDate ? { rateDate: usage.rateDate } : {}), ...(usage.priceVersion ? { priceVersion: usage.priceVersion } : {}) }
  const quotaSamples = run.quotaSamples ?? (run.quotaBeforePct !== undefined && run.quotaAfterPct !== undefined ? [{ sampleId: `legacy:${run.runId}`, accountKey: 'unknown', provider: canonical.split('/')[0] ?? 'unknown', windowId: 'unknown', beforePct: run.quotaBeforePct, afterPct: run.quotaAfterPct, reset: run.quotaAfterPct < run.quotaBeforePct, attribution: 'unknown' as const }] : [])
  if (quotaSamples.length) {
    cost.quotaMeasurements = quotaSamples.map((s) => ({ ...s }))
    const attributable = quotaSamples.filter((sample) => !sample.reset && sample.attribution !== 'shared')
    if (attributable.length) cost.quotaDeltaPct = attributable.reduce((sum, sample) => sum + sample.afterPct - sample.beforePct, 0)
  }
  if (usage?.pending) cost.pending = true
  if (usage) {
    if (usage.availability) cost.metricObservations = usage.availability
    if (usage.reasoningIncludedInOutput !== undefined) cost.reasoningIncludedInOutput = usage.reasoningIncludedInOutput
    cost.calls = usage.calls
    const legacyObserved = usage.calls > 0 || !!usage.observedAt
    const hasObservedUsage = (['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const).some((key) => {
      const state = usage.availability?.[key]?.state
      return state ? state === 'known' || state === 'partial' : legacyObserved && (key !== 'cacheWrite' || usage.cacheWriteTokens !== undefined)
    })
    const cacheWriteState = usage.availability?.cacheWrite?.state
    if (!usage.pending && hasObservedUsage) cost.tokens = { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, ...(cacheWriteState === 'known' || cacheWriteState === 'partial' || (!usage.availability && usage.cacheWriteTokens !== undefined) ? { cacheWrite: usage.cacheWriteTokens ?? usage.availability?.cacheWrite?.value ?? 0 } : {}), reasoning: usage.reasoningTokens }
    const unobserved = usage.calls === 0 && !usage.observedAt && !usage.availability
    const absent = usage.pending ? 'pending' : run.finishedAt ? 'unavailable' : 'pending'
    // Cash is «known» only for a real cash record. A Claude API-key run reports an estimate, so its invoice
    // stays unavailable/pending even if a usage record mistakenly claims cash — never a false invoice; a
    // subscription run has no cash at all (`notApplicable`).
    const cashState = claudeApiEstimate
      ? usage.pending ? 'pending' : 'unavailable'
      : usage.availability?.cash?.state ?? (usd === undefined ? (usage.pending ? 'pending' : subscription ? 'notApplicable' : 'unavailable') : 'known')
    cost.availability = { input: usage.availability?.input?.state ?? (unobserved ? absent : 'known'), output: usage.availability?.output?.state ?? (unobserved ? absent : 'known'), cacheRead: usage.availability?.cacheRead?.state ?? (unobserved ? absent : 'known'), cacheWrite: usage.availability?.cacheWrite?.state ?? (usage.cacheWriteTokens === undefined ? unobserved ? absent : 'unavailable' : unobserved ? absent : 'known'), reasoning: usage.availability?.reasoning?.state ?? (unobserved ? absent : 'known'), cash: cashState }
  } else {
    const absent = run.finishedAt ? 'unavailable' : 'pending'
    cost.availability = { input: absent, output: absent, cacheRead: absent, cacheWrite: absent, reasoning: absent, cash: subscription ? 'notApplicable' : 'unavailable' }
  }
  return cost
}

export type QuotaWindowTotal = { provider: string; accountKey: string; windowId: string; deltaPct: number }
/**
 * A `--by` slice's totals (cs1). Quota is kept per window (`quotaWindows`) instead of one summed
 * `quotaDeltaPct`: a 5-hour window and a weekly window are different scopes, and blending their deltas into
 * one number would misrepresent both.
 */
export type CostSlice = { key: string; runs: number; durationSec: number; cashUsd?: number; apiEquivalentUsd?: number; quotaWindows: QuotaWindowTotal[]; tokens?: Tokens; cacheWriteCoverage?: { knownRuns: number; partialRuns: number; totalRuns: number }; pendingRuns?: number }

/** Groups `costs` by `keyOf`, for `crewboard cost --by worker|task|plan|class|effort|day` (cs1). */
export function summarizeCostsBySlice<T extends RunCost>(costs: T[], keyOf: (cost: T) => string): Record<string, CostSlice> {
  const out: Record<string, CostSlice> = {}
  for (const c of costs) {
    const key = keyOf(c)
    out[key] ??= { key, runs: 0, durationSec: 0, quotaWindows: [] }
    const t = out[key]
    t.runs += 1
    if (t.cacheWriteCoverage) t.cacheWriteCoverage.totalRuns += 1
    if (c.tokens?.cacheWrite !== undefined) {
      t.tokens ??= { input: 0, output: 0, cacheRead: 0, reasoning: 0 }
      t.tokens.cacheWrite = (t.tokens.cacheWrite ?? 0) + c.tokens.cacheWrite
      t.cacheWriteCoverage ??= { knownRuns: 0, partialRuns: 0, totalRuns: t.runs }
      if (c.availability?.cacheWrite === 'partial') t.cacheWriteCoverage.partialRuns += 1
      else t.cacheWriteCoverage.knownRuns += 1
    }
    t.durationSec += c.durationSec ?? 0
    if (c.cashUsd) t.cashUsd = round6((t.cashUsd ?? 0) + c.cashUsd.value)
    if (c.apiEquivalentUsd) t.apiEquivalentUsd = round6((t.apiEquivalentUsd ?? 0) + c.apiEquivalentUsd.value)
    for (const sample of c.quotaMeasurements ?? []) {
      if (sample.reset || sample.attribution === 'shared') continue
      let w = t.quotaWindows.find((x) => x.provider === sample.provider && x.accountKey === sample.accountKey && x.windowId === sample.windowId)
      if (!w) {
        w = { provider: sample.provider, accountKey: sample.accountKey, windowId: sample.windowId, deltaPct: 0 }
        t.quotaWindows.push(w)
      }
      w.deltaPct = round1(w.deltaPct + (sample.afterPct - sample.beforePct))
    }
    if (c.tokens) {
      t.tokens ??= { input: 0, output: 0, cacheRead: 0, reasoning: 0 }
      t.tokens.input += c.tokens.input
      t.tokens.output += c.tokens.output
      t.tokens.cacheRead += c.tokens.cacheRead
      t.tokens.reasoning += c.tokens.reasoning
    }
    if (c.pending) t.pendingRuns = (t.pendingRuns ?? 0) + 1
  }
  return out
}

export function summarizeCosts(costs: RunCost[]): Record<string, AgentTotals> {
  const out: Record<string, AgentTotals> = {}
  const seenQuota = new Set<string>()
  for (const c of costs) {
    out[c.agent] ??= { runs: 0, durationSec: 0 }
    const t = out[c.agent]
    t.runs += 1
    if (t.cacheWriteCoverage) t.cacheWriteCoverage.totalRuns += 1
    if (c.tokens?.cacheWrite !== undefined) {
      t.tokens ??= { input: 0, output: 0, cacheRead: 0, reasoning: 0 }
      t.tokens.cacheWrite = (t.tokens.cacheWrite ?? 0) + c.tokens.cacheWrite
      t.cacheWriteCoverage ??= { knownRuns: 0, partialRuns: 0, totalRuns: t.runs }
      if (c.availability?.cacheWrite === 'partial') t.cacheWriteCoverage.partialRuns += 1
      else t.cacheWriteCoverage.knownRuns += 1
    }
    t.durationSec += c.durationSec ?? 0
    if (c.cashUsd) t.cashUsd = round6((t.cashUsd ?? 0) + c.cashUsd.value)
    if (c.apiEquivalentUsd) t.apiEquivalentUsd = round6((t.apiEquivalentUsd ?? 0) + c.apiEquivalentUsd.value)
    if (c.quotaMeasurements?.length) {
      const unique = c.quotaMeasurements.filter((sample) => !seenQuota.has(sample.sampleId) && (seenQuota.add(sample.sampleId), true))
      // Only a sample known to be shared is left out; legacy samples of unknown attribution keep the
      // per-run delta they always contributed, or older plans would lose every quota figure.
      const attributable = unique.filter((sample) => !sample.reset && sample.attribution !== 'shared')
      if (attributable.length) t.quotaDeltaPct = round1((t.quotaDeltaPct ?? 0) + attributable.reduce((sum, sample) => sum + sample.afterPct - sample.beforePct, 0))
    } else if (c.quotaDeltaPct !== undefined) t.quotaDeltaPct = round1((t.quotaDeltaPct ?? 0) + c.quotaDeltaPct)
    if (c.tokens) {
      t.tokens ??= { input: 0, output: 0, cacheRead: 0, reasoning: 0 }
      const s = t.tokens
      s.input += c.tokens.input
      s.output += c.tokens.output
      s.cacheRead += c.tokens.cacheRead
      s.reasoning += c.tokens.reasoning
    }
    if (c.pending) t.pendingRuns = (t.pendingRuns ?? 0) + 1
  }
  return out
}
