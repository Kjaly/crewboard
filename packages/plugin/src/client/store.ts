import { useSyncExternalStore } from 'react'
import { API_PREFIX, type OrchestraSnapshot, type RepoSnapshot } from '../shared/types.js'
import { api } from './api.js'
import type { Lens } from './lens.js'
import { acceptableTasks, firstWaiting, type WaitingTarget } from './review.js'
import { createRouteController, formatRoute, parseRoute, type OrchestraRoute } from './route.js'
import { selectMainPanel } from './layout.js'
import { PANEL_ID } from '../shared/types.js'

export type { Lens }
export type ViewKind = 'graph' | 'work' | 'review'
export type Density = 'overview' | 'detail'
export type Connection = 'live' | 'reconnecting'

export type Orchestra = {
  snapshot: OrchestraSnapshot | null
  connection: Connection
  repo: RepoSnapshot | undefined
  selectedId: string | null
  select(id: string | null): void
  view: ViewKind
  setView(v: ViewKind): void
  density: Density
  toggleDensity(): void
  setRepo(root: string): void
  /** The active lens of the current plan: matching tasks stay bright, the rest only dim. */
  lens: Lens | null
  setLens(lens: Lens | null): void
  /** The review queue and task panel share the right column. */
  queueOpen: boolean
  setQueueOpen(open: boolean): void
  routeRequest: { route: OrchestraRoute; seq: number } | null
}

type State = {
  snapshot: OrchestraSnapshot | null
  /** The last snapshot of the chosen repository: what the screen holds on to while the list blinks. */
  lastRepo?: RepoSnapshot
  connection: Connection
  repoRoot: string | null
  /** Per-plan task selection; '' marks a plan where the human explicitly deselected. */
  selected: Record<string, string>
  views: Record<string, ViewKind>
  densities: Record<string, Density>
  lenses: Record<string, Lens>
  /** The review queue and task panel share the right column. */
  queueOpen: boolean
  routeRequest: { route: OrchestraRoute; seq: number } | null
}

const VIEWS: ViewKind[] = ['graph', 'work', 'review']
const DENSITIES: Density[] = ['overview', 'detail']
const LENSES: Lens[] = ['attention', 'running', 'ready', 'review']

/** Plans are chats: everything the human tuned — view, density, open task — is remembered per plan. */
export const planScope = (root: string, planId?: string): string => (planId ? `${root}:${planId}` : root)
const OLD_PREFIX = 'dsh-orchestra:'
let storageMigrated = false
function migrateStorage(): void {
  if (storageMigrated) return
  storageMigrated = true
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key?.startsWith(OLD_PREFIX)) continue
      const next = `crewboard:${key.slice(OLD_PREFIX.length)}`
      if (storage.getItem(next) === null) storage.setItem(next, storage.getItem(key) ?? '')
    }
  } catch { /* storage is optional */ }
}
// Run once as the client module starts so old state is available to every store read.
migrateStorage()
const viewKey = (scope: string) => `crewboard:view:${scope}`
const densityKey = (scope: string) => `crewboard:density:${scope}`
const taskKey = (scope: string) => `crewboard:task:${scope}`
const lensKey = (scope: string) => `crewboard:lens:${scope}`
/** Keys written before plans existed still apply to a repo whose snapshot carries no planId. */
const LEGACY_DENSITY_KEY = 'crewboard:density'
/** The lens grew out of the header filter: its stored value ('attention' | 'ready') still counts. */
const LEGACY_FILTER_KEY = 'crewboard:filter'
const REPO_KEY = 'crewboard:repo'
const routeKey = (root: string) => `crewboard:route:${root}`

// Every storage touch is guarded: a shell with storage disabled must still render the screen.
function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* storage is a convenience, never a requirement */
  }
}

const asView = (v: string | null): ViewKind | undefined => (VIEWS.includes(v as ViewKind) ? (v as ViewKind) : undefined)
const asDensity = (v: string | null): Density | undefined => (DENSITIES.includes(v as Density) ? (v as Density) : undefined)
const asLens = (v: string | null): Lens | undefined => (LENSES.includes(v as Lens) ? (v as Lens) : undefined)

