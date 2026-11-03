import { CircleHalf, HandWaving, List } from './icons.js'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { flatten } from '../model/project.js'
import { availableActions } from '../model/project.js'
import type { AssignmentView, GoalEvent, ProviderId, RequestAction } from '../model/types.js'
import type { ProjectSummary } from '../owner.js'
import { type Api, type HandoffPick, type LiveChange, coalesce } from './api.js'
import { type ActionMode, Actions } from './components/actions.js'
import { ContextPanel } from './components/context-panel.js'
import { EmptyState } from './components/empty-state.js'
import { OfflineBanner } from './components/offline-banner.js'
import { QuestionBox } from './components/question-box.js'
import { AnalyticsView } from './components/analytics-view.js'
import { HistoryView } from './components/history-view.js'
import type { GoalAnalytics } from '../analytics.js'
import { UsagePanel } from './components/usage-panel.js'
import { Sidebar } from './components/sidebar.js'
import type { GoalHistory } from '../history/sessions.js'
import { Summary, countTree } from './components/summary.js'
import { Tree } from './components/tree.js'
import { setAgents } from './agents.js'
import { T, lang, setLang } from './text.js'

type Target = { project: string; goalId: string }

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
  const [tree, setTree] = useState<AssignmentView | undefined>()
  const [chosen, setChosen] = useState<string | undefined>()
  const [events, setEvents] = useState<GoalEvent[]>([])
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [online, setOnline] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [mode, setMode] = useState<ActionMode>('idle')
  const [navOpen, setNavOpen] = useState(false)
  const [view, setView] = useState<'now' | 'history' | 'analytics'>(() => store.get<'now' | 'history' | 'analytics'>('crewboard.view') ?? 'now')
  const [history, setHistory] = useState<GoalHistory | undefined>()
  const [analytics, setAnalytics] = useState<GoalAnalytics | undefined>()
  const [focusAssignment, setFocusAssignment] = useState<string | undefined>()
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
    store.set('crewboard.view', view)
  }, [view])
  const sheet = useSheet()
  const targetRef = useRef(target)
  useEffect(() => {
    targetRef.current = target
  }, [target])

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
    const list = await api.projects()
    setProjects(list)
    setTarget((current) => pickTarget(list, current ?? store.get<Target>('crewboard.target')))
  }, [api, loadAgents])

  const loadTree = useCallback(
    async (t: Target | undefined) => {
      if (!t) return setTree(undefined)
      const next = await api.goal(t.project, t.goalId)
      // A slow answer for a goal the owner already left must not replace the goal now on screen.
      const now = targetRef.current
      if (now && (now.project !== t.project || now.goalId !== t.goalId)) return
      setTree(next)
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
    void loadTree(target)
  }, [target, loadTree])

  const loadHistory = useCallback(
    async (t: Target | undefined) => {
      if (!t) return setHistory(undefined)
      const next = await api.history(t.project, t.goalId).catch(() => ({ available: false, truncated: false, items: [] }))
      const now = targetRef.current
      if (now && (now.project !== t.project || now.goalId !== t.goalId)) return
      setHistory(next)
    },
    [api],
  )
  const loadAnalytics = useCallback(
    async (t: Target | undefined) => {
      if (!t) return setAnalytics(undefined)
      const next = await api.analytics(t.project, t.goalId).catch(() => undefined)
      const now = targetRef.current
      if (now && (now.project !== t.project || now.goalId !== t.goalId)) return
      setAnalytics(next)
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
        void loadTree(t)
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
          void loadTree(targetRef.current)
        }
      },
    )
    return () => {
      batch.cancel()
      stop()
    }
  }, [api, loadProjects, loadTree, loadHistory, loadAnalytics])

  const selected = useMemo(() => (tree ? effectiveSelection(tree, chosen) : undefined), [tree, chosen])

  useEffect(() => {
    if (!target || !selected) return setEvents([])
    let cancelled = false
    api.events(target.project, target.goalId, selected.id).then(
      (list) => !cancelled && setEvents(list),
      () => !cancelled && setEvents([]),
    )
    return () => {
      cancelled = true
    }
  }, [api, target, selected])

  const select = useCallback((id: string) => {
    setChosen(id)
    setMode('idle')
    setSheetOpen(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSheetOpen(false)
        setNavOpen(false)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

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
  const answer = async (text: string) => {
    if (!target || !selected) return
    // Pin the node: once answered it stops waiting, and the default selection would jump away from it.
    setChosen(selected.id)
    // 'conflict' means the state moved on (someone already answered): refreshing shows the truth, not an error.
    await api.answer(target.project, target.goalId, selected.id, text)
    await Promise.all([loadTree(target), loadProjects()])
  }

  const currentGoal = projects?.find((p) => p.repo === target?.project)?.goals.find((g) => g.goalId === target?.goalId)
  const leadClient = currentGoal?.lead
  const leadOnline = currentGoal?.leadOnline ?? true
  const refresh = () => Promise.all([loadTree(target), loadProjects()])
  const request = async (action: RequestAction, text?: string, provider?: ProviderId, pick?: HandoffPick) => {
    if (!target || !selected) return
    setChosen(selected.id)
    // 'conflict' means a request already waits or the node moved on: the refreshed node shows which.
    await api.request(target.project, target.goalId, selected.id, action, text, provider, pick)
    await refresh()
  }
  const stopNow = async () => {
    if (!target || !selected) return
    await api.emergencyStop(target.project, target.goalId, selected.id)
    await refresh()
  }
  const discuss = async () => {
    if (!target || !selected) return
    try {
      await navigator.clipboard.writeText(T.discussPrompt(selected.title, target.goalId, selected.id))
    } catch {
      // Clipboard refused: the lead still hears about it through its inbox.
    }
    await request('discuss')
  }
  const shortcut = (key: string) => {
    if (!selected) return
    const allowed = availableActions(selected)
    setSheetOpen(true)
    if (key === 's' && allowed.includes('stop')) void request('stop').catch(() => undefined)
    if (key === 'c') void discuss().catch(() => undefined)
    if (key === 'u' && allowed.includes('clarify')) setMode('clarify')
    if (key === 'p' && allowed.includes('handoff')) setMode('handoff')
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
    setNavOpen(false)
  }

  return (
    // No project yet means no goals sidebar: the screen takes the whole width instead of the sidebar's column.
    <div className={projects && projects.length > 0 ? 'shell' : 'shell solo'}>
      {projects && projects.length > 0 && <Sidebar projects={projects} project={target?.project} goalId={target?.goalId} onPick={pick} drawer={sheet} open={navOpen} footer={<UsagePanel api={api} />} />}
      {sheet && navOpen && <div className="scrim on nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="app">
      <header className="top">
        {sheet && projects && projects.length > 0 && (
          <button type="button" className="icon-btn press" aria-label={T.goalsButton} aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>
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
          </button>
          <button type="button" role="tab" aria-selected={view === 'history'} className="press" onClick={() => setView('history')}>
            {T.tabs.history}
          </button>
          <button type="button" role="tab" aria-selected={view === 'analytics'} className="press" onClick={() => setView('analytics')}>
            {T.tabs.analytics}
          </button>
        </div>
        <button type="button" className="ask-btn press" data-has={waitingAll > 0} disabled={waitingAll === 0} onClick={showWaiting}>
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
      {projects === undefined && <p className="hint">{T.loading}</p>}
      {projects !== undefined && !target && <EmptyState api={api} />}
      {tree && view === 'history' && (
        <section role="tabpanel" aria-label={T.tabs.history} className="panel-history">
          <HistoryView
            history={history}
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
          <AnalyticsView analytics={analytics} />
        </section>
      )}
      {tree && selected && counts && view === 'now' && (
        <div className="now" role="tabpanel" aria-label={T.tabs.now}>
          <div className="left">
            <Summary counts={counts} onWaiting={showWaiting} />
            <Tree api={api} project={target?.project ?? ''} root={tree} selectedId={selected.id} onSelect={select} open={open} onToggle={toggle} onShortcut={shortcut} leadClient={leadClient} />
          </div>
          <ContextPanel
            lead={leadClient}
            onOpenHistory={() => {
              setFocusAssignment(selected.id)
              setView('history')
            }}
            actions={<Actions key={selected.id} node={selected} leadOnline={leadOnline} mode={mode} onMode={setMode} onRequest={request} onEmergencyStop={stopNow} onDiscuss={discuss} />}
            question={escalation?.type === 'escalated' ? <QuestionBox question={escalation.text} why={escalation.why} options={escalation.options} onAnswer={answer} /> : undefined}
            node={selected} chain={chainOf(tree, selected.id)} events={events} onSelect={select} sheet={sheet} open={sheetOpen} onClose={() => setSheetOpen(false)} />
          {sheet && <div className={`scrim ${sheetOpen ? 'on' : ''}`} onClick={() => setSheetOpen(false)} aria-hidden="true" />}
        </div>
      )}
      </div>
    </div>
  )
}
