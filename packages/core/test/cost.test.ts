import { describe, expect, it } from 'vitest'
import { extractUsd, runCost, summarizeCosts } from '../src/cost/cost.js'

describe('cost', () => {
  it('I2 leaves initialized CLI counters pending and retains observed cache writes', () => {
    const run = { runId: 'run_claude-x', agent: 'claude/opus', startedAt: '2026-09-23T10:00:00Z' }
    const initial = runCost(run, [], { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, pending: true })
    expect(initial.tokens).toBeUndefined()
    expect(initial.availability?.input).toBe('pending')
    const measured = runCost(run, [], { calls: 1, inputTokens: 22, outputTokens: 6453, cacheReadTokens: 960598, cacheWriteTokens: 182687, reasoningTokens: 0, observedAt: '2026-09-23T10:01:00Z' })
    expect(measured.tokens?.cacheWrite).toBe(182687)
    expect(measured.availability?.cacheWrite).toBe('known')
  })
  it('I5 keeps absent money absent for subscription runs', () => {
    const value = runCost({ runId: 'x', agent: 'codex/gpt-6-sol', startedAt: '2026-09-23T10:00:00Z' }, [])
    expect(value.cashUsd).toBeUndefined()
    expect(value.apiEquivalentUsd).toBeUndefined()
  })
  it('extracts the last reported usd figure', () => {
    expect(extractUsd([{ ts: '1', type: 'x', data: { total_cost_usd: 0.12 } }, { ts: '2', type: 'result', data: '{"total_cost_usd": 0.31}' }])).toBe(0.31)
    expect(extractUsd([{ ts: '1', type: 'x', data: 'no money here' }])).toBeUndefined()
  })

  it('computes duration and codex quota delta', () => {
    const c = runCost(
      { runId: 'run_a-1', agent: 'codex', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:07:30Z', quotaBeforePct: 22, quotaAfterPct: 28.5 },
      [],
    )
    expect(c).toMatchObject({ runId: 'run_a-1', agent: 'codex/gpt-6-astra', rawAgent: 'codex', canonicalWorkerId: 'codex/gpt-6-astra', durationSec: 450, quotaDeltaPct: 6.5, identityResolution: 'alias' })
  })

  it('summarises per agent and keeps unknown money unknown', () => {
    const totals = summarizeCosts([
      { runId: 'a', agent: 'devin', durationSec: 100 },
      { runId: 'b', agent: 'devin', durationSec: 50 },
      { runId: 'c', agent: 'deepseek-flash', durationSec: 10, cashUsd: { value: 0.02, currency: 'USD', source: 'dsh_bill' } },
    ])
    expect(totals.devin).toEqual({ runs: 2, durationSec: 150 })
    expect(totals['deepseek-flash']).toEqual({ runs: 1, durationSec: 10, cashUsd: 0.02 })
  })

  // B08 (ux8 P7): money charged and an API-rate estimate are different units; one `usd` added them up.
  it('V-w1f/cost-split keeps cash and the estimate in separate totals, never one usd', () => {
    const cash = runCost({ runId: 'run_dsh-a', agent: 'dsh/deepseek-flash', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:00:09Z' }, [], { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.5 })
    const estimate = runCost({ runId: 'run_claude-a', agent: 'claude/opus', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:00:09Z' }, [], { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.25 })
    const legacy = runCost({ runId: 'run_devin-a', agent: 'devin', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:00:09Z' }, [{ ts: '1', type: 'result', data: { total_cost_usd: 0.1 } }])
    expect(cash).not.toHaveProperty('usd')
    expect(estimate).not.toHaveProperty('usd')
    expect(estimate.apiEquivalentUsd?.value).toBe(0.25)
    expect(legacy.cashUsd?.value).toBe(0.1)
    const totals = summarizeCosts([cash, estimate, legacy, { ...estimate, runId: 'run_claude-b', agent: 'dsh/deepseek-flash' }])
    expect(totals['dsh/deepseek-flash']).toMatchObject({ runs: 2, cashUsd: 0.5, apiEquivalentUsd: 0.25 })
    expect(totals['claude/opus']).toMatchObject({ runs: 1, apiEquivalentUsd: 0.25 })
    expect(totals['claude/opus']).not.toHaveProperty('cashUsd')
    for (const t of Object.values(totals)) expect(t).not.toHaveProperty('usd')
  })

  it('prefers backend usage for money and tokens', () => {
    const run = { runId: 'run_dsh-a', agent: 'dsh/deepseek-flash', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:00:09Z' }
    const c = runCost(run, [], { sessionId: 's', calls: 5, inputTokens: 120, outputTokens: 20, cacheReadTokens: 100, reasoningTokens: 10, usd: 0.002 })
    expect(c).toMatchObject({ runId: 'run_dsh-a', agent: 'dsh/deepseek-flash', durationSec: 9, cashUsd: { value: 0.002, currency: 'USD' }, calls: 5, tokens: { input: 120, output: 20, cacheRead: 100, reasoning: 10 }, availability: { input: 'known', cash: 'known' } })
    const pending = runCost(run, [], { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, pending: true })
    expect(pending).toMatchObject({ pending: true })
    expect(pending.cashUsd).toBeUndefined()
    const measuredZero = runCost(run, [], { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, observedAt: '2026-09-23T10:00:00Z' })
    expect(measuredZero.availability?.input).toBe('known')
    expect(measuredZero.tokens?.input).toBe(0)
  })

  it('sums tokens and counts pending runs per agent', () => {
    const totals = summarizeCosts([
      { runId: 'a', agent: 'dsh', durationSec: 9, cashUsd: { value: 0.002, currency: 'USD', source: 'dsh_bill' }, calls: 5, tokens: { input: 100, output: 10, cacheRead: 50, reasoning: 5 } },
      { runId: 'b', agent: 'dsh', durationSec: 3, pending: true },
    ])
    expect(totals.dsh).toEqual({ runs: 2, durationSec: 12, cashUsd: 0.002, tokens: { input: 100, output: 10, cacheRead: 50, reasoning: 5 }, pendingRuns: 1 })
  })

  it('keeps outcome distinct from decision and attempt trigger, and separates estimate from cash', () => {
    const failed = runCost({ runId: 'run_fail', agent: 'claude/opus', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:01:00Z', outcome: 'failed', attemptTrigger: 'human_relaunch' }, [], { calls: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, reasoningTokens: 0, apiEquivalentUsd: 0.25 })
    expect(failed.executionOutcome).toBe('failed')
    expect(failed.attemptTrigger).toBe('human_relaunch')
    expect(failed.apiEquivalentUsd).toMatchObject({ value: 0.25, source: 'rate_estimate' })
    expect(failed.cashUsd).toBeUndefined()
  })

  it('deduplicates shared quota samples and does not turn reset samples into spend', () => {
    const shared = { sampleId: 'acct:window:1', accountKey: 'acct', provider: 'codex', windowId: 'week-1', beforePct: 10, afterPct: 20, attribution: 'shared' as const }
    const a = runCost({ runId: 'run_a', agent: 'codex/gpt-6-sol', startedAt: '2026-09-22T10:00:00Z', quotaSamples: [shared] }, [])
    const b = runCost({ runId: 'run_b', agent: 'codex/gpt-6-sol', startedAt: '2026-09-22T10:00:00Z', quotaSamples: [shared] }, [])
    const reset = runCost({ runId: 'run_c', agent: 'codex/gpt-6-sol', startedAt: '2026-09-22T10:00:00Z', quotaSamples: [{ ...shared, sampleId: 'reset', reset: true, attribution: 'exclusive' }] }, [])
    expect(summarizeCosts([a, b, reset])['codex/gpt-6-sol']?.quotaDeltaPct).toBeUndefined()
    expect(summarizeCosts([a, b])['codex/gpt-6-sol']?.quotaDeltaPct).toBeUndefined()
  })
  it('I4 detects a legacy quota reset instead of reporting negative spending', () => {
    const value = runCost({ runId: 'run_codex-reset', agent: 'codex/gpt-6-sol', startedAt: '2026-09-23T10:00:00Z', quotaBeforePct: 97, quotaAfterPct: 2 }, [])
    expect(value.quotaMeasurements?.[0]?.reset).toBe(true)
    expect(value.quotaDeltaPct).toBeUndefined()
  })
})

it('keeps the quota of legacy runs whose attribution is unknown', async () => {
  const { summarizeCosts, runCost } = await import('../src/cost/cost.js')
  const run = (id: string, before: number, after: number) => runCost({ runId: id, agent: 'codex/gpt-6-sol', startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:10:00Z', outcome: 'completed', quotaBeforePct: before, quotaAfterPct: after } as never, [])
  expect(summarizeCosts([run('a', 10, 12), run('b', 12, 15)])['codex/gpt-6-sol']?.quotaDeltaPct).toBe(5)
})
