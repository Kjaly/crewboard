import type { Attention, OrchestraSnapshot, RepoSnapshot, TaskSnapshot, ViewStatus } from '../shared/types.js'
import { t } from './i18n.js'

export const STATUS_GLYPH: Record<ViewStatus, string> = { backlog: '·', ready: '○', running: '●', in_review: '◐', accepted: '✓', closed: '○', blocked: '⏸', superseded: '⊘', dropped: '⊘' }
export const STATUS_LABEL: Record<ViewStatus, string> = {
  get backlog() { return t('panel.status.backlog') },
  get ready() { return t('panel.status.ready') },
  get running() { return t('panel.status.running') },
  get in_review() { return t('panel.status.inReview') },
  get accepted() { return t('panel.status.accepted') },
  get closed() { return t('status.closedNegative') },
  get blocked() { return t('panel.status.blocked') },
  get superseded() { return t('panel.status.superseded') },
  get dropped() { return t('panel.status.dropped') },
}

/** The unreadable plan in the screen's language when the host named why; else the host's message. */
export function repoError(repo: Pick<RepoSnapshot, 'error' | 'errorCode'>): string | undefined {
  return repo.errorCode === 'plan_incompatible' ? t('panel.planError.incompatible') : repo.error
}

export function repoHeadline(repo: RepoSnapshot): string {
  if (repo.hasPlan === false) return t('panel.headline.empty')
  if (repo.degraded && repo.error) return `⚠ ${repoError(repo)}`
  if (repo.tasks.length === 0) return t('panel.headline.empty')
  const count = (s: ViewStatus) => repo.tasks.filter((t) => t.status === s).length
  const parts = [t('panel.headline.tasks', { count: repo.tasks.length })]
  const running = count('running')
  const review = count('in_review')
  const human = repo.tasks.filter((t) => t.needsHuman).length
  if (running) parts.push(t('panel.headline.running', { count: running }))
  if (review) parts.push(t('panel.headline.review', { count: review }))
  if (human) parts.push(t('panel.headline.decisions', { count: human }))
  if (repo.attention.length) parts.push(t('panel.headline.attention', { count: repo.attention.length }))
  return parts.join(' · ')
}

export function attentionCount(snapshot: OrchestraSnapshot): number {
  return snapshot.repos.reduce((n, r) => n + r.attention.length, 0)
}

