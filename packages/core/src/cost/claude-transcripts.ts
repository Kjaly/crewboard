import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunUsage } from '../backend/types.js'
import { crewboardEnv } from '../env.js'

// Claude Code keeps one transcript directory per working directory: ~/.claude/projects/<slug>/<session>.jsonl.

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
/**
 * USD per 1M tokens (5-minute cache writes, standard cache-hit rate) —
 * https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-25).
 * Keyed by the exact model id Claude Code writes to the transcript, never a startsWith/prefix
 * family: `claude-opus-5-5` (Opus 5.5) is a distinct, separately-priced model from `claude-opus-5`
 * (Opus 5), so it needs its own row rather than inheriting the older price.
 */
const PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
}
/** Claude Code sometimes pins a model to a dated snapshot (e.g. `claude-haiku-4-5-20251001`); the
 * date is not a version, so after an exact-match miss it is stripped and the base id tried again.
 * A minor version (`-5-5`) is never stripped this way — only a trailing 8-digit date is. */
const SNAPSHOT_DATE = /-\d{8}$/
function priceForModel(model: string): Price | undefined {
  const exact = PRICES[model]
  if (exact) return exact
  const family = model.replace(SNAPSHOT_DATE, '')
  return family === model ? undefined : PRICES[family]
}

export const claudeProjectsDir = (env: NodeJS.ProcessEnv, home: string): string => crewboardEnv(env, 'CLAUDE_PROJECTS') ?? join(home, '.claude', 'projects')
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

type Line = { timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Usage of every assistant message written in `cwd` between the run's start and finish (message ids counted once). */
export async function readClaudeTranscriptUsage(projectsDir: string, cwd: string, window: { startedAt: string; finishedAt?: string }): Promise<RunUsage | undefined> {
  const dir = join(projectsDir, claudeProjectSlug(cwd))
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'))
  const from = Date.parse(window.startedAt)
  const to = window.finishedAt ? Date.parse(window.finishedAt) : Number.POSITIVE_INFINITY
  const seen = new Set<string>()
  const usage: RunUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
  const pricedModels = new Set<string>()
  let micros = 0
  let priced = true
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => '')
    for (const raw of text.split('\n')) {
      if (!raw.includes('"usage"')) continue
      let line: Line
      try {
        line = JSON.parse(raw) as Line
      } catch {
        continue
      }
      const m = line.message
      const id = typeof m?.id === 'string' ? m.id : undefined
      const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN
      if (!m?.usage || !id || seen.has(id) || !(at >= from && at <= to)) continue
      seen.add(id)
      const u = m.usage
      const input = num(u.input_tokens)
      const output = num(u.output_tokens)
      const cacheRead = num(u.cache_read_input_tokens)
      const cacheWrite = num(u.cache_creation_input_tokens)
      usage.calls += 1
      usage.inputTokens += input
      usage.outputTokens += output
      usage.cacheReadTokens += cacheRead
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite
      const price = typeof m.model === 'string' ? priceForModel(m.model) : undefined
      if (price) {
        micros += input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite
        pricedModels.add(m.model as string)
      } else priced = false
    }
  }
  if (usage.calls === 0) return undefined
  const rateDate = '2026-09-25'
  return priced
    ? { ...usage, usd: Math.round(micros) / 1e6, source: 'claude_transcript', rateDate, priceVersion: `${[...pricedModels].sort().join('+')}/${rateDate}` }
    : { ...usage, source: 'claude_transcript' }
}
