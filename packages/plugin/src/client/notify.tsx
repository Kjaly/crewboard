import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { type Attention, PANEL_ID, type OrchestraSnapshot } from '../shared/types.js'
import { api, shared } from './api.js'
import { countsAsAttention, needsYou, needsYouGroups, reviewReason } from '../../../core/src/orchestration/needs-you.js'
import { type AttentionEffects, createAttentionEffects, openTarget, REVIEW_AUTOHIDE_MS, REVIEW_GROUP_MS, type ReviewItem, toastText } from './attention.js'
import type { ClientContext } from './dsh.js'
import { hostEvents } from './host-events.js'
import { shellLabel, t, useLang } from './i18n.js'
import { bindLayout, selectMainPanel } from './layout.js'
import { repoName, waitingRepositories, waitingTasks } from './review.js'
import { orchestraStore } from './store.js'
import { ensureStyles } from './styles.js'
import { reasonsText, waitingOf } from './waiting.js'

/**
 * In-app review notifications, alive while the Orchestra screen is closed — a finished run pops a
 * toast even inside a chat — with one toast stack mounted straight into `document.body`. The centre
 * holds no stream of its own (a stream per tab for its whole life used up the browser's connections
 * per host, 2026-09-25): it hears the snapshots of the screen's stream and, while that is not live,
 * re-reads /state every {@link ATTENTION_POLL_MS}. The same snapshot feeds the sidebar badge, the tab
 * title, the favicon dot and browser notifications.
 */

export { REVIEW_AUTOHIDE_MS, REVIEW_GROUP_MS } from './attention.js'
export type { ReviewItem } from './attention.js'

const SEEN_KEY = 'crewboard:review-seen'
const SEEN_MAX = 400
const MAX_TOASTS = 4
/** How often the badge re-reads /state while the tab's stream is not live. */
export const ATTENTION_POLL_MS = 25_000

export type ReviewToast = { id: number; items: ReviewItem[]; touched: number }
/**
 * `waiting` is the one waiting number (at2): the tab title and the sidebar icon show it as it is. `failed` only
 * turns the favicon dot red; failed runs are already counted in `waiting`.
 */
export type ReviewState = { waiting: number; failed: number; locations: string; toasts: ReviewToast[] }

export type ReviewCenter = {
  subscribe(fn: () => void): () => void
  getState(): ReviewState
  /** Process one SSE snapshot: newly waiting tasks become a toast, the badge recounts regardless. */
  feed(snapshot: OrchestraSnapshot): void
  /** “Open”: hand the item to the screen — repo, plan, task selection, open queue. */
  open(item?: ReviewItem): void
  dismiss(id: number): void
}

/**
 * Real alarms across the open plan and every background plan, archived ones aside (ny1): the danger side of the
 * favicon. A command merely running, or a short quiet spell, is information, not an alarm (st2, nt2) — the same
 * `countsAsAttention` predicate `needsYou` uses, so the count that turns the icon red never disagrees with «Needs you».
 */
function snapshotFailed(snapshot: OrchestraSnapshot): number {
  const failed = (items: Attention[] | undefined) => (items ?? []).filter((a) => countsAsAttention(a) && a.severity === 'alert').length
  return snapshot.repos.reduce((total, repo) => {
    if (repo.example) return total
    const background = (repo.plans ?? []).filter((plan) => !plan.current && !plan.example && !plan.archived).reduce((n, plan) => n + failed(plan.attention), 0)
    return total + (repo.archived ? 0 : failed(repo.attention)) + background
  }, 0)
}

/** The dedupe key names one review round: a reworked task comes back with a new run and notifies again. */
const itemKey = (root: string, planId: string | undefined, task: { id: string; lastRunId?: string }) =>
  `${root}·${planId ?? ''}·${task.id}·${task.lastRunId ?? ''}`

function readSeen(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeSeen(seen: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX)))
  } catch {
    /* storage is a convenience, never a requirement */
  }
}

