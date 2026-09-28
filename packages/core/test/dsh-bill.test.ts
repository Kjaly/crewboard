import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dshBillRecordsPath, readDshBillUsage } from '../src/cost/dsh-bill.js'
import { runCost } from '../src/cost/cost.js'

const rec = (sessionId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ seq: 1, time: 1, sessionId, provider: 'deepseek-official', model: 'deepseek-flash', inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 5, usd: 0.0017, priced: true, ...over })

describe('dsh-bill', () => {
  it('retains observed token fields when only cache-write availability is unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-partial-availability-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, rec('s1', { inputTokens: 120, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: undefined }))
    const usage = await readDshBillUsage(file, 's1')
    const cost = runCost({ runId: 'run_dsh-test', agent: 'dsh/deepseek-flash', startedAt: '2026-09-28T00:00:00Z', finishedAt: '2026-09-28T00:01:00Z' }, [], usage)
    expect(cost.tokens).toMatchObject({ input: 120, output: 20, cacheRead: 100 })
    expect(cost.tokens).not.toHaveProperty('cacheWrite')
    expect(cost.availability).toMatchObject({ input: 'known', output: 'known', cacheRead: 'known', cacheWrite: 'unavailable' })
  })
  it('sums the calls of one session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, [rec('s1'), rec('s2', { usd: 9 }), rec('s1', { usd: 0.0003, inputTokens: 20 }), 'not json'].join('\n'))
    expect(await readDshBillUsage(file, 's1')).toMatchObject({ sessionId: 's1', calls: 2, inputTokens: 120, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 10, availability: { input: { value: 120, state: 'known' }, output: { value: 20, state: 'known' }, cacheRead: { value: 100, state: 'known' }, cacheWrite: { value: 0, state: 'known' }, reasoning: { value: 10, state: 'known' } }, usd: 0.002, source: 'dsh_bill_records', cashSourceId: 's1' })
  })

  it('reports pending when the session is not recorded yet or the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, rec('other'))
    expect(await readDshBillUsage(file, 's1')).toMatchObject({ calls: 0, pending: true })
    expect((await readDshBillUsage(join(dir, 'missing.jsonl'), 's1')).pending).toBe(true)
  })
  it('keeps cache writes unknown when the bill record omits that metric', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-cache-write-'))
    const file = join(dir, 'records.jsonl')
    const record = JSON.stringify({ sessionId: 's1', inputTokens: 1, outputTokens: 2, usd: 0, priced: true })
    await writeFile(file, record)
    expect(await readDshBillUsage(file, 's1')).not.toHaveProperty('cacheWriteTokens')
  })

  it('marks omitted fields unavailable and mixed presence partial while preserving explicit zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-fields-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, [JSON.stringify({ sessionId: 's1', inputTokens: 0, outputTokens: 3 }), JSON.stringify({ sessionId: 's1', inputTokens: 5, outputTokens: 0, reasoningTokens: 0 })].join('\n'))
    const usage = await readDshBillUsage(file, 's1')
    expect(usage.availability).toMatchObject({ input: { value: 5, state: 'known' }, output: { value: 3, state: 'known' }, cacheRead: { state: 'unavailable' }, cacheWrite: { state: 'unavailable' }, reasoning: { value: 0, state: 'partial' } })
  })

  it('leaves money unknown when any call is unpriced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, [rec('s1'), rec('s1', { priced: false, usd: 0 })].join('\n'))
    const usage = await readDshBillUsage(file, 's1')
    expect(usage.calls).toBe(2)
    expect(usage.usd).toBeUndefined()
    expect(usage.availability?.cash).toMatchObject({ value: 0.0017, state: 'partial' })
    const cost = runCost({ runId: 'run_dsh-partial', agent: 'dsh/deepseek-flash', startedAt: '2026-09-28T00:00:00Z', finishedAt: '2026-09-28T00:01:00Z' }, [], usage)
    expect(cost.cashUsd).toBeUndefined()
    expect(cost.availability?.cash).toBe('partial')
  })

  it('does not count negative or non-finite token and cash fields as observed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-invalid-numbers-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, [rec('s1', { inputTokens: -5, outputTokens: 1, cacheWriteTokens: -1, usd: -2 }), rec('s1', { inputTokens: 0, outputTokens: -1, cacheWriteTokens: 0, usd: 0, priced: true })].join('\n'))
    const usage = await readDshBillUsage(file, 's1')
    expect(usage.availability).toMatchObject({ input: { value: 0, state: 'partial' }, output: { value: 1, state: 'partial' }, cacheWrite: { value: 0, state: 'partial' }, cash: { value: 0, state: 'partial' } })
    expect(usage.calls).toBe(2)
    expect(usage.source).toBe('dsh_bill_records')
  })

  it('resolves the records path from DSH_HOME', () => {
    expect(dshBillRecordsPath({ DSH_HOME: '/d' }, '/h')).toBe('/d/dsh-bill/records.jsonl')
    expect(dshBillRecordsPath({}, '/h')).toBe('/h/.dsh/dsh-bill/records.jsonl')
  })
})
