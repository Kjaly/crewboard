import { CircleHalf, HandWaving, List } from './icons.js'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { flatten } from '../model/project.js'
import type { AssignmentView, GoalEvent, ProviderId, RequestAction } from '../model/types.js'
import type { ProjectSummary } from '../owner.js'
import { type Api, type HandoffPick, type LiveChange, type SendResult, coalesce } from './api.js'
import { type ActionHandle, type ActionMode, Actions } from './components/actions.js'
import { ContextPanel } from './components/context-panel.js'
import { EmptyState } from './components/empty-state.js'
import { OfflineBanner } from './components/offline-banner.js'
import { QuestionBox } from './components/question-box.js'
import { AnalyticsView } from './components/analytics-view.js'
import { HistoryView } from './components/history-view.js'
import type { GoalAnalytics } from '../analytics.js'
import { UsagePanel } from './components/usage-panel.js'
import { SettingsView } from './components/settings-view.js'
import { Sidebar } from './components/sidebar.js'
import type { GoalHistory } from '../history/sessions.js'
import { Summary, countTree } from './components/summary.js'
import { Tree } from './components/tree.js'
import { setAgents } from './agents.js'
import { Drafts } from './drafts.js'
import { useAnnouncements } from './use-announcements.js'
import { T, lang, setLang } from './text.js'

type Target = { project: string; goalId: string }
type Loaded<V> = { key: string; data?: V; failed?: boolean }
const targetKey = (t: Target | undefined) => JSON.stringify(t ? [t.project, t.goalId] : [])

const store = {
  get<V>(key: string): V | undefined {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as V) : undefined
    } catch {
      return undefined
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage may be unavailable (private window); the screen works without it.
    }
  },
}

/** The goal to open: the remembered one if it still exists, else the first that waits for the owner, else the newest. */
export function pickTarget(projects: ProjectSummary[], remembered?: Target): Target | undefined {
  const all = projects.flatMap((p) => p.goals.map((g) => ({ project: p.repo, goalId: g.goalId, g })))
  if (remembered && all.some((x) => x.project === remembered.project && x.goalId === remembered.goalId)) return remembered
  const waiting = all.find((x) => x.g.counts.waiting_owner > 0)
  const newest = [...all].sort((a, b) => b.g.createdAt.localeCompare(a.g.createdAt))[0]
  const pick = waiting ?? newest
  return pick ? { project: pick.project, goalId: pick.goalId } : undefined
}

/** The node the panel shows: the chosen one while it exists, else the first waiting for the owner, else the root. */
export function effectiveSelection(root: AssignmentView, chosen: string | undefined): AssignmentView {
  const nodes = flatten(root)
  return nodes.find((n) => n.id === chosen) ?? nodes.find((n) => n.status === 'waiting_owner') ?? root
}

const chainOf = (root: AssignmentView, id: string): AssignmentView[] => {
  const byId = new Map(flatten(root).map((n) => [n.id, n]))
  const chain: AssignmentView[] = []
  for (let p = byId.get(id)?.parentId; p; p = byId.get(p)?.parentId ?? null) {
    const n = byId.get(p)
    if (n) chain.unshift(n)
  }
  return chain
}

const PRESENCE_POLL_MS = 30_000
const HISTORY_POLL_MS = 10_000
const SHEET_QUERY = '(max-width: 980px)'
const sheetQuery = () => (typeof matchMedia === 'function' ? matchMedia(SHEET_QUERY) : undefined)
const subscribeSheet = (onChange: () => void) => {
  const query = sheetQuery()
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}
/** Narrow screens show the context as a bottom sheet. */
const useSheet = () => useSyncExternalStore(subscribeSheet, () => sheetQuery()?.matches ?? false, () => false)