export function createReviewCenter(
  opts: { selectPanel?(key: string): void; now?(): number; onFeed?(state: ReviewState, fresh: ReviewItem[]): void } = {},
): ReviewCenter {
  const now = opts.now ?? (() => Date.now())
  let state: ReviewState = { waiting: 0, failed: 0, locations: '', toasts: [] }
  let latest: OrchestraSnapshot | null = null
  let seq = 0
  const listeners = new Set<() => void>()
  const seen = readSeen()
  // Diff state: which review keys each repo's current plan already showed, and how many
  // in_review each background plan carried last time.
  const known = new Map<string, Set<string>>()
  const currentPlan = new Map<string, string | undefined>()
  const background = new Map<string, number>()
  const backgroundDecisions = new Map<string, number>()

  const emit = () => {
    for (const l of [...listeners]) l()
  }
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch }
    emit()
  }
  const markSeen = (keys: Iterable<string>) => {
    let dirty = false
    for (const key of keys) {
      if (seen.has(key)) continue
      seen.add(key)
      dirty = true
    }
    if (dirty) writeSeen(seen)
  }

  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getState: () => state,

    feed(snapshot) {
      latest = snapshot
      const fresh: ReviewItem[] = []
      const nextBg = new Map<string, number>()
      const nextDecisions = new Map<string, number>()
      for (const repo of snapshot.repos) {
        const firstSight = !known.has(repo.root)
        // Switching plans re-keys the whole task list — absorb it silently; a background plan's
        // waiting tasks were already announced by the count diff below.
        const silent = !firstSight && currentPlan.get(repo.root) !== repo.planId
        const keys = new Set<string>()
        const items: ReviewItem[] = []
        for (const task of waitingTasks(repo)) {
          const key = itemKey(repo.root, repo.planId, task)
          keys.add(key)
          items.push({
            key,
            root: repo.root,
            planId: repo.planId,
            taskId: task.id,
            title: task.title,
            count: 1,
            decision: task.kind === 'decision' && task.status !== 'in_review',
            reason: task.kind === 'decision' && task.status !== 'in_review' ? 'decision' : reviewReason(task),
            ...(repo.goal ? { plan: repo.goal } : {}),
          })
        }
        if (!silent) {
          const before = known.get(repo.root) ?? new Set<string>()
          for (const item of items) {
            if (!before.has(item.key) && !seen.has(item.key)) fresh.push(item)
          }
        }
        markSeen(keys)
        known.set(repo.root, keys)
        currentPlan.set(repo.root, repo.planId)
        for (const plan of repo.plans ?? []) {
          if (plan.current || plan.example || plan.archived) continue
          const bgKey = `${repo.root}·${plan.id}`
          nextBg.set(bgKey, plan.waitingHuman)
          nextDecisions.set(bgKey, plan.decisions ?? 0)
          const was = background.get(bgKey)
          // A plan's first appearance (or its return from the foreground) only re-baselines.
          if (was === undefined || firstSight) continue
          const delta = plan.waitingHuman - was
          if (delta > 0) {
            // What is new there, by reason: the decisions that appeared, the rest reviews.
            const decision = Math.min(delta, Math.max(0, (plan.decisions ?? 0) - (backgroundDecisions.get(bgKey) ?? 0)))
            fresh.push({ key: `${bgKey}·${plan.inReview}`, root: repo.root, planId: plan.id, title: plan.goal, plan: plan.goal, count: delta, reasons: { ...(delta - decision ? { review: delta - decision } : {}), ...(decision ? { decision } : {}) } })
          }
        }
      }
      background.clear()
      nextBg.forEach((v, k) => { background.set(k, v) })
      backgroundDecisions.clear()
      nextDecisions.forEach((v, k) => { backgroundDecisions.set(k, v) })

      let toasts = state.toasts
      if (fresh.length > 0) {
        const last = toasts.at(-1)
        if (last && now() - last.touched <= REVIEW_GROUP_MS) {
          toasts = [...toasts.slice(0, -1), { ...last, items: [...last.items, ...fresh], touched: now() }]
        } else {
          toasts = [...toasts, { id: ++seq, items: fresh, touched: now() }]
        }
        if (toasts.length > MAX_TOASTS) toasts = toasts.slice(-MAX_TOASTS)
      }
      // Where the work waits, one plan per part, in the words of «Needs you»: «app · Ship it: 6 tasks wait for review · 1 decision».
      const locations = needsYouGroups(needsYou(snapshot.repos))
        .filter((group) => !group.example)
        .map((group) => `${repoName(group.root)}${group.title ? ` · ${group.title}` : ''}: ${reasonsText(group.reasons)}`)
        .join('; ')
      set({ waiting: waitingOf(snapshot).all, failed: snapshotFailed(snapshot), locations, toasts })
      opts.onFeed?.(state, fresh)
    },

    open(item) {
      opts.selectPanel?.(PANEL_ID)
      if (item) {
        orchestraStore.openWaiting({ root: item.root, planId: item.planId, taskId: item.taskId, ...(item.needs ? { queue: true } : {}) })
      } else {
        const target = waitingRepositories(latest).find(({ waiting }) => waiting > 0)
        orchestraStore.openFirstWaiting(target?.repo.root)
      }
    },

    dismiss(id) {
      set({ toasts: state.toasts.filter((t) => t.id !== id) })
    },
  }
}

