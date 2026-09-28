import { describe, expect, it } from 'vitest'
import { codexApiEquivalentUsd } from '../src/cost/codex-pricing.js'

describe('codexApiEquivalentUsd (cs1)', () => {
  it('prices a known model from input, output and cache-read tokens', () => {
    // gpt-6-sol: $2/$10/$0.2 per 1M in/out/cacheRead — 1000*2 + 1000*10 + 1000*0.2 = 12_200 per 1M → $0.0122
    expect(codexApiEquivalentUsd('gpt-6-sol', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 })).toEqual({ usd: 0.0122, rateDate: '2026-09-25', priceVersion: 'gpt-6-sol/2026-09-25' })
  })

  it('stays unknown for an unlisted model, never a guessed $0', () => {
    expect(codexApiEquivalentUsd('gpt-5.5', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 })).toBeUndefined()
    expect(codexApiEquivalentUsd(undefined, { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 })).toBeUndefined()
  })

  it('stays unknown when the run reports cache-write tokens, which have no published rate', () => {
    expect(codexApiEquivalentUsd('gpt-6-sol', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 200 })).toBeUndefined()
  })
})
