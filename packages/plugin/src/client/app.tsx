import { getLang, t, useLang } from './i18n.js'
import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanRunCost, TaskDetail, TaskReviewSummary } from '../shared/types.js'

import type { TabKey } from './panel/tabs.js'
import type { TraceTarget } from './panel/trace.js'
import { PresetPickers } from './preset-picker.js'
import { OutsidePresetChip } from './outside-preset.js'
import { PartBoundary } from './boundary.js'
import { BUILD_ID } from '../shared/build.js'
import { LensChip } from './lens-chips.js'
import { RepoSidebar } from './sidebar.js'
import { OrchestraSettings, Welcome, Tour, DraftReview, DraftJobView, ReviewView, ReviewDrilldown, TraceScreen, TaskPanel, TaskMenu, GraphView } from './lazy-views.js'
import { markTourSeen, tourSeen } from './tour.js'
import { api, type DraftJobSummary, type DraftSummary } from './api.js'
import { ReviewQueue } from './queue.js'
import { repoName, reviewWaiting } from './review.js'
import { repoError } from './summary.js'
import { ensureStyles } from './styles.js'
import { orchestraStore, type ViewKind, useOrchestra } from './store.js'
import { lensTasks } from './lens.js'
import { WorkView } from './views/work.js'
import type { ReviewDetail } from './views/review-detail.js'
import type { ViewProps } from './views/types.js'
import type { MenuRequest } from './task-menu.js'
import { formatRoute, parseRoute } from './route.js'
import { WorkerSettingsBanner } from './worker-settings-banner.js'

const VIEWS: Array<{ key: ViewKind; label: string }> = [
  { key: 'graph', label: 'panel.app.graph' },
  { key: 'work', label: 'panel.app.work' },
  { key: 'review', label: 'panel.app.review' },
]
const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (EDITABLE.has(el.tagName) || el.isContentEditable === true)
}

const PLANS_KEY = 'crewboard:plans-open'
/** From this viewport width an open Review run sits beside the run list instead of replacing it. */
export const REVIEW_SIDE_BY_SIDE = 1280

function readPlansOpen(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(PLANS_KEY)
    if (stored === '0') return false
    if (stored === '1') return true
  } catch {
    /* storage is a convenience, never a requirement */
  }
  // On a narrow window the column is an overlay: better closed until asked for.
  return !(globalThis.matchMedia?.('(max-width: 1100px)').matches ?? false)
}