/* ------------------------------------------------------------------ toasts */

/** A toast leaves after 12 s on its own; hovering it freezes the countdown. */
function Toast({ toast, center }: { toast: ReviewToast; center: ReviewCenter }) {
  useLang()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const left = useRef(REVIEW_AUTOHIDE_MS)
  const started = useRef(0)
  const close = useRef(() => center.dismiss(toast.id))
  close.current = () => center.dismiss(toast.id)

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    left.current = REVIEW_AUTOHIDE_MS
    started.current = Date.now()
    timer.current = setTimeout(() => close.current(), left.current)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // A merged batch restarts the countdown — it is one notification, not two.
  }, [toast.id, toast.items.length])

  const pause = () => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    left.current = Math.max(400, left.current - (Date.now() - started.current))
  }
  const resume = () => {
    if (timer.current) return
    started.current = Date.now()
    timer.current = setTimeout(() => close.current(), left.current)
  }
  const open = () => {
    center.open(openTarget(toast.items))
    center.dismiss(toast.id)
  }

  return (
    <div className="orc-toast" role="status" onMouseEnter={pause} onMouseLeave={resume}>
      <div className="orc-toast__row">
        <span className="orc-toast__glyph" aria-hidden="true">
          ◐
        </span>
        <span className="orc-toast__text">{toastText(toast.items)}</span>
        <button type="button" className="orc-toast__x" aria-label={t('notify.hide')} onClick={() => center.dismiss(toast.id)}>
          ×
        </button>
      </div>
      <div className="orc-toast__acts">
        <button type="button" className="orc-btn orc-btn--ghost" onClick={open}>
          {t('notify.open')}
        </button>
      </div>
    </div>
  )
}

export function ReviewToasts({ center }: { center: ReviewCenter }) {
  const toasts = useSyncExternalStore(center.subscribe, () => center.getState().toasts)
  return (
    <div className="orc-toasts">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} center={center} />
      ))}
    </div>
  )
}

/* ---------------------------------------------------------- singleton wiring */

let singleton: ReviewCenter | undefined
let attention: AttentionEffects | undefined
let clientId: string | undefined
const selectPanelRef: { current: ((key: string) => void) | undefined } = { current: undefined }
let listening = false
let unwatch: (() => void) | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let polling = false
let toastsRoot: Root | undefined
let toastsHost: HTMLElement | undefined

/** A per-load id only needs to be unique among tabs; the host ages a silent one out. */
function presenceClientId(): string {
  if (!clientId) {
    try {
      clientId = globalThis.crypto?.randomUUID?.() ?? `orch-${Math.random().toString(36).slice(2)}`
    } catch {
      clientId = `orch-${Math.random().toString(36).slice(2)}`
    }
  }
  return clientId
}

