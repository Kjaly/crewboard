import type { RunBackend, RunUsage } from '../backend/types.js'
import type { Run } from '../plan/schema.js'
import { isClaudeAgent } from './claude-limits.js'
import { readClaudeTranscriptUsage } from './claude-transcripts.js'

/** Backend-reported usage first; Claude runs without it fall back to Claude Code transcripts of their worktree. */
export async function usageForRun(backend: RunBackend | undefined, run: Run, cwd: string | undefined, projectsDir: string): Promise<RunUsage | undefined> {
  const direct = backend?.usage ? await backend.usage(run.runId).catch(() => undefined) : undefined
  if (direct) return direct
  if (!cwd || !isClaudeAgent(run.agent)) return undefined
  return readClaudeTranscriptUsage(projectsDir, cwd, { startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) })
}
