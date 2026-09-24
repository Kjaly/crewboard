import { t, relativeTime } from './i18n.js'
import { canonicalWorkerId, type TaskSnapshot, type WorkerInfo } from '../shared/types.js'

export type ProviderIdentity = {
  provider: 'DeepSeek' | 'Claude' | 'Codex' | 'Devin' | '\u0414\u0440\u0443\u0433\u0438\u0435'
  mark: 'DS' | 'CL' | 'CX' | 'DV' | '··'
  model: string
  label?: string
}

// Settings-side twin: host/actions.ts describes the same direct workers for the settings screen.
const MODELS: Record<string, ProviderIdentity> = {
  'dsh/deepseek-flash': { provider: 'DeepSeek', mark: 'DS', model: 'DeepSeek V4 Flash' },
  'claude/opus': { provider: 'Claude', mark: 'CL', model: 'Opus 5' },
  'claude/fable': { provider: 'Claude', mark: 'CL', model: 'Fable 5.1' },
  'codex/gpt-6-astra': { provider: 'Codex', mark: 'CX', model: 'GPT-6 Astra' },
  'codex/gpt-6-sol': { provider: 'Codex', mark: 'CX', model: 'GPT-6 Sol' },
  'codex/gpt-6-luna': { provider: 'Codex', mark: 'CX', model: 'GPT-6 Luna' },
  'codex/gpt-5.6-sol': { provider: 'Codex', mark: 'CX', model: 'GPT-5.6 Sol' },
  'codex/gpt-5.6-terra': { provider: 'Codex', mark: 'CX', model: 'GPT-5.6 Terra' },
  'codex/gpt-5.6-luna': { provider: 'Codex', mark: 'CX', model: 'GPT-5.6 Luna' },
  devin: { provider: 'Devin', mark: 'DV', model: 'SWE-2' },
}

export function workerIdentity(id: string | undefined, workers?: readonly WorkerInfo[]): ProviderIdentity {
  if (!id) return { provider: '\u0414\u0440\u0443\u0433\u0438\u0435', mark: '··', model: t('panel.workerUnset') }
  const canonical = id === 'dsh' ? 'dsh/deepseek-flash' : canonicalWorkerId(id)
  const resolved = workers?.find((worker) => worker.id === canonical)
  if (resolved) {
    const mark = resolved.provider === 'DeepSeek' ? 'DS' : resolved.provider === 'Claude' ? 'CL' : resolved.provider === 'Codex' ? 'CX' : resolved.provider === 'Devin' ? 'DV' : '··'
    return { provider: resolved.provider, mark, model: resolved.label, label: resolved.label }
  }
  return MODELS[canonical]
    ?? { provider: '\u0414\u0440\u0443\u0433\u0438\u0435', mark: '··', model: id }
}

/** Who does a task: the orchestrator for its own work (rt1), never «no worker assigned»; else the worker. */
export function taskIdentity(task: Pick<TaskSnapshot, 'kind' | 'worker'>, workers?: readonly WorkerInfo[], agent?: string): ProviderIdentity {
  if (task.kind === 'root') return { provider: '\u0414\u0440\u0443\u0433\u0438\u0435', mark: '··', model: t('status.orchestrator'), label: t('status.orchestrator') }
  return workerIdentity(agent ?? task.worker, workers)
}

export function identityLabel(identity: ProviderIdentity): string {
  if (identity.label) return identity.label
  return identity.provider === '\u0414\u0440\u0443\u0433\u0438\u0435' || identity.model.startsWith(identity.provider)
    ? identity.model : `${identity.provider} ${identity.model}`
}

/** Elapsed run duration, with the compact units shown in the live task UI. */
export function runDuration(from: string | undefined, now: Date = new Date()): string | undefined {
  if (!from) return undefined
  const ms = now.getTime() - Date.parse(from)
  if (!Number.isFinite(ms) || ms < 0) return undefined
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return t('panel.run.seconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('panel.run.minutes', { count: minutes })
  return t('panel.run.hoursMinutes', { count: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0') })
}

/** Snapshot exposes the start of a live run and the acceptance time, but no run completion time. */
export function runFact(task: TaskSnapshot, now: Date = new Date()): string {
  if (task.runs === 0 && task.status !== 'running') return '—'
  const from = task.status === 'running' ? task.activeSince : task.acceptedAt
  if (task.status === 'running') return runDuration(from, now) ?? '—'
  if (!from || !Number.isFinite(Date.parse(from)) || Date.parse(from) > now.getTime()) return '—'
  return relativeTime(new Date(from), now)
}

/** Folder name a vendor mark is looked up by: packages/plugin/assets/vendors/<slug>.svg */
export const vendorSlug = (identity: ProviderIdentity): string | undefined =>
  identity.provider === 'DeepSeek' ? 'deepseek'
  : identity.provider === 'Claude' ? 'claude'
  : identity.provider === 'Codex' ? 'codex'
  : identity.provider === 'Devin' ? 'devin'
  : undefined
