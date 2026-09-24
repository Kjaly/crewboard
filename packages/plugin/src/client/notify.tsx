import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { API_PREFIX, type Attention, PANEL_ID, type OrchestraSnapshot } from '../shared/types.js'
import { api } from './api.js'
import { type AttentionEffects, createAttentionEffects, REVIEW_AUTOHIDE_MS, REVIEW_GROUP_MS, type ReviewItem, toastText } from './attention.js'
import type { ClientContext } from './dsh.js'
import { t, useLang } from './i18n.js'
import { bindLayout, selectMainPanel } from './layout.js'
import { acceptableTasks, repoName, snapshotWaiting, waitingRepositories } from './review.js'
import { orchestraStore } from './store.js'
import { ensureStyles } from './styles.js'

/**
 * In-app review notifications. One SSE listener per application — kept alive while the
 * Orchestra screen is closed, so a finished run pops a toast even inside a chat — and one
 * toast stack mounted straight into `document.body`. The same centre feeds the sidebar badge,
 * and the same SSE snapshot drives the tab title, the favicon dot and browser notifications.
 */

export { REVIEW_AUTOHIDE_MS, REVIEW_GROUP_MS } from './attention.js'
export type { ReviewItem } from './attention.js'

const SEEN_KEY = 'crewboard:review-seen'
const SEEN_MAX = 400
const MAX_TOASTS = 4

export type ReviewToast = { id: number; items: ReviewItem[]; touched: number }
/** Everything waiting for the person, plus the failed runs the tab title counts alongside it. */
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

/** Failed runs across the open plan and every background plan: the danger side of the favicon. */
function snapshotFailed(snapshot: OrchestraSnapshot): number {
  const failed = (items: Attention[] | undefined) => (items ?? []).filter((a) => a.kind === 'failed').length
  return snapshot.repos.reduce((total, repo) => {
    if (repo.example) return total
    const background = (repo.plans ?? []).filter((plan) => !plan.current && !plan.example).reduce((n, plan) => n + failed(plan.attention), 0)
    return total + failed(repo.attention) + background
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
      for (const repo of snapshot.repos) {
        const firstSight = !known.has(repo.root)
        // Switching plans re-keys the whole task list — absorb it silently; a background plan's
        // waiting tasks were already announced by the count diff below.
        const silent = !firstSight && currentPlan.get(repo.root) !== repo.planId
        const keys = new Set<string>()
        const items: ReviewItem[] = []
        for (const task of repo.example ? [] : acceptableTasks(repo)) {
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
          if (plan.current || plan.example) continue
          const bgKey = `${repo.root}·${plan.id}`
          nextBg.set(bgKey, plan.waitingHuman)
          const was = background.get(bgKey)
          // A plan's first appearance (or its return from the foreground) only re-baselines.
          if (was === undefined || firstSight) continue
          const delta = plan.waitingHuman - was
          if (delta > 0) fresh.push({ key: `${bgKey}·${plan.inReview}`, root: repo.root, planId: plan.id, title: plan.goal, count: delta })
        }
      }
      background.clear()
      nextBg.forEach((v, k) => { background.set(k, v) })

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
      const locations = waitingRepositories(snapshot)
        .filter(({ waiting }) => waiting > 0)
        .map(({ repo, plans }) => `${repoName(repo.root)}: ${plans.map((plan) => `${plan.goal} (${plan.waitingHuman})`).join(', ') || `${repo.goal} (${acceptableTasks(repo).length})`}`)
        .join('; ')
      set({ waiting: snapshotWaiting(snapshot), failed: snapshotFailed(snapshot), locations, toasts })
      opts.onFeed?.(state, fresh)
    },

    open(item) {
      opts.selectPanel?.(PANEL_ID)
      if (item) {
        orchestraStore.openWaiting({ root: item.root, planId: item.planId, taskId: item.taskId })
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
    const target = [...toast.items].reverse().find((i) => i.taskId) ?? toast.items[0]
    center.open(target)
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
let stream: EventSource | undefined
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
    onFeed: (state, fresh) => attention?.update(state.waiting + state.failed, state.failed, fresh),
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

/** Name of the sidebar item — dsh calls `label` when it renders the entry. The waiting count lives on the badge only. */
export function reviewBadgeLabel(): string {
  return t('notify.badge')
}

/** Hover title of the sidebar icon: the count and where the waiting work is. */
export function reviewBadgeTitle(): string {
  const { waiting, locations } = reviewCenter().getState()
  return waiting > 0 ? t('notify.badgeWaiting', { n: waiting, locations }) : t('notify.badge')
}

/**
 * Wired once from `apply`: one SSE listener for the app's whole life, one toast root in
 * `document.body`, and the tab/favicon/browser-notification effects. All survive the Orchestra
 * screen being closed — that is the point.
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
    attention.update(current.waiting + current.failed, current.failed, [])
  }
  if (!listening && typeof EventSource !== 'undefined') {
    listening = true
    stream = new EventSource(`${API_PREFIX}/events`)
    stream.addEventListener('snapshot', (event) => {
      try {
        center.feed(JSON.parse((event as MessageEvent<string>).data) as OrchestraSnapshot)
      } catch {
        /* a malformed frame must not kill the stream */
      }
    })
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
  stream?.close()
  stream = undefined
  toastsRoot?.unmount()
  toastsRoot = undefined
  toastsHost?.remove()
  toastsHost = undefined
}
