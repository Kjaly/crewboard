import type { Backend } from '../preflight/preflight.js'
import type { WorkerKind } from './registry.js'

/**
 * The effort levels each worker CLI accepts (ef1). Claude Code takes `--effort <level>` (`claude --help`,
 * 2.1.280+); Codex takes `-c model_reasoning_effort=<level>` (its config's `ReasoningEffort`, codex-cli 0.155).
 * OpenCode takes `--variant <level>` (`opencode run --help`, 1.18.30 — provider-specific, so this list is the
 * common set rather than an exhaustive one). Grok CLI takes `--reasoning-effort <level>` (docs.x.ai/build/cli,
 * not installed here — unverified). dsh, Devin, Cursor Agent and Gemini CLI take none: an effort registered
 * for them never reaches a run, and nothing shows it.
 */
export const EFFORT_LEVELS: Partial<Record<Backend, readonly string[]>> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex-cli': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  opencode: ['minimal', 'low', 'medium', 'high', 'max'],
  'grok-build': ['low', 'medium', 'high'],
}

const KIND_BACKEND: Partial<Record<WorkerKind, Backend>> = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build' }

export const takesEffort = (backend: Backend): boolean => EFFORT_LEVELS[backend] !== undefined

/** The effort a run of this backend gets: the stored one where the CLI takes an effort, else none. */
export const runEffort = (backend: Backend, effort: string | undefined): string | undefined =>
  effort?.trim() && takesEffort(backend) ? effort.trim() : undefined

/** The effort a registered worker runs with (its kind decides the CLI). */
export const entryEffort = (entry: { kind: WorkerKind; effort?: string }): string | undefined => {
  const backend = KIND_BACKEND[entry.kind]
  return backend ? runEffort(backend, entry.effort) : undefined
}

/** A worker's name where workers are listed: «Claude Sonnet 5 · high»; a label that already says it stays as is. */
export const workerLabel = (label: string, effort: string | undefined): string =>
  effort && !label.endsWith(` · ${effort}`) ? `${label} · ${effort}` : label