/** Elapsed duration since an ISO timestamp. */
export function sinceLabel(from: string | undefined, now: Date = new Date()): string | undefined {
  if (!from) return undefined
  const ms = now.getTime() - Date.parse(from)
  if (!Number.isFinite(ms) || ms < 0) return undefined
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return t('panel.duration.seconds', { count: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('panel.duration.minutes', { count: min })
  return t('panel.duration.hoursMinutes', { count: Math.floor(min / 60), minutes: String(min % 60).padStart(2, '0') })
}

/** Wall clock of an event, as shown in the feed. */
export function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A failure the runner named (B01, B19), in the reader's language; the core text is only its fallback. */
export function failureText(reason: NonNullable<Attention['reason']>): string {
  if (reason.code === 'rate_limited') return reason.resetsAt ? t('failure.rateLimited', { time: clock(reason.resetsAt) }) : t('failure.rateLimitedNoTime')
  if (reason.workerPid === undefined) return t('failure.interrupted')
  return reason.workerStopped ? t('failure.interruptedStopped', { pid: reason.workerPid }) : t('failure.interruptedGone', { pid: reason.workerPid })
}

const joinParts = (parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ')

/** The single line of substance under a task title: state, worker, how long it has been going. */
export function taskEssence(task: TaskSnapshot, now: Date = new Date()): string {
  // Waiting for a merge is not waiting for work (w1d): the dependency is done, its code is not in the base yet.
  if (task.status === 'blocked' && task.waitingMerge?.length === task.blockedBy.length) return t('panel.essence.waitingMerge', { tasks: task.blockedBy.join(', ') })
  if (task.status === 'blocked' && task.blockedBy.length > 0) return t('panel.essence.blockedBy', { tasks: task.blockedBy.join(', ') })
  if (task.unmerged) return t('panel.essence.unmerged')
  // A human decision has no worker or model: its only facts are whose turn and when it was taken.
  if (task.kind === 'decision') {
    if (task.status === 'accepted') return task.acceptedAt ? t('panel.essence.decisionAcceptedAt', { time: clock(task.acceptedAt) }) : t('panel.essence.decisionAccepted')
    // Not the person's turn until the orchestrator prepared it (rt1).
    if (task.preparing) return t('panel.essence.preparing')
    if (task.needsHuman) return t('panel.essence.decisionYours')
  }
  // The orchestrator's own work (rt1): no worker, no model — whose hands it is in, and since when.
  if (task.byOrchestrator) return joinParts([t('panel.essence.byOrchestrator'), sinceLabel(task.activeSince, now)])
  if (task.kind === 'root' && task.status === 'ready') return t('panel.essence.rootReady')
  return joinParts([
    STATUS_LABEL[task.status],
    task.worker,
    task.status === 'running' ? sinceLabel(task.activeSince, now) : undefined,
    task.needsHuman ? t('panel.essence.decisionYours') : undefined,
  ])
}

/** One phrase for the current state block: what is happening and why it matters. */
export function nowPhrase(task: TaskSnapshot, attention: Attention[], now: Date = new Date()): { text: string; hint?: string; tone: 'plain' | 'warn' | 'alert' } {
  const alert = attention.find((a) => a.severity === 'alert') ?? attention[0]
  if (alert?.reason) return { text: failureText(alert.reason), hint: alert.reason.code === 'rate_limited' ? t('failure.rateLimitedHint') : alert.hint, tone: 'alert' }
  if (alert) return { text: alert.message, hint: alert.hint, tone: alert.severity === 'alert' ? 'alert' : 'warn' }
  // A decision still waiting for its tasks is not the human's turn yet: say what it waits for.
  if (task.kind === 'decision' && task.status === 'blocked' && task.blockedBy.length > 0) {
    return { text: t('panel.now.decisionBlocked', { tasks: task.blockedBy.join(', ') }), tone: 'plain' }
  }
  if (task.preparing) return { text: t('panel.now.preparing'), hint: t('panel.now.preparingHint'), tone: 'plain' }
  if (task.needsHuman) return { text: t('panel.now.decisionYours'), tone: 'warn' }
  if (task.byOrchestrator) {
    const time = sinceLabel(task.activeSince, now)
    return { text: joinParts([t('panel.now.byOrchestrator'), time ? t('panel.now.elapsed', { time }) : undefined]), hint: t('panel.now.byOrchestratorHint'), tone: 'plain' }
  }
  if (task.kind === 'root' && task.status === 'ready') return { text: t('panel.now.rootReady'), tone: 'plain' }
  switch (task.status) {
    case 'running': {
      const time = sinceLabel(task.activeSince, now)
      return { text: joinParts([t('panel.now.working', { worker: task.worker ?? t('panel.worker') }), time ? t('panel.now.elapsed', { time }) : undefined]), tone: 'plain' }
    }
    case 'in_review':
      return { text: t('panel.now.inReview'), hint: t('panel.now.reviewHint'), tone: 'warn' }
    case 'ready':
      return { text: t('panel.now.ready'), tone: 'plain' }
    case 'blocked':
      if (task.waitingMerge?.length) {
        const others = task.blockedBy.filter((id) => !task.waitingMerge?.includes(id))
        return { text: joinParts([others.length ? t('panel.now.blocked', { tasks: others.join(', ') }) : undefined, t('panel.now.waitingMerge', { tasks: task.waitingMerge.join(', ') })]), hint: t('panel.now.waitingMergeHint'), tone: 'plain' }
      }
      return { text: t('panel.now.blocked', { tasks: task.blockedBy.join(', ') || '—' }), tone: 'plain' }
    case 'accepted':
      if (task.unmerged) return { text: t('panel.now.acceptedUnmerged'), hint: t('panel.now.acceptedUnmergedHint'), tone: 'warn' }
      if (task.kind === 'decision') return { text: task.acceptedAt ? t('panel.now.decisionAcceptedAt', { time: clock(task.acceptedAt) }) : t('panel.now.decisionAccepted'), tone: 'plain' }
      return { text: t('panel.now.accepted'), tone: 'plain' }
    case 'closed':
      return { text: t('status.closedNegative'), tone: 'plain' }
    case 'superseded':
      return { text: t('panel.now.superseded'), tone: 'plain' }
    case 'dropped':
      return { text: t('panel.now.dropped'), tone: 'plain' }
    default:
      return { text: t('panel.now.backlog'), tone: 'plain' }
  }
}