/** A stored «filter» value upgrades in place: the key moves to the lens name, the choice survives. */
function migratedLens(scope: string): Lens | undefined {
  for (const key of [`${LEGACY_FILTER_KEY}:${scope}`, LEGACY_FILTER_KEY]) {
    const lens = asLens(read(key))
    if (!lens) continue
    write(lensKey(scope), lens)
    try {
      globalThis.localStorage?.removeItem(key)
    } catch {
      /* same guard as write() */
    }
    return lens
  }
  return undefined
}

/**
 * The repository the screen is on. The host rebuilds the snapshot from the list dsh hands it, and
 * only for repositories whose snapshot has been built — so a workspace that blinks, or a build that
 * failed once, removes the chosen repository from the list for a beat. Falling back to `repos[0]`
 * then threw the reader into a different repository, a different plan and the default view: the
 * screen «jumped home» after an acceptance or a re-render. A chosen repository is held until it
 * comes back; `repos[0]` serves only a reader who has not chosen one.
 */
export function pickRepo(repos: readonly RepoSnapshot[], repoRoot: string | null, last: RepoSnapshot | undefined): RepoSnapshot | undefined {
  const found = repos.find((r) => r.root === repoRoot)
  if (found) return found
  if (repoRoot && last?.root === repoRoot) return last
  return repoRoot ? undefined : repos[0]
}

function initialState(): State {
  return {
    snapshot: null,
    connection: 'live',
    repoRoot: read(REPO_KEY),
    selected: {},
    views: {},
    densities: {},
    lenses: {},
    queueOpen: false,
    routeRequest: null,
  }
}

