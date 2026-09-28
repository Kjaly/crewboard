type Price = { input: number; output: number; cacheRead: number }

/**
 * USD per 1M tokens, converted from Codex credits at 1 credit = $0.04 (both the credit table and the
 * per-model USD figures agree on this rate) — https://developers.openai.com/codex/pricing, which redirects
 * to https://learn.chatgpt.com/docs/pricing (checked 2026-09-25). Cache-write tokens have no published
 * rate: a call that reports any leaves the model unpriced rather than guessing (cs1).
 */
const PRICES: Record<string, Price> = {
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02 },
}

const RATE_DATE = '2026-09-25'

export type CodexTokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number }

/** An API-rate estimate for a Codex run's tokens, from the published per-model rates; `undefined` — an unknown model or unpriced cache writes, never a guessed $0. */
export function codexApiEquivalentUsd(model: string | undefined, usage: CodexTokenUsage): { usd: number; rateDate: string; priceVersion: string } | undefined {
  const price = model ? PRICES[model] : undefined
  if (!price || usage.cacheWriteTokens) return undefined
  const micros = usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead
  return { usd: Math.round(micros) / 1e6, rateDate: RATE_DATE, priceVersion: `${model}/${RATE_DATE}` }
}