/** The shared centre — created lazily so the badge and tests work without `apply` having run. */
export function reviewCenter(): ReviewCenter {
  singleton ??= createReviewCenter({
    selectPanel: (key) => selectPanelRef.current?.(key),
    onFeed: (state, fresh) => attention?.update(state.waiting, state.failed, fresh),
  })
  return singleton
}

/** Sidebar badge count. */
export function useReviewBadge(): { waiting: number; locations: string } {
  return useSyncExternalStore(
    (fn) => reviewCenter().subscribe(fn),
    () => reviewCenter().getState(),
  )
}

/**
 * Name of the sidebar item — dsh calls `label` when it renders the entry, outside React and before our
 * lazy dictionary may have landed (lb1); `shellLabel` never returns blank for it. The waiting count
 * lives on the badge only.
 */
export function reviewBadgeLabel(): string {
  return shellLabel('notify.badge')
}

/** Hover title of the sidebar icon: the count and where the waiting work is. */
export function reviewBadgeTitle(): string {
  const { waiting, locations } = reviewCenter().getState()
  return waiting > 0 ? t('notify.badgeWaiting', { n: waiting, locations }) : shellLabel('notify.badge')
}

/**
 * Wired once from `apply`: the snapshot feed (the screen's stream, else a /state poll), one toast
 * root in `document.body`, and the tab/favicon/browser-notification effects. All survive the
 * Orchestra screen being closed — that is the point.
 */
export function startReviewCenter(ctx: ClientContext): void {
  bindLayout(ctx)
  selectPanelRef.current = (key) => selectMainPanel(key)
  const center = reviewCenter()
  if (!attention) {
    attention = createAttentionEffects({
      open: (item) => center.open(item),
      postPresence: (enabled) => {
        void api.notifyPresence(presenceClientId(), enabled).catch(() => {})
      },
    })
    const current = center.getState()
    attention.update(current.waiting, current.failed, [])
  }
  if (!listening) {
    listening = true
    const feed = (snapshot: OrchestraSnapshot) => {
      // A quick first paint (pf1) has no merge detection and no orchestrator check yet: the badge and the toasts
      // wait for the full snapshot that follows, so nothing appears for a moment only to vanish.
      if (snapshot.repos?.some((repo) => repo.partial)) return
      try {
        center.feed(snapshot)
      } catch {
        /* a malformed snapshot must not stop the badge */
      }
    }
    // Frames the screen's stream carries anyway; a malformed one is skipped.
    unwatch = hostEvents.watch('snapshot', (frame) => {
      if (frame.ok) feed(frame.data as OrchestraSnapshot)
    })
    // No stream of its own: while nothing holds the tab's stream live, the badge re-reads /state.
    const poll = () => {
      if (polling || hostEvents.link() === 'live') return
      polling = true
      void shared
        .state()
        .then((result) => {
          if (listening && result.ok) feed(result.value)
        })
        .catch(() => {})
        .finally(() => {
          polling = false
        })
    }
    poll()
    pollTimer = setInterval(poll, ATTENTION_POLL_MS)
  }
  if (!toastsRoot && typeof document !== 'undefined' && document.body) {
    ensureStyles()
    toastsHost = document.createElement('div')
    toastsHost.setAttribute('data-orchestra-toasts', '')
    document.body.append(toastsHost)
    toastsRoot = createRoot(toastsHost)
    toastsRoot.render(<ReviewToasts center={center} />)
  }
  ctx.effect?.(() => () => resetReviewCenter(), 'crewboard: review center')
}

/** Test seam: drop the singleton, the listener flag, the mounted toast root and the attention effects. */
export function resetReviewCenter(): void {
  singleton = undefined
  attention?.dispose()
  attention = undefined
  clientId = undefined
  selectPanelRef.current = undefined
  listening = false
  unwatch?.()
  unwatch = undefined
  clearInterval(pollTimer)
  pollTimer = undefined
  polling = false
  toastsRoot?.unmount()
  toastsRoot = undefined
  toastsHost?.remove()
  toastsHost = undefined
}
