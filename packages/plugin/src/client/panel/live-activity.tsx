import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TaskDetail, TaskSnapshot } from '../../shared/types.js'
import { t, useLang } from '../i18n.js'
import { eventText } from '../summary.js'
import { FeedTab, groupEvents } from './tabs.js'

type Run = TaskDetail['runs'][number]
type Event = TaskDetail['events'][number]

/** How close to the end still counts as «following the feed». */
export const BOTTOM_THRESHOLD_PX = 24

/** A stable identity for one normalized event: time plus kind, never the mutable text. */
export function eventSignature(event: Pick<Event, 'kind' | 'ts'>): string {
  return `${event.kind}\u0000${event.ts}`
}

/**
 * Two events are the same line when kind and time agree and the text is equal or a prefix of the other —
 * `answer_delta` grows a message's text in place, and that is an update, not a new line.
 */
const compatible = (a: Event, b: Event): boolean =>
  a.kind === b.kind && a.ts === b.ts && (a.text === b.text || a.text.startsWith(b.text) || b.text.startsWith(a.text))

/**
 * How many leading events of `next` continue the tail of `prev`. `detail.events` is a bounded rolling tail
 * (`normalize(raw).slice(-MAX_EVENTS)` in core), so the array length alone cannot say what is new: after the
 * window fills, one event leaves as one arrives and the length stays put.
 */
export function overlapCount(prev: readonly Event[], next: readonly Event[]): number {
  const max = Math.min(prev.length, next.length)
  for (let k = max; k > 0; k--) {
    let ok = true
    for (let i = 0; i < k; i++) {
      const a = prev[prev.length - k + i]
      const b = next[i]
      if (!a || !b || !compatible(a, b)) {
        ok = false
        break
      }
    }
    if (ok) return k
  }
  return 0
}

type KeyedGroup = { key: string; kind: Event['kind']; signatures: string[] }

/**
 * Carry a group's React key across a rolling window. A group is matched to the previous one of the same kind
 * that still shares at least one event, so a group whose oldest events expired (or that just gained one)
 * keeps its identity and its open disclosure instead of remounting.
 */
export function stabilizeGroupKeys(
  prev: readonly KeyedGroup[],
  next: readonly { kind: Event['kind']; events: Event[] }[],
  seqStart: number,
): { keys: string[]; state: KeyedGroup[]; seq: number } {
  let seq = seqStart
  const used = new Set<number>()
  const keys: string[] = []
  const state: KeyedGroup[] = []
  for (const group of next) {
    const signatures = group.events.map(eventSignature)
    let key: string | undefined
    for (let i = 0; i < prev.length; i++) {
      const candidate = prev[i]
      if (!candidate || used.has(i) || candidate.kind !== group.kind) continue
      if (candidate.signatures.some((signature) => signatures.includes(signature))) {
        key = candidate.key
        used.add(i)
        break
      }
    }
    if (!key) key = `g${seq++}`
    keys.push(key)
    state.push({ key, kind: group.kind, signatures })
  }
  return { keys, state, seq }
}

/** Only the latest, unfinished, non-terminal run of a running task is alive; anything else reads as history. */
export function runIsLive(task: Pick<TaskSnapshot, 'status'>, runs: readonly Run[], run: Run | undefined): boolean {
  return !!run && !run.finishedAt && !run.outcome && task.status === 'running' && runs.at(-1)?.runId === run.runId
}

export type ActivityPhase =
  | { kind: 'working'; step: string }
  | { kind: 'waiting' }
  | { kind: 'terminal'; outcome?: Run['outcome'] }
  | { kind: 'past' }

/**
 * What the run is doing right now. An open action/file event (st2) is the current reported step; no open
 * event means the run is between steps, not «thinking». A finished run reports its own outcome — a tool
 * problem inside a live run never turns the task into a failure.
 */
export function activityPhase(task: Pick<TaskSnapshot, 'status'>, runs: readonly Run[], run: Run | undefined, events: readonly Event[] = []): ActivityPhase {
  if (!run) return { kind: 'past' }
  // A recorded outcome is terminal even when a legacy/stale snapshot omits `finishedAt`.
  if (run.finishedAt || run.outcome) return { kind: 'terminal', ...(run.outcome ? { outcome: run.outcome } : {}) }
  if (!runIsLive(task, runs, run)) return { kind: 'past' }
  const open = [...events].reverse().find((event) => event.open)
  return open ? { kind: 'working', step: eventText(open) } : { kind: 'waiting' }
}

