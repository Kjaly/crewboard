import type { NormEvent } from '@crewboard/core'
import type { Attention, OrchestraSnapshot, RepoSnapshot, TaskSnapshot, ViewStatus } from '../shared/types.js'
import { ownHalf, t } from './i18n.js'

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
  return repo.errorCode === 'plan_incompatible' ? t('panel.planError.incompatible') : repo.error && ownHalf(repo.error)
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

/** A failure the runner named (B01, B19, fo1), in the reader's language; the core text is only its fallback. */
export function failureText(reason: NonNullable<Attention['reason']>): string {
  switch (reason.code) {
    case 'rate_limited': return reason.resetsAt ? t('failure.rateLimited', { time: clock(reason.resetsAt) }) : t('failure.rateLimitedNoTime')
    case 'auth_expired': return t('failure.authExpired')
    case 'disk_full': return t('failure.diskFull')
    case 'setup_failed': return reason.step ? t('failure.setupFailed', { step: reason.step }) : t('failure.setupFailedNoStep')
    case 'baseline_red': return reason.step ? t('failure.baselineRed', { step: reason.step }) : t('failure.baselineRedNoStep')
    case 'worker_error': return t('failure.workerError')
    case 'interrupted':
      if (reason.workerPid === undefined) return t('failure.interrupted')
      return reason.workerStopped ? t('failure.interruptedStopped', { pid: reason.workerPid }) : t('failure.interruptedGone', { pid: reason.workerPid })
  }
}

/** A feed line in the reader's language: a failure or a runner note from its code (fo1, B33), else the text as written. */
export function eventText(event: Pick<NormEvent, 'text' | 'reason' | 'note'>): string {
  if (event.reason) return failureText(event.reason)
  if (event.note) return t(`feed.runner.${event.note.code}`, { detail: event.note.detail ?? '' })
  return event.text
}

/** What to do about a failure, when there is something beyond «try again». */
export function failureHint(reason: NonNullable<Attention['reason']>): string | undefined {
  if (reason.code === 'rate_limited') return t('failure.rateLimitedHint')
  if (reason.code === 'auth_expired') return reason.login ? t('failure.authExpiredHint', { command: reason.login }) : t('failure.authExpiredDsh')
  if (reason.code === 'disk_full') return t('failure.diskFullHint')
  return undefined
}

/** A limit or an interrupted supervisor is said in full by its reason; other failures add the worker's own words. */
const ownWords = (reason: NonNullable<Attention['reason']>) => reason.code !== 'rate_limited' && reason.code !== 'interrupted'

/** An alarm about a run in the reader's language, from its kind and parameters (fo1, B33); `message` is the fallback. */
export function attentionText(a: Pick<Attention, 'kind' | 'message' | 'reason' | 'detail' | 'seconds' | 'idleMin' | 'command' | 'severity' | 'count' | 'repeated' | 'incomplete'>): string {
  switch (a.kind) {
    case 'failed': return a.reason ? `${failureText(a.reason)}${a.detail && ownWords(a.reason) ? ` — ${a.detail}` : ''}` : a.message
    case 'not_started': return a.seconds === undefined ? a.message : t('attention.notStarted', { seconds: a.seconds })
    case 'running': return a.idleMin === undefined ? a.message : t(a.severity === 'alert' ? 'attention.runningStuck' : 'attention.running', { count: a.idleMin, command: a.command ?? '' })
    case 'stalled': return a.idleMin === undefined ? a.message : t(a.severity === 'alert' ? 'attention.stalledStuck' : 'attention.stalled', { count: a.idleMin })
    case 'loop': return a.count === undefined ? a.message : t('attention.loop', { count: a.count, action: a.repeated ?? '' })
    case 'steer_no_effect': return a.idleMin === undefined ? a.message : t('attention.steerNoEffect', { count: a.idleMin })
    case 'worker_gone': return t('attention.workerGone')
    case 'incomplete': return a.incomplete ? t(`attention.incomplete.${a.incomplete.reason}`, { count: a.incomplete.uncommitted }) : a.message
  }
}

const INCOMPLETE_KEY = {
  no_report: 'panel.task.incompleteNoReport',
  no_claim: 'panel.task.incompleteNoClaim',
  left_uncommitted: 'panel.task.incompleteLeftUncommitted',
} as const

/** Why the task's last run ended `incomplete` (bg1, cm1), in the reader's language. */
export function incompleteText(incomplete: Pick<NonNullable<TaskSnapshot['incomplete']>, 'reason' | 'uncommitted'> | undefined): string {
  return t(INCOMPLETE_KEY[incomplete?.reason ?? 'no_report'], { count: incomplete?.uncommitted ?? 0 })
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
// A command still running, or a short quiet spell, is information (st2, bg1) — not a warning; only once
// either outlasts its «may be stuck» threshold does `evaluateRun` raise its severity to `alert`.
const isInfoOnly = (a: Attention) => (a.kind === 'running' || a.kind === 'stalled') && a.severity !== 'alert'

export function nowPhrase(task: TaskSnapshot, attention: Attention[], now: Date = new Date()): { text: string; hint?: string; tone: 'plain' | 'warn' | 'alert' } {
  const alert = attention.find((a) => a.severity === 'alert') ?? attention[0]
  if (alert?.reason) return { text: attentionText(alert), hint: failureHint(alert.reason) ?? alert.hint, tone: 'alert' }
  if (alert) return { text: attentionText(alert), hint: alert.hint, tone: alert.severity === 'alert' ? 'alert' : isInfoOnly(alert) ? 'plain' : 'warn' }
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
      if (task.kind === 'decision') {
        // dc1: a chat-recorded answer shows what the person answered and where they said it.
        const answered = task.lastDecision?.verdict === 'answered' && task.lastDecision.answer ? task.lastDecision : undefined
        return {
          text: answered ? t('panel.now.decisionAnswered', { answer: answered.answer ?? '' }) : task.acceptedAt ? t('panel.now.decisionAcceptedAt', { time: clock(task.acceptedAt) }) : t('panel.now.decisionAccepted'),
          hint: answered?.basis ? t('panel.now.decisionBasis', { basis: answered.basis }) : undefined,
          tone: 'plain',
        }
      }
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
