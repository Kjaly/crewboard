import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dshBillRecordsPath, readDshBillUsage } from '../src/cost/dsh-bill.js'

const rec = (sessionId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ seq: 1, time: 1, sessionId, provider: 'deepseek-official', model: 'deepseek-flash', inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 5, usd: 0.0017, priced: true, ...over })

describe('dsh-bill', () => {
  it('sums the calls of one session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, [rec('s1'), rec('s2', { usd: 9 }), rec('s1', { usd: 0.0003, inputTokens: 20 }), 'not json'].join('\n'))
    expect(await readDshBillUsage(file, 's1')).toEqual({ sessionId: 's1', calls: 2, inputTokens: 120, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 10, usd: 0.002, source: 'dsh_bill_records', cashSourceId: 's1' })
  })

  it('reports pending when the session is not recorded yet or the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, rec('other'))
    expect(await readDshBillUsage(file, 's1')).toMatchObject({ calls: 0, pending: true })
    expect((await readDshBillUsage(join(dir, 'missing.jsonl'), 's1')).pending).toBe(true)
  })

  it('leaves money unknown when any call is unpriced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-bill-'))
    const file = join(dir, 'records.jsonl')
    await writeFile(file, [rec('s1'), rec('s1', { priced: false, usd: 0 })].join('\n'))
    const usage = await readDshBillUsage(file, 's1')
    expect(usage.calls).toBe(2)
    expect(usage.usd).toBeUndefined()
  })

  it('resolves the records path from DSH_HOME', () => {
    expect(dshBillRecordsPath({ DSH_HOME: '/d' }, '/h')).toBe('/d/dsh-bill/records.jsonl')
    expect(dshBillRecordsPath({}, '/h')).toBe('/h/.dsh/dsh-bill/records.jsonl')
  })
})