function ActivityStatus({ phase, live, report, newCount, onOpenReport }: { phase: ActivityPhase; live: boolean; report: boolean; newCount: number; onOpenReport?(): void }) {
  const label =
    phase.kind === 'working' ? t('panel.activity.working')
    : phase.kind === 'waiting' ? t('panel.activity.waiting')
    : phase.kind === 'terminal' ? (phase.outcome ? t(`panel.tabs.outcome.${phase.outcome}`) : t('panel.activity.finishedUnknown'))
    : t('panel.activity.earlier')
  return (
    <div className="orc-live__status" role="status" aria-live="polite" data-phase={phase.kind}>
      <span className={`orc-live__dot${live ? ' orc-live__dot--live' : ''}`} aria-hidden="true" />
      <span className="orc-live__label">{label}</span>
      {phase.kind === 'working' ? <code className="orc-live__step" title={phase.step}>{phase.step}</code> : null}
      {phase.kind === 'terminal' && report && onOpenReport ? (
        <button type="button" className="orc-run__link orc-live__report" onClick={onOpenReport}>{t('panel.activity.openReport')}</button>
      ) : null}
      {newCount > 0 ? <span className="orc-sr-only">{t('panel.activity.newEvents', { count: newCount })}</span> : null}
    </div>
  )
}

/**
 * The live end of the Activity tab: true status, the conversation feed, and following that respects a
 * reader who scrolled up. It owns no scroll container of its own — it drives the panel's existing
 * `.orc-panel__scroll` through `scrollRef`, so there is never a second feed viewport to fight.
 */
export function LiveActivity({
  detail,
  task,
  run,
  scrollRef,
  onOpenReport,
}: {
  detail: TaskDetail
  task: TaskSnapshot
  run: Run
  scrollRef: RefObject<HTMLElement | null>
  onOpenReport?(): void
}) {
  useLang()
  const events = detail.events ?? []
  const runs = detail.runs ?? []
  const phase = activityPhase(task, runs, run, events)
  const live = runIsLive(task, runs, run)
  const groups = useMemo(() => groupEvents(events), [events])
  const keyState = useRef<{ prev: KeyedGroup[]; seq: number }>({ prev: [], seq: 0 })
  const groupKeys = useMemo(() => {
    const aligned = stabilizeGroupKeys(keyState.current.prev, groups, keyState.current.seq)
    keyState.current = { prev: aligned.state, seq: aligned.seq }
    return aligned.keys
  }, [groups])

  const previous = useRef(events)
  const atBottom = useRef(true)
  const [newCount, setNewCount] = useState(0)
  const [freshFrom, setFreshFrom] = useState<number | undefined>(undefined)
  // The pulse is decoration: pause it whenever the page is hidden, live run or not.
  const [paused, setPaused] = useState(false)
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
    // A full replacement has no retained history to protect, but animating every line would be noise.
    setFreshFrom(added > 0 && !(overlap === 0 && prior.length > 0) ? overlap : undefined)
    if (added <= 0) return
    const element = scrollRef.current
    if (atBottom.current) {
      if (element) element.scrollTop = element.scrollHeight
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
    }
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    return () => element.removeEventListener('scroll', measure)
  }, [scrollRef])

  // Start a live feed at its latest activity, once. It is a mount decision, not a completion one: a run
  // that finishes while the person is reading above keeps their place.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!live) return
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
    atBottom.current = true
  }, [live, scrollRef])

  const catchUp = () => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
    atBottom.current = true
    setNewCount(0)
  }

  const report = !!detail.report?.text?.trim()
  return (
    <div className="orc-live" data-phase={phase.kind} data-live={live ? 'true' : 'false'} data-paused={paused ? 'true' : 'false'}>
      <ActivityStatus phase={phase} live={live} report={report} newCount={newCount} {...(onOpenReport ? { onOpenReport } : {})} />
      <FeedTab detail={detail} {...(freshFrom !== undefined ? { freshFrom } : {})} groupKeys={groupKeys} />
      {newCount > 0 ? (
        <button type="button" className="orc-live__jump" onClick={catchUp}>{t('panel.activity.newEvents', { count: newCount })}</button>
      ) : null}
    </div>
  )
}
