import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunUsage } from '../backend/types.js'
import { crewboardEnv } from '../env.js'

// Claude Code keeps one transcript directory per working directory: ~/.claude/projects/<slug>/<session>.jsonl.

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
/** USD per 1M tokens — https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-22). */
const PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
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
      const price = typeof m.model === 'string' ? PRICES[m.model] : undefined
      if (price) micros += input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite
      else priced = false
    }
  }
  if (usage.calls === 0) return undefined
  return priced ? { ...usage, usd: Math.round(micros) / 1e6, source: 'claude_transcript', rateDate: '2026-09-22', priceVersion: 'claude-opus-5/2026-09-22' } : { ...usage, source: 'claude_transcript' }
}