function createStore() {
  let state = initialState()
  const listeners = new Set<() => void>()
  let close: (() => void) | undefined
  let pendingWaiting: WaitingTarget | undefined
  let pendingRoute: OrchestraRoute | undefined
  let routeController: ReturnType<typeof createRouteController> | undefined
  let stopRoute: (() => void) | undefined
  let applyingRoute = false
  let restoredFallback = false

  const emit = () => {
    for (const l of [...listeners]) l()
  }
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch }
    emit()
  }
  const routeFor = (): OrchestraRoute | null => {
    const repo = pickRepo(state.snapshot?.repos ?? [], state.repoRoot, state.lastRepo)
    if (!repo) return null
    const scope = planScope(repo.root, repo.planId)
    const request = state.routeRequest?.route
    const task = (request?.repo === repo.root && request.plan === (repo.planId ?? '_') ? request.task : undefined) ?? ((scope in state.selected ? state.selected[scope] : read(taskKey(scope))) || undefined)
    return { repo: repo.root, plan: repo.planId ?? '_', view: request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.view === 'settings' ? 'settings' : state.views[scope] ?? asView(read(viewKey(scope))) ?? 'graph',
      ...(task ? { task } : {}), ...(task && request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.task === task && request.tab ? { tab: request.tab } : {}),
      ...(request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.draft ? { draft: request.draft } : {}),
      ...(request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.run && task ? { run: request.run } : {}),
      ...(request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.run && request.step && task ? { step: request.step } : {}),
      ...(lensOf(scope) ? { lens: lensOf(scope)! } : {}) }
  }
  const saveRoute = (mode: 'push' | 'replace') => {
    if (applyingRoute) return
    const route = routeFor()
    if (!route) return
    write(routeKey(route.repo), formatRoute(route))
    routeController?.write(route, mode)
  }
  const navigate = (part: Partial<OrchestraRoute>, mode: 'push' | 'replace' = 'push'): void => {
    const current = routeFor()
    if (!current) return
    const changingRun = 'run' in part && part.run !== current.run
    const changingTask = 'task' in part && part.task !== current.task
    const route = { ...current, ...part, ...((changingRun || changingTask) && !('step' in part) ? { step: undefined } : {}) }
    const sameRunStep = 'step' in part && (!('run' in part) || part.run === current.run) && (!('task' in part) || part.task === current.task)
    set({ routeRequest: { route, seq: sameRunStep ? state.routeRequest?.seq ?? 0 : (state.routeRequest?.seq ?? 0) + 1 } })
    if (route.repo !== current.repo || route.plan !== current.plan) {
      write(routeKey(route.repo), formatRoute(route))
      routeController?.write(route, mode)
    } else saveRoute(mode)
  }
  const applyRoute = (route: OrchestraRoute) => {
    const repo = state.snapshot?.repos.find((item) => item.root === route.repo)
    if (!repo) {
      if (!state.snapshot) { pendingRoute = route; return }
      const fallback = pickRepo(state.snapshot.repos, state.repoRoot, state.lastRepo)
      if (fallback) applyRoute({ repo: fallback.root, plan: fallback.planId ?? '_', view: 'graph' })
      return
    }
    const plan = repo.plans?.find((item) => item.id === route.plan)
    pendingRoute = repo.planId !== route.plan && route.plan !== '_' && plan ? route : undefined
    if (pendingRoute && plan) void api.planUse(route.repo, route.plan).catch(() => { pendingRoute = undefined })
    const scope = planScope(repo.root, repo.planId)
    const validTask = !pendingRoute && route.task && repo.tasks.some((task) => task.id === route.task) ? route.task : undefined
    const validTab = validTask && (route.tab === 'overview' || route.tab === 'activity' || route.tab === 'changes' || route.tab === 'contract' || route.tab === 'review-run' || route.tab === 'review-task') ? route.tab : undefined
    const view = route.view === 'settings' ? 'graph' : route.view
    const lens = asLens(route.lens ?? null)
    applyingRoute = true
    write(REPO_KEY, repo.root)
    write(viewKey(scope), view)
    write(taskKey(scope), validTask ?? '')
    write(lensKey(scope), lens ?? '')
    set({ repoRoot: repo.root, views: { ...state.views, [scope]: view }, selected: { ...state.selected, [scope]: validTask ?? '' }, queueOpen: false,
      lenses: lens ? { ...state.lenses, [scope]: lens } : Object.fromEntries(Object.entries(state.lenses).filter(([key]) => key !== scope)),
      routeRequest: { route: { ...route, plan: pendingRoute ? route.plan : repo.planId ?? '_', task: validTask, tab: validTab, run: validTask ? route.run : undefined, lens }, seq: (state.routeRequest?.seq ?? 0) + 1 } })
    applyingRoute = false
    if (!pendingRoute) queueMicrotask(() => queueMicrotask(() => saveRoute('replace')))
  }

  const start = (): (() => void) => {
    let alive = true
    api
      .state()
      .then((r) => {
        if (alive && r.ok) set(withRepo({ snapshot: r.value, connection: 'live' }))
      })
      .catch(() => {})
    let es: EventSource | undefined
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`${API_PREFIX}/events`)
      es.addEventListener('snapshot', (event) => {
        if (!alive) return
        try {
          set(withRepo({ snapshot: JSON.parse((event as MessageEvent<string>).data) as OrchestraSnapshot, connection: 'live' }))
        } catch {
          /* a malformed frame must not kill the stream */
        }
      })
      es.onopen = () => {
        if (alive) set({ connection: 'live' })
      }
      es.onerror = () => {
        if (alive) set({ connection: 'reconnecting' })
      }
    }
    return () => {
      alive = false
      es?.close()
    }
  }

  /** Remember the chosen repository whenever a snapshot actually carries it. */
  const withRepo = (patch: Partial<State> & { snapshot: OrchestraSnapshot }): Partial<State> => {
    const repos = patch.snapshot.repos.map((repo) => {
      const previous = state.snapshot?.repos.find((candidate) => candidate.root === repo.root)
      // JSON snapshots contain only wire data; this preserves references only when every field,
      // including attention, positions and timestamps, is unchanged.
      return previous && JSON.stringify(previous) === JSON.stringify(repo) ? previous : repo
    })
    const snapshot = repos.some((repo, index) => repo !== patch.snapshot.repos[index])
      ? { ...patch.snapshot, repos }
      : patch.snapshot
    if (pendingWaiting) {
      const target = pendingWaiting
      const ready = repos.find((repo) => repo.root === target.root && (!target.planId || repo.planId === target.planId))
      if (ready) {
        const id = target.taskId ?? acceptableTasks(ready)[0]?.id
        if (id) {
          const scope = planScope(target.root, ready.planId)
          write(taskKey(scope), id)
          state = { ...state, selected: { ...state.selected, [scope]: id }, queueOpen: false }
        }
        pendingWaiting = undefined
      }
    }
    if (pendingRoute) {
      const target = pendingRoute
      const next = repos.find((item) => item.root === target.repo)
      if (next && (next.planId === target.plan || target.plan === '_')) {
        pendingRoute = undefined
        queueMicrotask(() => applyRoute(target))
      } else if (!next && repos.length > 0) {
        pendingRoute = undefined
        queueMicrotask(() => applyRoute(target))
      }
    }
    if (!restoredFallback && !pendingRoute && !state.routeRequest && typeof window !== 'undefined' && !window.location.hash.startsWith('#orchestra/')) {
      const selected = pickRepo(repos, state.repoRoot, state.lastRepo)
      const remembered = selected ? parseRoute(read(routeKey(selected.root)) ?? '') : null
      restoredFallback = true
      if (remembered) queueMicrotask(() => applyRoute(remembered))
    }
    const found = repos.find((r) => r.root === state.repoRoot)
    return found ? { ...patch, snapshot, lastRepo: found } : { ...patch, snapshot }
  }

  const currentRepo = (): RepoSnapshot | undefined => pickRepo(state.snapshot?.repos ?? [], state.repoRoot, state.lastRepo)
  const currentScope = (): string | undefined => {
    const repo = currentRepo()
    return repo ? planScope(repo.root, repo.planId) : undefined
  }
  const densityOf = (scope: string): Density =>
    state.densities[scope] ?? asDensity(read(densityKey(scope))) ?? asDensity(read(LEGACY_DENSITY_KEY)) ?? 'overview'
  const lensOf = (scope: string): Lens | null =>
    state.lenses[scope] ?? asLens(read(lensKey(scope))) ?? migratedLens(scope) ?? null

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) close = start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          close?.()
          close = undefined
        }
      }
    },
    getState: (): State => state,
    viewOf(root: string, planId?: string): ViewKind {
      const scope = planScope(root, planId)
      return state.views[scope] ?? asView(read(viewKey(scope))) ?? asView(read(viewKey(root))) ?? 'graph'
    },
    densityOf,
    startRouting(): void {
      if (routeController || typeof window === 'undefined') return
      routeController = createRouteController({ read: routeFor, apply: applyRoute, selectPanel: () => selectMainPanel(PANEL_ID), window,
        onLeave: () => {} })
      stopRoute = routeController.start()
      if (!window.location.hash.startsWith('#orchestra/')) {
        const root = state.repoRoot
        const remembered = root ? parseRoute(read(routeKey(root)) ?? '') : null
        if (remembered) { restoredFallback = true; applyRoute(remembered) }
      }
    },
    stopRouting(): void { stopRoute?.(); stopRoute = undefined; routeController = undefined },
    applyRoute,
    navigate,
    openPlan(root: string, plan: string): void {
      const current = routeFor()
      if (!current) return
      const route: OrchestraRoute = { repo: root, plan, view: current.view }
      write(routeKey(root), formatRoute(route))
      routeController?.write(route, 'push')
      applyRoute(route)
    },
    taskLink(id: string): string {
      const route = routeFor()
      return route ? `${window.location.origin}${window.location.pathname}${window.location.search}${formatRoute({ ...route, task: id, tab: route.task === id ? route.tab : undefined, draft: undefined, run: undefined })}` : window.location.href
    },
    select(id: string | null): void {
      const scope = currentScope()
      if (!scope) return
      write(taskKey(scope), id ?? '')
      set({ selected: { ...state.selected, [scope]: id ?? '' } })
      navigate({ task: id ?? undefined, tab: undefined, draft: undefined, run: undefined })
    },
    setView(view: ViewKind): void {
      const scope = currentScope()
      if (!scope) return
      write(viewKey(scope), view)
      set({ views: { ...state.views, [scope]: view } })
      navigate({ view, draft: undefined, run: undefined })
    },
    toggleDensity(): void {
      const scope = currentScope()
      const density: Density = (scope ? densityOf(scope) : asDensity(read(LEGACY_DENSITY_KEY)) ?? 'overview') === 'overview' ? 'detail' : 'overview'
      write(scope ? densityKey(scope) : LEGACY_DENSITY_KEY, density)
      if (scope) set({ densities: { ...state.densities, [scope]: density } })
      else set({ densities: {} })
    },
    lensOf,
    setLens(lens: Lens | null): void {
      const scope = currentScope()
      if (!scope) return
      write(lensKey(scope), lens ?? '')
      const lenses = { ...state.lenses }
      if (lens) lenses[scope] = lens
      else delete lenses[scope]
      set({ lenses })
      saveRoute('replace')
    },
    setRepo(root: string): void {
      write(REPO_KEY, root)
      set({ repoRoot: root })
      saveRoute('push')
    },
    /** One navigation path for repo marks, sidebar and toasts. */
    openWaiting(target: WaitingTarget): void {
      const repo = state.snapshot?.repos.find((candidate) => candidate.root === target.root)
      pendingWaiting = target
      write(REPO_KEY, target.root)
      if (target.taskId) {
        const scope = planScope(target.root, target.planId)
        write(taskKey(scope), target.taskId)
        state = { ...state, selected: { ...state.selected, [scope]: target.taskId } }
      }
      navigate({ repo: target.root, plan: target.planId ?? repo?.planId ?? '_', task: target.taskId, tab: undefined, draft: undefined, run: undefined })
      set({ repoRoot: target.root, queueOpen: false })
      if (target.planId && repo?.planId !== target.planId) {
        void api.planUse(target.root, target.planId)
          .then((result) => { if (!result.ok && pendingWaiting === target) pendingWaiting = undefined })
          .catch(() => { if (pendingWaiting === target) pendingWaiting = undefined })
      }
      else if (repo) {
        const id = target.taskId ?? acceptableTasks(repo)[0]?.id
        if (id) this.selectIn(target.root, repo.planId, id)
        pendingWaiting = undefined
      }
    },
    openFirstWaiting(root?: string): void {
      const repos = state.snapshot?.repos ?? []
      const target = (root ? repos.filter((repo) => repo.root === root) : repos)
        .map(firstWaiting).find((item) => item !== undefined)
      if (target) this.openWaiting(target)
      else if (root) this.setRepo(root)
    },
    /**
     * Selection is addressed by plan, including a plan that is not currently on screen.
     */
    selectIn(root: string, planId: string | undefined, id: string): void {
      const scope = planScope(root, planId)
      write(taskKey(scope), id)
      set({ selected: { ...state.selected, [scope]: id } })
      saveRoute('push')
    },
    setQueueOpen(open: boolean): void {
      set({ queueOpen: open })
    },
    reset(): void {
      close?.()
      close = undefined
      listeners.clear()
      state = initialState()
      pendingWaiting = undefined
      pendingRoute = undefined
      restoredFallback = false
      this.stopRouting()
    },
  }
}

const store = createStore()

/** Notifications drive the screen from outside React: select a task, open the queue, switch the plan. */
export const orchestraStore = store

/** Test seam: drops the subscription and the remembered selection between renders. */
export function resetOrchestraStore(): void {
  store.reset()
}

/** One state instance per screen: every view and the task panel read the same selection. */
export function useOrchestra(): Orchestra {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const repo = pickRepo(state.snapshot?.repos ?? [], state.repoRoot, state.lastRepo)
  const scope = repo ? planScope(repo.root, repo.planId) : undefined
  const selectedId = scope ? (scope in state.selected ? state.selected[scope] : read(taskKey(scope))) || null : null
  return {
    snapshot: state.snapshot,
    connection: state.connection,
    repo,
    selectedId,
    select: store.select,
    view: repo ? store.viewOf(repo.root, repo.planId) : 'graph',
    setView: store.setView,
    density: scope ? store.densityOf(scope) : 'overview',
    toggleDensity: store.toggleDensity,
    lens: scope ? store.lensOf(scope) : null,
    setLens: store.setLens,
    setRepo: store.setRepo,
    queueOpen: state.queueOpen,
    setQueueOpen: store.setQueueOpen,
    routeRequest: state.routeRequest,
  }
}