export function App() {
  useLang()
  ensureStyles()
  const { snapshot, connection, repo, selectedId, select, view, setView, density, toggleDensity, lens, setLens, queueOpen, setQueueOpen, routeRequest, stalled, resetScreenState, lane, focusLane, laneInView, setLaneInView } = useOrchestra()
  const [walk, setWalk] = useState<{ id: string; seq: number } | null>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const [multiIds, setMultiIds] = useState<string[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: This DOM sync reruns on the chosen view and repository revision.
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.orc-root [data-task-id]').forEach((element) => {
      if (multiIds.includes(element.dataset.taskId ?? '')) element.setAttribute('data-multiselect', 'true')
      else element.removeAttribute('data-multiselect')
    })
  }, [multiIds, view, repo?.rev])
  const [trace, setTrace] = useState<TraceTarget | null>(null)
  const [runTrace, setRunTrace] = useState<{ target: TraceTarget; seq: number } | null>(null)
  const [reviewStack, setReviewStack] = useState<Array<{ detail: ReviewDetail; run?: PlanRunCost; summary?: TaskReviewSummary }>>([])
  const reviewScroll = useRef(0)
  const reviewMain = useRef<HTMLElement>(null)
  const reviewStackRef = useRef(reviewStack)
  const reviewPushing = useRef(false)
  reviewStackRef.current = reviewStack
  // Review keeps an open run beside the list from 1280 px; below it the run takes the list's place.
  const [reviewWide, setReviewWide] = useState(() => typeof window === 'undefined' || window.innerWidth >= REVIEW_SIDE_BY_SIDE)
  useEffect(() => {
    const measure = () => setReviewWide(window.innerWidth >= REVIEW_SIDE_BY_SIDE)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const reviewShown = useRef<{ runId?: string; beside: boolean } | null>(null)
  const [steerDraft, setSteerDraft] = useState<{ taskId: string; text: string; seq: number } | null>(null)
  const [panelTab, setPanelTab] = useState<{ tab: TabKey; seq: number } | null>(null)
  const [plansOpen, setPlansOpen] = useState(readPlansOpen)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(0)
  const [tourStep, setTourStep] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [draftJobs, setDraftJobs] = useState<DraftJobSummary[]>([])
  const [draftsLoaded, setDraftsLoaded] = useState(false)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [draftRefresh, setDraftRefresh] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (!routeRequest || !repo || routeRequest.route.repo !== repo.root || routeRequest.route.plan !== (repo.planId ?? '_')) return
    const route = routeRequest.route
    setSettingsOpen(route.view === 'settings')
    setDraftId(route.draft ?? null)
    setTrace(null)
    if (route.view === 'review') {
      if (reviewPushing.current) { reviewPushing.current = false; return }
      const detail: ReviewDetail | undefined = route.task && route.tab === 'review-task' ? { kind: 'task', taskId: route.task } : route.task && route.run && route.tab === 'review-run' ? { kind: 'run', taskId: route.task, runId: route.run, expanded: false } : undefined
      setReviewStack((stack) => {
        if (!detail) return []
        const existing = stack.find((frame) => frame.detail.kind === detail.kind && frame.detail.taskId === detail.taskId && (frame.detail.kind !== 'run' || detail.kind !== 'run' || frame.detail.runId === detail.runId))
        return existing ? [...stack.slice(0, stack.indexOf(existing) + 1)] : [...stack, { detail }]
      })
      return
    }
    if (route.task && route.tab) setPanelTab((old) => ({ tab: route.tab as TabKey, seq: (old?.seq ?? 0) + 1 }))
    if (!route.run || !route.task) return
    let live = true
    void api.task(repo.root, route.task).then((result) => {
      if (!live || !result.ok) return
      const run = result.value.runs.find((item) => item.runId === route.run)
      if (!run) { orchestraStore.navigate({ run: undefined }, 'replace'); return }
      setTrace({ taskId: route.task!, taskTitle: result.value.title, run: { runId: run.runId, agent: run.agent, startedAt: run.startedAt, active: !run.finishedAt } })
    }).catch(() => {})
    return () => { live = false }
  }, [routeRequest?.seq, repo?.root, repo?.planId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (!repo) { setDrafts([]); setDraftJobs([]); setDraftsLoaded(false); return }
    let live = true
    setDraftsLoaded(false)
    void Promise.all([api.planDrafts(repo.root), api.planDraftJobs(repo.root).catch(() => null)]).then(([result, jobs]) => {
      if (!live) return
      if (result.ok && Array.isArray(result.value)) setDrafts(result.value)
      if (jobs?.ok && Array.isArray(jobs.value)) setDraftJobs(jobs.value)
      setDraftsLoaded(true)
    }).catch(() => { if (live) setDraftsLoaded(true) })
    return () => { live = false }
  }, [snapshot, repo?.root, draftRefresh])
  // A running draft job is also polled: asking for the list advances it even when no snapshot arrives.
  useEffect(() => {
    if (!draftJobs.some((job) => job.status === 'running')) return
    const timer = setTimeout(() => setDraftRefresh((n) => n + 1), 4000)
    return () => clearTimeout(timer)
  }, [draftJobs])
  const selectedJob = draftJobs.find((job) => job.id === draftId)
  const openDraft = useCallback((id: string) => { setDraftId(id); orchestraStore.navigate({ draft: id }, 'replace') }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: repo is read only for its root at the moment the selection disappears.
  useEffect(() => {
    if (!draftsLoaded || !draftId || drafts.some((item) => item.id === draftId) || draftJobs.some((job) => job.id === draftId)) return
    let live = true
    const clear = () => { if (live) { setDraftId(null); orchestraStore.navigate({ draft: undefined }, 'replace') } }
    // A job that just finished leaves the job list: follow it to the draft it produced.
    if (repo && draftId.startsWith('dj-')) void api.planDraftJob(repo.root, draftId).then((result) => {
      if (!live) return
      const job = result.ok ? result.value.job : undefined
      if (job?.draftId) openDraft(job.draftId)
      else if (job && job.status !== 'discarded' && job.status !== 'completed') setDraftJobs((jobs) => [...jobs, job])
      else clear()
    }).catch(clear)
    else clear()
    return () => { live = false }
  }, [draftsLoaded, drafts, draftJobs, draftId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => { if (!routeRequest?.route.draft) setDraftId(null) }, [repo?.root, repo?.planId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { if (repo?.example && !tourSeen()) setTourStep(0); else setTourStep(null) }, [repo?.root, repo?.planId, repo?.example])
  useEffect(() => { const show = () => { if (repo?.example) { setSettingsOpen(false); setTourStep(0) } }; window.addEventListener('orchestra:show-introduction', show); return () => window.removeEventListener('orchestra:show-introduction', show) }, [repo?.example])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { setRunTrace(null) }, [repo?.root, repo?.planId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { setReviewStack((stack) => stack.filter((frame) => repo?.tasks.some((task) => task.id === frame.detail.taskId))) }, [repo?.root, repo?.planId])
  useEffect(() => {
    const onPop = () => {
      const route = parseRoute(window.location.hash)
      if (route?.view !== 'review') { setReviewStack([]); return }
      const detail: ReviewDetail | undefined = route.task && route.tab === 'review-task' ? { kind: 'task', taskId: route.task } : route.task && route.run && route.tab === 'review-run' ? { kind: 'run', taskId: route.task, runId: route.run, expanded: false } : undefined
      setReviewStack((stack) => detail ? (() => { const index = stack.findLastIndex((frame) => frame.detail.kind === detail.kind && frame.detail.taskId === detail.taskId && (frame.detail.kind !== 'run' || detail.kind !== 'run' || frame.detail.runId === detail.runId)); return index >= 0 ? stack.slice(0, index + 1) : [...stack, { detail }] })() : [])
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    if (!reviewMain.current) return
    const top = reviewStack.at(-1)?.detail
    const beside = top?.kind === 'run' && !top.expanded && reviewWide
    const before = reviewShown.current
    reviewShown.current = top ? { ...(top.kind === 'run' ? { runId: top.runId } : {}), beside } : null
    // Beside the list the page stays where the person is; a full-width detail starts at its top,
    // and closing it returns the list to where it was left.
    if (top && !beside) reviewMain.current.scrollTop = 0
    else if (!top && before && !before.beside) reviewMain.current.scrollTop = reviewScroll.current
    if (!top) requestAnimationFrame(() => {
      const origin = document.querySelector<HTMLElement>('[data-review-origin="true"]') ?? (before?.runId ? document.querySelector<HTMLElement>(`[data-review-run="${CSS.escape(before.runId)}"]`) : null)
      origin?.focus()
    })
  }, [reviewStack, reviewWide])
  const togglePlans = useCallback(() =>
    setPlansOpen((open) => {
      const next = !open
      try {
        globalThis.localStorage?.setItem(PLANS_KEY, next ? '1' : '0')
      } catch {
        /* same storage guard as the store */
      }
      return next
    }), [])

  // The lens's walking order is decided once for the whole screen: n, N and the chip's «›» all
  // follow it, and the board/console scroll to the same first match the graph flies to.
  const order = useMemo(() => (repo && lens ? lensTasks(repo, lens) : []), [repo, lens])
  // A lens that stopped matching anything quietly releases — an empty lens is a dimmed screen, not a lens.
  useEffect(() => {
    if (lens && order.length === 0) setLens(null)
  }, [lens, order.length, setLens])

  const stepLens = (dir: 1 | -1) => {
    if (order.length === 0) return
    const i = order.findIndex((t) => t.id === selectedId)
    const next = i === -1 ? (dir === 1 ? order[0] : order[order.length - 1]) : order[(i + dir + order.length) % order.length]
    if (!next) return
    pick(next.id)
    setWalk((w) => ({ id: next.id, seq: (w?.seq ?? 0) + 1 }))
  }
  const stepLensRef = useRef(stepLens)
  stepLensRef.current = stepLens

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K / Ctrl+K is the global search in the sidebar — across repositories, plans and tasks.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && ['k', 'K', '\u043b', '\u041b'].includes(event.key)) {
        event.preventDefault()
        if (!plansOpen) togglePlans()
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.orc-side__search')?.focus())
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') {
        if (reviewStackRef.current.length) { event.preventDefault(); window.history.back(); return }
        // The trace screen owns Escape while it is open: first its inspector, then itself.
        if (!trace) {
          // Then the queue, then the lens, then the selection — each Escape folds one layer.
          if (queueOpen) setQueueOpen(false)
          else if (lens) setLens(null)
          else select(null)
        }
        return
      }
      if (isTyping(event.target) || trace) return
      if (event.key === '1') { setView('graph'); return }
      if (event.key === '2') { setView('work'); return }
      if (event.key === '3') { setView('review'); return }
      if (event.key === 'd' || event.key === '\u0432' || event.key === 'D' || event.key === '\u0412') {
        if (view !== 'graph') return
        event.preventDefault()
        toggleDensity()
        return
      }
      if (lens && (event.key === 'n' || event.key === '\u0442')) stepLensRef.current(1)
      else if (lens && (event.key === 'N' || event.key === '\u0422')) stepLensRef.current(-1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [select, toggleDensity, trace, queueOpen, setQueueOpen, lens, setLens, setView, view, plansOpen, togglePlans])

  const closeTour = () => { markTourSeen(); setTourStep(null) }
  const moveTour = (step: number) => setTourStep(step)
  // Every way into a step (start, reload, Back / Next, «show introduction») opens the view it talks about.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a step change navigates; later snapshots must not pull the user back.
  useEffect(() => {
    if (tourStep === 0) { setView('graph'); select('build') }
    else if (tourStep === 1) { setView('work'); select(null) }
    else if (tourStep === 2) { setView('review'); select('build') }
    else if (tourStep === 3) select(null)
  }, [tourStep])
  const selected = repo?.tasks.find((t) => t.id === selectedId)

  if (!snapshot && stalled) {
    return (
      <div className="orc-root">
        <div className="orc-broken" role="alert">
          <p>{t('panel.app.stalled')}</p>
          <p>{t('panel.app.stalledHint')}</p>
          <button type="button" className="orc-chip" onClick={resetScreenState}>{t('panel.app.resetState')}</button>
        </div>
      </div>
    )
  }
  if (!snapshot) return <div className="orc-root"><p className="orc-empty">{t('panel.app.loading')}</p></div>
  if (!repo) {
    return (
      <div className="orc-root">
        <WorkerSettingsBanner issue={snapshot.workerSettings} onOpenSettings={() => setSettingsOpen(true)} />
        <Welcome onPreset={() => {}} onExample={() => {}} onDraft={() => {}} onWorkers={() => setSettingsOpen(true)} />
      </div>
    )
  }

  const attentionCount = repo.example ? 0 : repo.attention.length
  const runningCount = repo.example ? 0 : repo.tasks.filter((t) => t.status === 'running').length
  const readyCount = repo.example ? 0 : repo.tasks.filter((t) => t.status === 'ready').length
  // The pill counts the open plan in full (in_review plus human decisions); background plans
  const queueCount = reviewWaiting(repo)
  // Picking a task anywhere hands the right column back to the task panel.
  const pick = (id: string | null) => {
    setMultiIds([])
    select(id)
    if (id !== runTrace?.target.taskId) setRunTrace(null)
    if (id !== null) setQueueOpen(false)
  }
  // A chip row opens the panel on its task and flies the graph camera to it.
  const pickFromChip = (id: string) => {
    pick(id)
    setWalk((w) => ({ id, seq: (w?.seq ?? 0) + 1 }))
  }
  const openTask = (id: string, changes?: boolean) => {
    select(id)
    setQueueOpen(false)
    if (changes) { setPanelTab((old) => ({ tab: 'changes', seq: (old?.seq ?? 0) + 1 })); orchestraStore.navigate({ task: id, tab: 'changes' }, 'replace') }
  }
  const viewProps: ViewProps = { repo, workers: snapshot.workers, selectedId, onSelect: pick, density, lens, setLens, walk, lensStep: stepLens, toggleDensity, lane, setLane: focusLane, onLaneInView: setLaneInView }
  const showTaskMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const origin = (event.target as HTMLElement).closest<HTMLElement>('[data-task-id]')
    const taskId = origin?.dataset.taskId
    if (!origin || !taskId || !repo.tasks.some((task) => task.id === taskId)) return
    event.preventDefault()
    setMenu({ taskId, selectedIds: multiIds.includes(taskId) ? multiIds : undefined, x: event.clientX, y: event.clientY, origin })
  }
  const showKeyboardMenu = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    const origin = (event.target as HTMLElement).closest<HTMLElement>('[data-task-id]') ?? (selectedId ? document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedId)}"]`) : null)
    const taskId = origin?.dataset.taskId
    if (!origin || !taskId) return
    event.preventDefault()
    const rect = origin.getBoundingClientRect()
    setMenu({ taskId, selectedIds: multiIds.includes(taskId) ? multiIds : undefined, x: rect.left + 12, y: rect.top + 12, origin })
  }
  const multiSelect = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey || event.shiftKey)) return
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-task-id]')?.dataset.taskId
    if (!id || !repo.tasks.some((task) => task.id === id)) return
    event.preventDefault(); event.stopPropagation()
    setMultiIds((current) => {
      const next = current.length ? [...current] : selectedId ? [selectedId] : []
      return next.includes(id) ? next.filter((item) => item !== id) : [...next, id]
    })
  }
  const pushReview = (frame: { detail: ReviewDetail; run?: PlanRunCost; summary?: TaskReviewSummary }, replace = false) => {
    if (!reviewStackRef.current.length || reviewShown.current?.beside) reviewScroll.current = reviewMain.current?.scrollTop ?? 0
    setReviewStack((stack) => [...(replace ? stack.slice(0, -1) : stack), frame])
    reviewPushing.current = true
    window.history[replace ? 'replaceState' : 'pushState']({ orchestraReview: true }, '', formatRoute({ repo: repo.root, plan: repo.planId ?? '_', view: 'review', task: frame.detail.taskId, tab: frame.detail.kind === 'run' ? 'review-run' : 'review-task', ...(frame.detail.kind === 'run' ? { run: frame.detail.runId } : {}) }))
    orchestraStore.navigate({ view: 'review', task: frame.detail.taskId, tab: frame.detail.kind === 'run' ? 'review-run' : 'review-task', run: frame.detail.kind === 'run' ? frame.detail.runId : undefined }, replace ? 'replace' : 'push')
  }
  const closeReview = () => window.history.back()
  const currentReview = reviewStack.at(-1)
  const priorReview = reviewStack.at(-2)?.detail
  const reviewBeside = currentReview?.detail.kind === 'run' && !currentReview.detail.expanded && reviewWide
  const reviewDrilldown = currentReview ? (
    <ReviewDrilldown
      repo={repo}
      detail={currentReview.detail}
      run={currentReview.run}
      summary={currentReview.summary}
      beside={reviewBeside}
      backTask={priorReview?.kind === 'task'}
      backRun={priorReview?.kind === 'run'}
      backPanel={priorReview?.kind === 'run' && !priorReview.expanded && reviewWide}
      onBack={closeReview}
      onTask={() => pushReview({ detail: { kind: 'task', taskId: currentReview.detail.taskId }, summary: currentReview.summary })}
      onRun={(runId) => pushReview({ detail: { kind: 'run', taskId: currentReview.detail.taskId, runId, expanded: true }, summary: currentReview.summary })}
      onExpand={() => pushReview({ ...currentReview, detail: { ...currentReview.detail, expanded: true } as ReviewDetail })}
    />
  ) : null

  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: The root delegates context menu and keyboard events to its child controls. */
    <div className={`orc-root${plansOpen ? ' orc-root--rail-open' : ' orc-root--rail-shut'}`} onContextMenu={showTaskMenu} onClickCapture={multiSelect} onKeyDown={showKeyboardMenu}>
      <RepoSidebar snapshot={snapshot} repo={repo} open={plansOpen} onToggle={togglePlans} lanes={{ highlight: view === 'graph' ? laneInView : lane?.lane ?? null, onPick: focusLane, link: orchestraStore.laneLink }} drafts={drafts} draftJobs={draftJobs} selectedDraft={draftId} onDraft={(id) => { setDraftId(id); select(null); setQueueOpen(false); setTrace(null); orchestraStore.navigate({ draft: id, task: undefined, tab: undefined, run: undefined }) }} onPlan={() => { setDraftId(null); orchestraStore.navigate({ draft: undefined }) }} />
      <div className="orc-main">
        <WorkerSettingsBanner issue={snapshot.workerSettings} onOpenSettings={() => { setSettingsOpen(true); orchestraStore.navigate({ view: 'settings' }) }} />
        <header className="orc-top">
          {/* The breadcrumb replaces the repository <select>: where you are, repo / plan. */}
          <span className="orc-crumb">
            <button type="button" className="orc-crumb__repo" title={repo.root} onClick={() => { if (!plansOpen) togglePlans() }}>
              {repoName(repo.root)}
            </button>
            {repo.hasPlan !== false ? (
              <>
                <span className="orc-crumb__sep" aria-hidden="true">/</span>
                <span className="orc-goal" title={repo.goal || repo.root}>
                  {repo.goal || repo.root}
                </span>
              </>
            ) : null}
          </span>
          {repo.hasPlan !== false && repo.degraded && repo.error ? <span className="orc-conn" role="status">⚠ {repoError(repo)}</span> : null}

          <div className="orc-seg" role="radiogroup" aria-label={t('panel.app.view')}>
            {VIEWS.map(({ key, label }) => (
              /* biome-ignore lint/a11y/useSemanticElements: This segmented control uses styled buttons with radio state. */
              <button key={key} type="button" role="radio" className="orc-seg__item" aria-checked={view === key} onClick={() => setView(key)}>
                {t(label)}
              </button>
            ))}
          </div>

          <label className="orc-view-menu">
            <span className="orc-sr-only">{t('panel.app.view')}</span>
            <select className="orc-select" aria-label={t('panel.app.view')} value={view} onChange={(e) => setView(e.target.value as ViewKind)}>
              {VIEWS.map(({ key, label }) => <option key={key} value={key}>{t(label)}</option>)}
            </select>
          </label>

          <span className="orc-top__spacer" />
          {/* Status chips list what they count; a non-zero alarm never folds into a menu. */}
          <LensChip kind="attention" count={attentionCount} repo={repo} active={lens === 'attention'} onLens={setLens} onPick={pickFromChip} />
          <LensChip kind="running" count={runningCount} repo={repo} active={lens === 'running'} onLens={setLens} onPick={pickFromChip} />
          <LensChip kind="ready" count={readyCount} repo={repo} active={lens === 'ready'} onLens={setLens} onPick={pickFromChip} />

          <button
            type="button"
            className={`orc-chip${queueCount > 0 ? ' orc-chip--review' : ' orc-chip--idle'}`}
            aria-pressed={queueOpen}
            title={t('panel.app.queueTitle')}
            onClick={() => setQueueOpen(!queueOpen)}
          >
            <span aria-hidden="true">◐</span> {queueCount > 0 ? t('panel.app.queueCount', { count: queueCount }) : t('panel.app.queueEmpty')}
          </button>

          {repo.example ? null : <OutsidePresetChip tasks={repo.tasks} onPick={pickFromChip} />}
          <PresetPickers repo={repo.root} planId={repo.planId} planTitle={repo.goal} effective={snapshot.repos.find((item) => item.root === repo.root)?.effectiveRouting} check={repo.orchestratorCheck} workers={snapshot.workers} openRequest={presetOpen} onOpenSettings={() => setSettingsOpen(true)} />

          {snapshot.build && BUILD_ID !== 'dev' && snapshot.build !== BUILD_ID ? (
            <span className="orc-conn orc-conn--stale" role="status" title={t('panel.app.hostStaleHint')}>{t('panel.app.hostStale')}</span>
          ) : null}
          {connection === 'reconnecting' ? (
            <span className="orc-conn" role="status">
              <span aria-hidden="true">◌</span> {t('panel.app.disconnected')}
            </span>
          ) : null}
        </header>

        <div className="orc-body">
          <main ref={reviewMain} className={`orc-view${view === 'graph' && !trace && !draftId && !settingsOpen && repo.hasPlan !== false && repo.tasks.length > 0 && tourStep !== 3 ? ' orc-view--bleed' : ''}`}>
            <PartBoundary area={t('panel.app.areaMain')}>
            {settingsOpen ? <SettingsScreen onClose={() => { setSettingsOpen(false); orchestraStore.navigate({ view: 'graph' }) }} /> : !draftId && !trace && (repo.hasPlan === false || repo.tasks.length === 0 || tourStep === 3) ? <Welcome repo={repo} onPreset={() => setPresetOpen((n) => n + 1)} onExample={() => { void api.exampleCreate(repo.root, getLang()).then((r) => { if (r.ok) { setTourStep(0); setView('graph') } }) }} onDraft={(id) => { setDraftId(id); orchestraStore.navigate({ draft: id }) }} onWorkers={() => { setSettingsOpen(true); orchestraStore.navigate({ view: 'settings' }) }} /> : draftId && selectedJob ? <DraftJobView key={`${repo.root}:${draftId}`} repo={repo.root} job={selectedJob} onDraft={openDraft} onClose={() => { setDraftId(null); orchestraStore.navigate({ draft: undefined }) }} onDiscarded={() => { setDraftId(null); setDraftRefresh((n) => n + 1); orchestraStore.navigate({ draft: undefined }) }} /> : draftId?.startsWith('dj-') ? null : draftId ? <DraftReview key={`${repo.root}:${draftId}`} repo={repo.root} id={draftId} onClose={() => { setDraftId(null); orchestraStore.navigate({ draft: undefined }) }} onDiscarded={() => { setDraftId(null); setDraftRefresh((n) => n + 1); orchestraStore.navigate({ draft: undefined }) }} onApproved={() => { setDraftId(null); setDraftRefresh((n) => n + 1); orchestraStore.navigate({ draft: undefined }) }} /> : trace ? (
              <TraceScreen
                repo={snapshot.repos.find((item) => item.root === repo.root) ?? repo}
                workers={snapshot.workers}
                target={trace}
                density={density}
                onClose={() => { setTrace(null); orchestraStore.navigate({ run: undefined }) }}
                onSteerFrom={(text) => {
                  select(trace.taskId)
                  setSteerDraft((old) => ({ taskId: trace.taskId, text, seq: (old?.seq ?? 0) + 1 }))
                }}
              />
            ) : (
              <>
                {view === 'graph' ? <GraphView {...viewProps} /> : null}
                {view === 'work' ? <WorkView {...viewProps} onOpenQueue={() => setQueueOpen(true)} /> : null}
                {view === 'review' ? <><div style={{ display: currentReview && !reviewBeside ? 'none' : undefined }}><ReviewView {...viewProps} selectedRunId={reviewBeside && currentReview?.detail.kind === 'run' ? currentReview.detail.runId : undefined} detail={reviewBeside ? reviewDrilldown : undefined} onTrace={(target) => { setTrace(target); orchestraStore.navigate({ task: target.taskId, run: target.run.runId }) }} onReviewRun={(run, summary) => { document.querySelectorAll('[data-review-origin]').forEach((node) => { node.removeAttribute('data-review-origin') }); document.querySelector(`[data-review-run="${CSS.escape(run.runId)}"]`)?.setAttribute('data-review-origin', 'true'); const replace = !!reviewBeside && reviewStackRef.current.length === 1; if (!replace) pick(run.taskId); pushReview({ detail: { kind: 'run', taskId: run.taskId, runId: run.runId, expanded: false }, run, summary }, replace) }} onReviewTask={(taskId, summary) => { document.querySelectorAll('[data-review-origin]').forEach((node) => { node.removeAttribute('data-review-origin') }); document.querySelector(`[data-review-task="${CSS.escape(taskId)}"]`)?.setAttribute('data-review-origin', 'true'); pick(taskId); pushReview({ detail: { kind: 'task', taskId }, summary }) }} /></div>{currentReview && !reviewBeside ? reviewDrilldown : null}</> : null}
              </>
            )}
          </PartBoundary>
          </main>
          <PartBoundary area={t('panel.app.areaSide')}>
          {queueOpen ? (
            <ReviewQueue repo={repo} onOpenTask={openTask} onClose={() => setQueueOpen(false)} />
          ) : selected && !currentReview && tourStep !== 3 ? (
            <TaskPanel
              repo={snapshot.repos.find((item) => item.root === repo.root) ?? repo}
              workers={snapshot.workers}
              task={selected}
              attention={repo.attention.filter((a) => a.taskId === selected.id)}
              onSelect={pick}
              density={density}
              onTrace={(target) => { setTrace(target); orchestraStore.navigate({ task: target.taskId, run: target.run.runId }) }}
              onTabChange={(tab) => orchestraStore.navigate({ task: selected.id, tab }, 'replace')}
              {...(runTrace?.target.taskId === selected.id ? { runTraceRequest: runTrace } : {})}
              {...(steerDraft ? { steerDraft } : {})}
              {...(panelTab ? { tabRequest: panelTab } : {})}
            />
          ) : null}
          </PartBoundary>
        </div>
      </div>
      {tourStep !== null && repo.example ? <Tour step={tourStep} onStep={moveTour} onClose={closeTour} /> : null}
      {menu && !repo.example ? <TaskMenu key={`${menu.taskId}:${menu.x}:${menu.y}`} request={menu} repo={repo} workers={snapshot.workers} onClose={() => setMenu(null)} onSelect={pick} onTab={(tab) => setPanelTab((old) => ({ tab, seq: (old?.seq ?? 0) + 1 }))} onTrace={(known?: TaskDetail) => { const show = (detail: TaskDetail) => { const run = detail.runs.at(-1); if (run) setTrace({ taskId: detail.id, taskTitle: detail.title, run: { runId: run.runId, agent: run.agent, startedAt: run.startedAt, active: !run.finishedAt } }) }; if (known) show(known); else void api.task(repo.root, menu.taskId).then((result) => { if (result.ok) show(result.value) }) }} onGraph={() => { setView('graph'); pick(menu.taskId); setWalk((old) => ({ id: menu.taskId, seq: (old?.seq ?? 0) + 1 })) }} /> : null}
    </div>
  )
}

/** Orchestration settings inside the screen: dsh exposes no call that opens its Settings dialog on a section. */
function SettingsScreen({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return <section className="orc-settings-screen" aria-label={t('settings.section')}>
    <header className="orc-settings-screen__head"><h1>{t('settings.section')}</h1><button type="button" className="orc-chip" onClick={onClose}>{t('panel.draft.close')}</button></header>
    <OrchestraSettings />
  </section>
}
