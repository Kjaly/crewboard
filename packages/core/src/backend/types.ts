import type { RunState } from '../plan/graph.js'
import type { RawEvent } from '../runs/raw-event.js'

/**
 * `readOnly`: the worker may read `cwd` but not change it (a draft, dr2); only a backend with `readOnlyLaunch` honours it.
 * `effort` (ef1): the CLI's effort level; absent — the CLI's default. dsh and Devin take none and ignore it.
 */
export type LaunchInput = { agent: string; promptFile: string; cwd: string; model?: string; effort?: string; readOnly?: boolean }

export type RunUsage = {
  sessionId?: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  usd?: number
  pending?: boolean
  availability?: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'cash' | 'apiEquivalent', MetricAvailability>>
  observedAt?: string
  source?: string
  final?: boolean
  cacheWriteTokens?: number
  apiEquivalentUsd?: number
  cashSourceId?: string
  rateDate?: string
  priceVersion?: string
  reasoningIncludedInOutput?: boolean
}

export type MetricAvailability = { value?: number; state: 'known' | 'partial' | 'pending' | 'unavailable' | 'notApplicable'; observedAt?: string; source?: string; final?: boolean }

/** One way to run a worker. dsh drives DeepSeek Harness over ACP. */
export type RunBackend = {
  readonly id: 'dsh' | 'claude' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'grok' | 'devin' | 'legacy' | 'example'
  /**
   * The CLI itself can run without write access (Claude's plan permission mode, Codex's read-only sandbox), so
   * `launch({ readOnly: true })` is enforced by the worker's own tool. Without it a caller that needs a read-only
   * run gives the worker a throwaway copy instead (plan/draft-jobs.ts).
   */
  readonly readOnlyLaunch?: boolean
  launch(input: LaunchInput): Promise<string>
  events(runId: string): Promise<RawEvent[]>
  status(runId: string): Promise<RunState>
  steer(runId: string, promptFile: string, mode?: 'auto' | 'queue' | 'interrupt', steerId?: string): Promise<void>
  cancel(runId: string): Promise<void>
  usage?(runId: string): Promise<RunUsage | undefined>
}

export const isDshAgent = (agent: string): boolean => agent === 'dsh' || agent.startsWith('dsh/')
export const dshModel = (agent: string): string | undefined => (agent.startsWith('dsh/') ? agent.slice(4) : undefined)

/** Direct CLI workers: `<kind>/<model>` runs that kind's CLI (rb1: opencode, cursor, gemini, grok join claude, codex). */
export type DirectCliKind = 'claude' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'grok'
const DIRECT_CLI_KINDS: readonly DirectCliKind[] = ['claude', 'codex', 'opencode', 'cursor', 'gemini', 'grok']
export const cliKindOf = (agent: string): DirectCliKind | undefined => DIRECT_CLI_KINDS.find((kind) => agent.startsWith(`${kind}/`))
export const cliModel = (agent: string): string | undefined => {
  const slash = agent.indexOf('/')
  return slash >= 0 ? agent.slice(slash + 1) || undefined : undefined
}

/**
 * Agent ids `orchestration/backends.ts` `forAgent` actually knows how to launch: `claude/…`, `codex/…`,
 * `opencode/…`, `cursor/…`, `gemini/…`, `grok/…`, `dsh`/`dsh/…`, and the single literal `devin` (rb1). A
 * custom id `forAgent` does not recognise preflights clean and then fails at launch with "no backend" (rq1):
 * excluded from the default preset's automatic pick, which only offers ids this repository can actually start.
 */
export const isRunnableAgent = (agent: string): boolean => agent === 'devin' || cliKindOf(agent) !== undefined || isDshAgent(agent)
