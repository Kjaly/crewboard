import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crewboardEnv } from '../env.js'

// Written by ~/.claude/statusline-usage.py from the Claude Code status line payload
// (rate_limits.seven_day.used_percentage): one JSON row per change while an interactive session is open.

export const claudeLimitsPath = (env: NodeJS.ProcessEnv, home: string): string => crewboardEnv(env, 'CLAUDE_LIMITS') ?? join(home, '.claude', 'usage', 'rate-limits.jsonl')

/** Saved profiles (claude-opus, claude-fable…) and direct workers (claude/opus) both count against the Claude subscription. */
export const isClaudeAgent = (agent: string): boolean => agent.startsWith('claude')

export async function latestClaudeWeeklyPct(file: string): Promise<number | undefined> {
  const raw = await readFile(file, 'utf8').catch(() => '')
  let latest: number | undefined
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { seven_day?: unknown }
      if (typeof row.seven_day === 'number') latest = row.seven_day
    } catch {
      // a half-written or foreign line does not stop the reading
    }
  }
  return latest
}