export function App(props: { api: Api }) {
  const { api } = props
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>()
  const [target, setTarget] = useState<Target | undefined>()
  const key = targetKey(target)
  const drafts = useRef(new Map<string, string>())
  const [treeLoad, setTreeLoad] = useState<Loaded<AssignmentView>>()
  const tree = treeLoad?.key === key ? treeLoad.data : undefined
  const [projectsFailed, setProjectsFailed] = useState(false)
  const [chosen, setChosen] = useState<string | undefined>()
  const [eventLoad, setEventLoad] = useState<Loaded<GoalEvent[]>>()
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [online, setOnline] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const actionsRef = useRef<ActionHandle>(null)
  const [mode, setMode] = useState<ActionMode>('idle')
  const [navOpen, setNavOpen] = useState(false)
  const [view, setView] = useState<'now' | 'history' | 'analytics' | 'settings'>(() => store.get<'now' | 'history' | 'analytics' | 'settings'>('crewboard.view') ?? 'now')
  const [historyLoad, setHistoryLoad] = useState<Loaded<GoalHistory>>()
  const [analyticsLoad, setAnalyticsLoad] = useState<Loaded<GoalAnalytics>>()
  const history = historyLoad?.key === key ? historyLoad : undefined
  const analytics = analyticsLoad?.key === key ? analyticsLoad : undefined
  const [focusAssignment, setFocusAssignment] = useState<string | undefined>()
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
    store.set('crewboard.view', view)
  }, [view])
  const sheet = useSheet()
  const loads = useRef({ tree: 0, history: 0, analytics: 0 })
  const targetRef = useRef(target)
  targetRef.current = target

  // The registry's agents: labels, colours and who work can be handed to. Re-read with the projects, so an edit
  // of agents.json reaches the screen without a reload.
  const [, setAgentsShown] = useState(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const loadAgents = useCallback(async () => {
    const list = await api.agents().catch(() => undefined)
    // The list is module-wide: a screen already gone must not overwrite what the current one loaded.
    if (!list || !mounted.current) return
    setAgents(list)
    setAgentsShown((n) => n + 1)
  }, [api])

  const loadProjects = useCallback(async () => {
    void loadAgents()
    let list: ProjectSummary[]
    try {
      list = await api.projects()
      setProjectsFailed(false)
    } catch {
      setProjectsFailed(true)
      return false
    }
    setProjects(list)
    setTarget((current) => pickTarget(list, current ?? store.get<Target>('crewboard.target')))
    return true
  }, [api, loadAgents])

  const loadTree = useCallback(
    async (t: Target | undefined) => {
      if (!t) return
      const k = targetKey(t)
      const version = ++loads.current.tree
      try {
        const next = await api.goal(t.project, t.goalId)
        if (targetKey(targetRef.current) !== k || version !== loads.current.tree) return
        setTreeLoad({ key: k, data: next })
      } catch {
        if (targetKey(targetRef.current) !== k || version !== loads.current.tree) return
        setTreeLoad((have) => ({ key: k, data: have?.key === k ? have.data : undefined, failed: true }))
        throw new Error(T.loadFailed)
      }
    },
    [api],
  )

  useEffect(() => {
    void loadProjects()
    // Lead presence changes with time, not only with journal events: re-read it periodically.
    const timer = setInterval(() => void loadProjects().catch(() => undefined), PRESENCE_POLL_MS)
    return () => clearInterval(timer)
  }, [loadProjects])

  useEffect(() => {
    if (target) store.set('crewboard.target', target)
    void loadTree(target).catch(() => undefined)
  }, [target, loadTree])

  const loadHistory = useCallback(
    async (t: Target | undefined) => {
      if (!t) return
      const k = targetKey(t)
      const version = ++loads.current.history
      setHistoryLoad((have) => have?.key === k && !have.failed ? have : { key: k })
      try {
        const next = await api.history(t.project, t.goalId)
        if (targetKey(targetRef.current) === k && version === loads.current.history) setHistoryLoad({ key: k, data: next })
      } catch {
        if (targetKey(targetRef.current) === k && version === loads.current.history) setHistoryLoad({ key: k, failed: true })
      }
    },
    [api],
  )
  const loadAnalytics = useCallback(
    async (t: Target | undefined) => {
      if (!t) return
      const k = targetKey(t)
      const version = ++loads.current.analytics
      setAnalyticsLoad((have) => have?.key === k && !have.failed ? have : { key: k })
      try {
        const next = await api.analytics(t.project, t.goalId)
        if (targetKey(targetRef.current) === k && version === loads.current.analytics) setAnalyticsLoad({ key: k, data: next })
      } catch {
        if (targetKey(targetRef.current) === k && version === loads.current.analytics) setAnalyticsLoad({ key: k, failed: true })
      }
    },
    [api],
  )

  useEffect(() => {
    if (view === 'history') void loadHistory(target)
    if (view === 'analytics') void loadAnalytics(target)
    if (view !== 'history') return
    // The owner and the lead talk without touching the journal: re-read the conversation while it is on screen.
    const timer = setInterval(() => void loadHistory(targetRef.current), HISTORY_POLL_MS)
    return () => clearInterval(timer)
  }, [view, target, loadHistory, loadAnalytics])

  useEffect(() => {
    const batch = coalesce<LiveChange>((changes) => {
      const t = targetRef.current
      if (t && changes.some((c) => c.project === t.project && c.goalId === t.goalId)) {
        void loadTree(t).catch(() => undefined)
        if (viewRef.current === 'history') void loadHistory(t)
        if (viewRef.current === 'analytics') void loadAnalytics(t)
      }
      void loadProjects()
    }, 250)
    let wasOffline = false
    const stop = api.live(
      (c) => batch.push(c),
      (isOnline) => {
        setOnline(isOnline)
        if (!isOnline) wasOffline = true
        else if (wasOffline) {
          wasOffline = false
          void loadProjects()
          void loadTree(targetRef.current).catch(() => undefined)
        }
      },
    )
    return () => {
      batch.cancel()
      stop()
    }
  }, [api, loadProjects, loadTree, loadHistory, loadAnalytics])

  const announcement = useAnnouncements(target?.project, target?.goalId, tree)
  const selected = useMemo(() => (tree ? effectiveSelection(tree, chosen) : undefined), [tree, chosen])

  const draftKey = JSON.stringify([target?.project, target?.goalId, selected?.id])
  const events = eventLoad?.key === draftKey ? eventLoad.data ?? [] : []
  useEffect(() => {
    if (!target || !selected) return
    setEventLoad((have) => have?.key === draftKey ? have : { key: draftKey })
    let cancelled = false
    api.events(target.project, target.goalId, selected.id).then(
      (list) => !cancelled && setEventLoad({ key: draftKey, data: list }),
      () => !cancelled && setEventLoad({ key: draftKey, data: [] }),
    )
    return () => {
      cancelled = true
    }
  }, [api, target, selected, draftKey])

  const navigate = useCallback((id: string) => {
    setChosen(id)
    setMode('idle')
  }, [])
  const select = useCallback((id: string) => {
    navigate(id)
    setNavOpen(false)
    setSheetOpen(true)
  }, [navigate])

  const toggleTheme = () => {
    const root = document.documentElement
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'light' : 'dark'
    try {
      localStorage.setItem('crewboard.theme', root.dataset.theme)
    } catch {
      // The choice simply is not remembered.
    }
  }

  const [, setShownLang] = useState(lang)
  const switchLang = () => {
    const next = lang === 'ru' ? 'en' : 'ru'
    setLang(next, true)
    setShownLang(next)
  }

  const escalation = selected?.status === 'waiting_owner' ? events.findLast((e) => e.type === 'escalated') : undefined
  const refresh = async (): Promise<SendResult> => {
    const results = await Promise.allSettled([loadTree(target), loadProjects()])
    return { refreshFailed: results.some((result) => result.status === 'rejected' || result.value === false) }
  }
  const answer = async (text: string) => {
    if (!target || !selected) throw new Error(T.question.failed)
    // Keep the answered node selected when it stops waiting.
    setChosen(selected.id)
    const result = await api.answer(target.project, target.goalId, selected.id, text)
    if (result === 'conflict') throw new Error(T.question.conflict)
    return refresh()
  }

  const currentGoal = projects?.find((p) => p.repo === target?.project)?.goals.find((g) => g.goalId === target?.goalId)
  const leadClient = currentGoal?.lead
  const leadOnline = currentGoal?.leadOnline ?? true
  const request = async (action: RequestAction, text?: string, provider?: ProviderId, pick?: HandoffPick) => {
    if (!target || !selected) throw new Error(T.requestFailed)
    setChosen(selected.id)
    const result = await api.request(target.project, target.goalId, selected.id, action, text, provider, pick)
    if (result === 'conflict') throw new Error(T.requestConflict)
    return refresh()
  }
  const withdrawRequest = async () => {
    if (!target || !selected?.request) throw new Error(T.requestFailed)
    const result = await api.withdrawRequest(target.project, target.goalId, selected.id, selected.request.id)
    if (result === 'conflict') {
      await refresh()
      throw new Error(T.withdrawConflict)
    }
    return refresh()
  }
  const stopNow = async () => {
    if (!target || !selected) throw new Error(T.requestFailed)
    const result = await api.emergencyStop(target.project, target.goalId, selected.id)
    if (result === 'conflict') throw new Error(T.stopConflict)
    return refresh()
  }
  const discuss = async () => {
    if (!target || !selected) throw new Error(T.requestFailed)
    const prompt = T.discussPrompt(selected.title, target.goalId, selected.id)
    const result = await request('discuss')
    let copied = false
    try {
      await navigator.clipboard.writeText(prompt)
      copied = true
    } catch {
      // The notification succeeded; the owner can copy the message by hand.
    }
    return { ...result, copied, prompt }
  }
  const shortcut = (key: string) => {
    setSheetOpen(true)
    if (key === 's') actionsRef.current?.click('stop')
    if (key === 'c') actionsRef.current?.click('discuss')
    if (key === 'u') actionsRef.current?.click('clarify')
    if (key === 'p') actionsRef.current?.click('handoff')
  }

  const counts = useMemo(() => (tree ? countTree(tree) : undefined), [tree])
  const waitingAll = (projects ?? []).reduce((n, p) => n + p.goals.reduce((m, g) => m + g.counts.waiting_owner, 0), 0)
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const showWaiting = () => {
    setView('now')
    setNavOpen(false)
    setSheetOpen(true)
    setMode('idle')
    const w = tree && flatten(tree).find((n) => n.status === 'waiting_owner')
    if (w) return select(w.id)
    // Nothing waits in this goal: open the first goal, in any project, where something does.
    const elsewhere = projects?.flatMap((p) => p.goals.map((g) => ({ project: p.repo, g }))).find((x) => x.g.counts.waiting_owner > 0)
    if (elsewhere) {
      setTarget({ project: elsewhere.project, goalId: elsewhere.g.goalId })
      setChosen(undefined)
    }
  }

  const clearFocus = useCallback(() => setFocusAssignment(undefined), [])
  const pick = (project: string, goalId: string) => {
    setTarget({ project, goalId })
    setChosen(undefined)
    setMode('idle')
    setSheetOpen(false)
    setNavOpen(false)
  }

  return (
    // No project yet means no goals sidebar: the screen takes the whole width instead of the sidebar's column.
    <Drafts.Provider value={drafts.current}>
    <div className={projects && projects.length > 0 ? 'shell' : 'shell solo'}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true"><span key={announcement.id}>{announcement.text}</span></div>
      {projects && projects.length > 0 && <Sidebar projects={projects} project={target?.project} goalId={target?.goalId} onPick={pick} drawer={sheet} open={navOpen} onClose={() => setNavOpen(false)} footer={<UsagePanel api={api} />} />}
      {sheet && navOpen && <div className="scrim on nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="app">
      <header className="top">
        {sheet && projects && projects.length > 0 && (
          <button type="button" className="icon-btn press" aria-label={T.goalsButton} aria-expanded={navOpen} onClick={() => { setSheetOpen(false); setNavOpen((v) => !v) }}>
            <List size={16} />
          </button>
        )}
        <div className="goal">
          <h1>{tree?.title ?? T.appTitle}</h1>
          {target && <p>{projects?.find((p) => p.repo === target.project)?.name}</p>}
        </div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'now'} className="press" onClick={() => setView('now')}>
            {T.tabs.now}
            {view === 'now' && <span className="bar" aria-hidden="true" />}
          </button>
          <button type="button" role="tab" aria-selected={view === 'history'} className="press" onClick={() => setView('history')}>
            {T.tabs.history}
            {view === 'history' && <span className="bar" aria-hidden="true" />}
          </button>
          <button type="button" role="tab" aria-selected={view === 'analytics'} className="press" onClick={() => setView('analytics')}>
            {T.tabs.analytics}
            {view === 'analytics' && <span className="bar" aria-hidden="true" />}
          </button>
          <button type="button" role="tab" aria-selected={view === 'settings'} className="press" onClick={() => setView('settings')}>
            {T.tabs.settings}
            {view === 'settings' && <span className="bar" aria-hidden="true" />}
          </button>
        </div>
        <button type="button" className="ask-btn press" aria-label={T.askButtonLabel(waitingAll)} data-has={waitingAll > 0} disabled={waitingAll === 0} onClick={showWaiting}>
          <HandWaving size={16} aria-hidden="true" />
          <span className="lbl">{T.askButton}</span>
          <b>{waitingAll}</b>
        </button>
        <button type="button" className="icon-btn lang-btn press" aria-label={T.switchLang} title={T.switchLang} onClick={switchLang}>
          {T.langCode}
        </button>
        <button type="button" className="icon-btn press" aria-label={T.theme} onClick={toggleTheme}>
          <CircleHalf size={16} />
        </button>
      </header>
      {!online && <OfflineBanner />}
      {projectsFailed && <div role="alert"><p>{T.loadFailed}</p><button type="button" className="btn press" onClick={() => void loadProjects()}>{T.retry}</button></div>}
      {projects === undefined && !projectsFailed && <p className="hint">{T.loading}</p>}
      {target && !tree && view !== 'settings' && (treeLoad?.key === key && treeLoad.failed ? <div role="alert"><p>{T.loadFailed}</p><button type="button" className="btn press" onClick={() => void loadTree(target).catch(() => undefined)}>{T.retry}</button></div> : <p className="hint">{T.loading}</p>)}
      {tree && treeLoad?.failed && view !== 'settings' && <p className="hint-line">{T.loadFailed} <button type="button" className="btn press" onClick={() => void loadTree(target).catch(() => undefined)}>{T.retry}</button></p>}
      {projects !== undefined && !target && view !== 'settings' && <EmptyState api={api} />}
      {view === 'settings' && <SettingsView api={api} onSaved={() => { void loadAgents(); void loadTree(target).catch(() => undefined) }} />}
      {tree && view === 'history' && (
        <section role="tabpanel" aria-label={T.tabs.history} className="panel-history">
          <HistoryView
            history={history?.data}
            failed={history?.failed}
            onRetry={() => void loadHistory(target)}
            tree={tree}
            focusAssignment={focusAssignment}
            onFocused={clearFocus}
            onOpenNode={(id) => {
              setView('now')
              select(id)
            }}
          />
        </section>
      )}
      {tree && view === 'analytics' && (
        <section role="tabpanel" aria-label={T.tabs.analytics} className="panel-analytics">
          <AnalyticsView analytics={analytics?.data} failed={analytics?.failed} onRetry={() => void loadAnalytics(target)} />
        </section>
      )}
      {tree && selected && counts && view === 'now' && (
        <div className="now" role="tabpanel" aria-label={T.tabs.now}>
          <div className="left">
            <Summary counts={counts} onWaiting={showWaiting} />
            <Tree key={key} api={api} project={target?.project ?? ''} root={tree} selectedId={selected.id} onSelect={select} onNavigate={navigate} open={open} onToggle={toggle} onShortcut={shortcut} leadClient={leadClient} />
          </div>
          <ContextPanel
            lead={leadClient}
            onOpenHistory={() => {
              setFocusAssignment(selected.id)
              setView('history')
            }}
            actions={<Actions actionRef={actionsRef} loadModels={props.api.models} key={draftKey} draftKey={draftKey} node={selected} leadOnline={leadOnline} mode={mode} onMode={setMode} onRequest={request} onWithdraw={withdrawRequest} onEmergencyStop={stopNow} onDiscuss={discuss} />}
            question={escalation?.type === 'escalated' ? <QuestionBox key={JSON.stringify([draftKey, escalation.text, escalation.seq])} draftKey={draftKey} question={escalation.text} why={escalation.why} options={escalation.options} onAnswer={answer} /> : undefined}
            node={selected} chain={chainOf(tree, selected.id)} events={events} onSelect={select} sheet={sheet} open={sheetOpen} onClose={() => setSheetOpen(false)} />
          {sheet && <div className={`scrim ${sheetOpen ? 'on' : ''}`} onClick={() => setSheetOpen(false)} aria-hidden="true" />}
        </div>
      )}
      </div>
    </div>
    </Drafts.Provider>
  )
}
