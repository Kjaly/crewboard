/**
 * The run menu's worker list. `claude/<model>` and `codex/<model>` are direct CLI backends —
 * and Devin also stream a live feed.
 */
import { canonicalWorkerId, type WorkerInfo } from '../shared/types.js'

export const WORKERS = ['dsh', 'claude/opus', 'claude/fable', 'codex/gpt-6-astra', 'codex/gpt-6-sol', 'codex/gpt-6-luna', 'devin']

/** A saved Claude alias becomes its direct backend: `claude-opus` runs as `claude/opus`. */
export const directWorker = (agent: string): string => canonicalWorkerId(agent)

/** Selectable workers: the task's own (mapped to its direct backend) plus the house list. */
export function workerOptions(current: string, workers?: readonly WorkerInfo[]): string[] {
  return [...new Set([directWorker(current), ...(workers ? workers.filter((worker) => worker.main).map((worker) => worker.id) : WORKERS)])]
}

/** Who decides a task's worker: an assignment's source, else the preset. */
export type WorkerChoice = 'person' | 'agent' | 'preset'
export const workerChoiceOf = (task: { workerSource?: 'person' | 'agent' }): WorkerChoice => task.workerSource ?? 'preset'

/** A person's assignment outside the current preset — the graph and the panel mark it. */
export const isHandPicked = (task: { workerSource?: 'person' | 'agent'; outsidePreset?: boolean }): boolean => task.workerSource === 'person' && !!task.outsidePreset

/** Tasks whose assigned worker the current preset does not route to (the header's «N outside preset»). */
export const outsidePresetTasks = <T extends { outsidePreset?: boolean }>(tasks: readonly T[]): T[] => tasks.filter((task) => task.outsidePreset)
