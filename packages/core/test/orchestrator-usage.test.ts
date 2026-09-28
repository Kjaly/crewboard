import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orchestratorUsage, readOrchestratorBindings } from '../src/cost/orchestrator-usage.js'
import { readCodexRolloutUsage } from '../src/cost/codex-rollout.js'

describe('orchestrator usage', () => {
  it('reports absent binding unavailable and missing bill pending, then observes backfill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-usage-'))
    const bill = join(dir, 'records.jsonl')
    await writeFile(bill, '')
    expect(await orchestratorUsage({}, bill)).toMatchObject({ availability: 'unavailable', reason: 'no_bound_session' })
    const bindings = { p1: { sessionId: 's1', boundAt: '2026-09-01T00:00:00Z' } }
    expect(await orchestratorUsage(bindings, bill)).toMatchObject({ availability: 'pending', sessions: [{ state: 'pending' }] })
    await writeFile(bill, JSON.stringify({ sessionId: 's1', inputTokens: 0, outputTokens: 4, usd: 0, priced: true }))
    expect(await orchestratorUsage(bindings, bill)).toMatchObject({ availability: 'available', sessions: [{ state: 'observed', calls: 1, source: 'dsh_bill_records', cash: { value: 0, state: 'known', calls: 1 }, metrics: { input: { value: 0, state: 'known' }, cacheWrite: { state: 'unavailable' }, reasoning: { state: 'unavailable' } } }] })
  })
  it('deduplicates one session bound to multiple selected plans and reads only the explicit bindings file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-binding-'))
    const file = join(dir, 'chats.json')
    await writeFile(file, JSON.stringify({ a: { sessionId: 'same', boundAt: 'one' }, b: { sessionId: 'same', boundAt: 'two' }, c: { sessionId: 'other' } }))
    const bindings = await readOrchestratorBindings(file)
    const cost = await orchestratorUsage(bindings, join(dir, 'missing'), ['a', 'b'])
    expect(cost.coverage).toEqual({ bound: 1, observed: 0, pending: 1 })
    expect(cost.sessions[0]?.sessionId).toBe('same')
  })
})

describe('explicit Codex rollout diagnostic', () => {
  it('deduplicates cumulative snapshots, handles reset/model change and ignores unrelated event content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-rollout-'))
    const file = join(dir, 'one.jsonl')
    const event = (input: number, output: number, cached: number, last: number, context = 1000) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: 1 }, last_token_usage: { input_tokens: last, cached_input_tokens: 2 }, model_context_window: context, transcript_body: 'must not be surfaced' } } })
    await writeFile(file, [JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'ignored' } }), JSON.stringify({ type: 'turn_context', payload: { model: 'm1', body: 'ignored too' } }), event(100, 10, 20, 8), event(100, 10, 20, 8), JSON.stringify({ type: 'turn_context', payload: { model: 'm2' } }), event(120, 12, 22, 9), event(2, 1, 0, 2), event(-4, 1, 0, 0)].join('\n'))
    const usage = await readCodexRolloutUsage(file)
    expect(usage).toMatchObject({ snapshots: 3, duplicateSnapshots: 1, resets: 1, unallocatedBaseline: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, reasoningTokens: 1 }, models: [{ model: 'm2', snapshots: 2, inputTokens: 22, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 }], latest: { model: 'm2', lastInputTokens: 2, contextWindow: 1000 }, cash: 'unavailable', quota: 'unavailable' })
    expect(JSON.stringify(usage)).not.toContain('transcript_body')
  })
  it('retains unknown-model deltas, sparse fields and latest context across repeated totals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-sparse-'))
    const file = join(dir, 'rollout.jsonl')
    const snap = (total: object, context: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, model_context_window: context } } })
    await writeFile(file, [snap({ input_tokens: 5 }, 10), snap({ input_tokens: 8, output_tokens: 2 }, 20), snap({ input_tokens: 8, output_tokens: 2 }, 30), snap({ input_tokens: 10 }, 30), snap({ input_tokens: 13, output_tokens: 4 }, 30)].join('\n'))
    const usage = await readCodexRolloutUsage(file)
    expect(usage).toMatchObject({ unallocatedBaseline: { inputTokens: 5, outputTokens: 2 }, models: [{ snapshots: 3, inputTokens: 8, outputTokens: 2 }], coverage: { inputTokens: { state: 'observed' }, outputTokens: { state: 'observed' }, cachedInputTokens: { state: 'unavailable', reason: 'missing_from_snapshots' } }, latest: { contextWindow: 30 } })
  })
})
