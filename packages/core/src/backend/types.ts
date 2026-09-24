import type { RunState } from '../plan/graph.js'
import type { RawEvent } from '../runs/raw-event.js'

export type LaunchInput = { agent: string; promptFile: string; cwd: string; model?: string }

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
  readonly id: 'dsh' | 'claude' | 'codex' | 'devin' | 'legacy' | 'example'
  launch(input: LaunchInput): Promise<string>
  events(runId: string): Promise<RawEvent[]>
  status(runId: string): Promise<RunState>
  steer(runId: string, promptFile: string, mode?: 'auto' | 'queue' | 'interrupt', steerId?: string): Promise<void>
  cancel(runId: string): Promise<void>
  usage?(runId: string): Promise<RunUsage | undefined>
}

export const isDshAgent = (agent: string): boolean => agent === 'dsh' || agent.startsWith('dsh/')
export const dshModel = (agent: string): string | undefined => (agent.startsWith('dsh/') ? agent.slice(4) : undefined)

/** Direct CLI workers: `claude/<model>` runs Claude Code, `codex/<model>` runs Codex, both. */
export const cliKindOf = (agent: string): 'claude' | 'codex' | undefined =>
  agent.startsWith('claude/') ? 'claude' : agent.startsWith('codex/') ? 'codex' : undefined
export const cliModel = (agent: string): string | undefined => {
  const slash = agent.indexOf('/')
  return slash >= 0 ? agent.slice(slash + 1) || undefined : undefined
}
