import { cliKindOf } from '../backend/types.js'
import type { RunBackend, RunUsage } from '../backend/types.js'
import type { Run } from '../plan/schema.js'
import { isClaudeAgent } from './claude-limits.js'
import { readClaudeTranscriptUsage } from './claude-transcripts.js'
import { codexApiEquivalentUsd } from './codex-pricing.js'

/**
 * Backend-reported usage first; Claude runs without it fall back to Claude Code transcripts of their
 * worktree. A Codex run whose CLI did not report its own dollar figure (subscription, not an API key) gets
 * an API-rate estimate from its token counts instead (cs1) — never a guessed $0 when the model is unknown.
 */
export async function usageForRun(backend: RunBackend | undefined, run: Run, cwd: string | undefined, projectsDir: string): Promise<RunUsage | undefined> {
  const direct = backend?.usage ? await backend.usage(run.runId).catch(() => undefined) : undefined
  if (direct) {
    if (direct.usd === undefined && direct.apiEquivalentUsd === undefined && direct.calls > 0 && cliKindOf(run.agent) === 'codex') {
      const priced = codexApiEquivalentUsd(run.model, direct)
      if (priced) return { ...direct, apiEquivalentUsd: priced.usd, source: 'codex_rate_estimate', rateDate: priced.rateDate, priceVersion: priced.priceVersion }
    }
    return direct
  }
  if (!cwd || !isClaudeAgent(run.agent)) return undefined
  return readClaudeTranscriptUsage(projectsDir, cwd, { startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) })
}
