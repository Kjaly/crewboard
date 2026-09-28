import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Attention, TaskDetail, TaskSnapshot } from '../../shared/types.js'
import type { ToolDetail } from '@crewboard/core'
import { t, useLang } from '../i18n.js'
import { attentionText, eventText, sinceLabel } from '../summary.js'
import { Conversation, toolMeaning } from './conversation.js'
import { BOTTOM_THRESHOLD_PX, overlapCount, streamGrew } from './feed-window.js'

export { BOTTOM_THRESHOLD_PX, eventSignature, overlapCount, stabilizeGroupKeys, streamGrew } from './feed-window.js'

type Run = TaskDetail['runs'][number]
type Event = TaskDetail['events'][number]

/** Only the latest, unfinished, non-terminal run of a running task is alive; anything else reads as history. */
export function runIsLive(task: Pick<TaskSnapshot, 'status' | 'lastRunId'>, runs: readonly Run[], run: Run | undefined): boolean {
  return !!run && !run.finishedAt && !run.outcome && task.status === 'running' && runs.at(-1)?.runId === run.runId && (!task.lastRunId || task.lastRunId === run.runId)
}

export type ActivityPhase =
  /** The last reported step is still open: a known operation and target, or the actual reported action. */
  | { kind: 'working'; step: string; tool?: ToolDetail }
  /** The run is live between steps: the last finished step and how long ago the feed last moved. */
  | { kind: 'active'; lastStep?: string; lastTool?: ToolDetail; lastAt: string }
  /** A live run whose feed has not reported its first event yet. */
  | { kind: 'starting' }
  /** A run-level problem (a permission request, an interruption, a limit) — never inferred from a tool error. */
  | { kind: 'problem'; text: string }
  | { kind: 'terminal'; outcome?: Run['outcome'] }
  | { kind: 'past' }

/**
 * What the run is doing right now. An open action/file event (st2) is the current reported step; between
 * steps a live run is *active* with the last finished step and its age — not «waiting for updates», and never
 * a finished tool presented as still running. A run-level problem stays visible as itself; a tool error is a
 * step inside the technical disclosure and never turns the task into a failure. A finished run reports its
 * own outcome.
 */
export function activityPhase(task: Pick<TaskSnapshot, 'status' | 'lastRunId'>, runs: readonly Run[], run: Run | undefined, events: readonly Event[] = []): ActivityPhase {
  if (!run) return { kind: 'past' }
  // A recorded outcome is terminal even when a legacy/stale snapshot omits `finishedAt`.
  if (run.finishedAt || run.outcome) return { kind: 'terminal', ...(run.outcome ? { outcome: run.outcome } : {}) }
  if (!runIsLive(task, runs, run)) return { kind: 'past' }
  if (events.length === 0) return { kind: 'starting' }
  const open = [...events].reverse().find((event) => event.open)
  if (open) return { kind: 'working', step: eventText(open), ...(open.tool ? { tool: open.tool } : {}) }
  const last = events.at(-1)!
  if (last.kind === 'problem' && last.origin !== 'tool') return { kind: 'problem', text: eventText(last) }
  const lastStep = [...events].reverse().find((event) => event.kind === 'action' || event.kind === 'file' || event.kind === 'problem')
  // The age is the last real chunk/step time, never the moment this snapshot happened to be fetched.
  return { kind: 'active', ...(lastStep ? { lastStep: eventText(lastStep), ...(lastStep.tool ? { lastTool: lastStep.tool } : {}) } : {}), lastAt: last.updatedAt ?? last.ts }
}

function ActivityStatus({ phase, live, report, alert, newCount, onOpenReport }: { phase: ActivityPhase; live: boolean; report: boolean; alert?: Attention; newCount: number; onOpenReport?(): void }) {
  const label =
    alert ? attentionText(alert)
    : phase.kind === 'working' ? t('panel.activity.working')
    : phase.kind === 'active' ? t('panel.activity.active')
    : phase.kind === 'starting' ? t('panel.activity.starting')
    : phase.kind === 'problem' ? t('panel.activity.problem')
    : phase.kind === 'terminal' ? (phase.outcome ? t(`panel.tabs.outcome.${phase.outcome}`) : t('panel.activity.finishedUnknown'))
    : t('panel.activity.earlier')
  const step = phase.kind === 'working' ? (phase.tool ? toolMeaning(phase.tool) : phase.step) : undefined
  const age = phase.kind === 'active' ? sinceLabel(phase.lastAt) : undefined
  return (
    <div className="orc-live__status" role="status" aria-live="polite" data-phase={phase.kind} data-alert={alert ? 'true' : 'false'}>
      <span className={`orc-live__dot${live && !alert ? ' orc-live__dot--live' : ''}`} aria-hidden="true" />
      <span className="orc-live__label">{label}</span>
      {step !== undefined ? <code className="orc-live__step" title={step}>{step}</code> : null}
      {phase.kind === 'active' && phase.lastStep ? <code className="orc-live__step" title={phase.lastStep}>{t('panel.activity.lastStep', { step: phase.lastStep })}</code> : null}
      {age ? <span className="orc-live__age">{age}</span> : null}
      {phase.kind === 'problem' ? <span className="orc-live__problem">{phase.text}</span> : null}
      {phase.kind === 'terminal' && report && onOpenReport ? (
        <button type="button" className="orc-run__link orc-live__report" onClick={onOpenReport}>{t('panel.activity.openReport')}</button>
      ) : null}
      {newCount > 0 ? <span className="orc-sr-only">{t('panel.activity.newEvents', { count: newCount })}</span> : null}
    </div>
  )
}

/**
 * The live end of the Activity tab: the truthful Now region, the conversation, and following that respects a
 * reader who scrolled up. It owns no scroll container of its own — it drives the panel's existing
 * `.orc-panel__scroll` through `scrollRef`, so there is never a second feed viewport to fight.
 */
export function LiveActivity({
  detail,
  task,
  run,
  scrollRef,
  attention,
  onOpenReport,
  position,
  onPosition,
}: {
  detail: TaskDetail
  task: TaskSnapshot
  run: Run
  scrollRef: RefObject<HTMLElement | null>
  attention?: readonly Attention[]
  onOpenReport?(): void
  /** The session-remembered reading position of this task's feed (window memory only). */
  position?: { anchor?: string; anchorOffset?: number; offset?: number; follow?: boolean }
  /** Reports the feed's reading position back to that memory. */
  onPosition?(pos: { anchor?: string; anchorOffset?: number; offset: number; follow: boolean }): void
}) {
  useLang()
  const events = detail.events ?? []
  const runs = detail.runs ?? []
  const phase = activityPhase(task, runs, run, events)
  const live = runIsLive(task, runs, run)
  const alert = attention?.find((item) => item.severity === 'alert')

  const previous = useRef(events)
  const atBottom = useRef(true)
  const [newCount, setNewCount] = useState(0)
  const [freshFrom, setFreshFrom] = useState<number | undefined>(undefined)
  // The pulse is decoration: pause it whenever the page is hidden, live run or not.
  const [paused, setPaused] = useState(false)
  // The feed's reading position (a turn anchor, the viewport's offset within it, a fallback offset and the
  // follow state) is written back to the task's window-session memory. The geometry is captured synchronously
  // on every scroll; only the notification is throttled, so an unmount inside the throttle window still flushes
  // the real last position instead of reading a scroll container React has already detached.
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastWritten = useRef('')
  const latest = useRef<{ anchor?: string; anchorOffset?: number; offset: number; follow: boolean } | null>(null)
  const capturePosition = (element = scrollRef.current) => {
    if (!element || !onPosition) return
    // Everything is measured by rects against the scroll viewport: `offsetTop` can use a different offsetParent.
    const fold = element.getBoundingClientRect?.().top ?? 0
    let anchor: string | undefined
    let anchorOffset: number | undefined
    for (const node of element.querySelectorAll<HTMLElement>('[data-event-anchor]')) {
      const rect = node.getBoundingClientRect?.()
      // The topmost turn that still reaches below the fold is the line the reader is looking at.
      if (rect && rect.bottom > fold) {
        anchor = node.dataset.eventAnchor
        // How far the turn's top sits above the viewport top: the alignment inside a tall message.
        anchorOffset = rect.top - fold
        break
      }
    }
    latest.current = { ...(anchor ? { anchor } : {}), ...(anchorOffset !== undefined ? { anchorOffset } : {}), offset: element.scrollTop, follow: atBottom.current }
  }
  const flushPosition = () => {
    const snapshot = latest.current
    if (!snapshot || !onPosition) return
    const signature = `${snapshot.anchor ?? ''}|${snapshot.anchorOffset ?? ''}|${snapshot.follow}|${Math.round(snapshot.offset / 40)}`
    if (signature === lastWritten.current) return
    lastWritten.current = signature
    onPosition(snapshot)
  }
  const schedulePosition = () => {
    if (writeTimer.current) return
    writeTimer.current = setTimeout(() => { writeTimer.current = undefined; flushPosition() }, 120)
  }
  // Leaving the panel inside the throttle window still persists the captured snapshot — never detached DOM.
  useEffect(() => () => { if (writeTimer.current) clearTimeout(writeTimer.current); flushPosition() }, [])
  useEffect(() => {
    if (typeof document === 'undefined') return
    const sync = () => setPaused(document.visibilityState === 'hidden')
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  // The event update itself is the dependency: two equal-sized appends must each run this, even when the
  // new-count state is already zero and its setter bails out. `previous` holds the window last processed.
  useEffect(() => {
    const prior = previous.current
    // The same window (a re-render, a strict-mode replay) is not a new update.
    if (prior === events) return
    previous.current = events
    const overlap = overlapCount(prior, events)
    const added = events.length - overlap
    const grew = added === 0 && streamGrew(prior, events)
    // A full replacement has no retained history to protect, but animating every line would be noise.
    setFreshFrom(added > 0 && !(overlap === 0 && prior.length > 0) ? overlap : undefined)
    if (added <= 0) {
      // A streaming message whose summary is already 200 characters still grows in `display`: a reader at the
      // bottom follows the growth, a reader above keeps their place and can catch up on demand.
      if (grew) {
        const element = scrollRef.current
        if (atBottom.current) {
          if (element) { element.scrollTop = element.scrollHeight; capturePosition(element) }
        } else setNewCount((count) => Math.max(count, 1))
      }
      return
    }
    const element = scrollRef.current
    if (atBottom.current) {
      if (element) { element.scrollTop = element.scrollHeight; capturePosition(element) }
      setNewCount(0)
    } else {
      setNewCount((count) => count + added)
    }
  }, [events, scrollRef])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = () => {
      const bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX
      atBottom.current = bottom
      if (bottom) setNewCount(0)
      // Capture on every scroll (synchronously); only the write-back is throttled.
      capturePosition(element)
      schedulePosition()
    }
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    return () => element.removeEventListener('scroll', measure)
  }, [scrollRef])

  // Start a live feed at its latest activity, once. It is a mount decision, not a completion one: a run
  // that finishes while the person is reading above keeps their place. The component is keyed by root+plan+
  // task+run, so `position` is already the position of *this* run; a new run gets its own mount and a fresh start.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const element = scrollRef.current
    if (!element) return
    // Restore the remembered reading position: by the exact turn anchor when it is still in the bounded history,
    // at the same alignment inside it; else by the saved offset; else start a live feed at its latest activity.
    if (position?.anchor) {
      const target = element.querySelector<HTMLElement>(`[data-event-anchor="${position.anchor}"]`)
      if (target) {
        atBottom.current = position.follow ?? false
        if (atBottom.current) { element.scrollTop = element.scrollHeight; return }
        if (position.anchorOffset !== undefined) {
          const rect = target.getBoundingClientRect?.()
          const fold = element.getBoundingClientRect?.().top ?? 0
          if (rect) {
            const max = Math.max(0, element.scrollHeight - element.clientHeight)
            // Re-apply the saved alignment: move by how far the anchor's top drifts from where it was saved.
            const next = element.scrollTop + (rect.top - fold) - position.anchorOffset
            element.scrollTop = max > 0 ? Math.min(max, Math.max(0, next)) : Math.max(0, next)
            return
          }
        }
        element.scrollTop = target.offsetTop
        return
      }
    }
    if (position?.offset !== undefined) {
      atBottom.current = position.follow ?? false
      // The anchor expired: a bounded raw offset is the honest fallback.
      element.scrollTop = position.follow ? element.scrollHeight : Math.min(Math.max(0, position.offset), element.scrollHeight)
      return
    }
    if (live) { element.scrollTop = element.scrollHeight; atBottom.current = true }
  }, [live, scrollRef])

  // After the one-time restore, snapshot what is on screen: an unmount before any scroll still flushes the
  // restored position (and its run) rather than an empty one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mount snapshot reads the restored DOM once.
  useEffect(() => { capturePosition() }, [])

  const catchUp = () => {
    const element = scrollRef.current
    if (element) { element.scrollTop = element.scrollHeight; capturePosition(element) }
    atBottom.current = true
    setNewCount(0)
  }

  const report = !!detail.report?.text?.trim()
  return (
    <div className="orc-live" data-phase={phase.kind} data-live={live ? 'true' : 'false'} data-paused={paused ? 'true' : 'false'}>
      <ActivityStatus phase={phase} live={live} report={report} newCount={newCount} {...(alert ? { alert } : {})} {...(onOpenReport ? { onOpenReport } : {})} />
      <Conversation events={events} finished={!!(run.finishedAt || run.outcome)} {...(freshFrom !== undefined ? { freshFrom } : {})} />
      {newCount > 0 ? (
        <button type="button" className="orc-live__jump" onClick={catchUp}>{t('panel.activity.newEvents', { count: newCount })}</button>
      ) : null}
    </div>
  )
}
