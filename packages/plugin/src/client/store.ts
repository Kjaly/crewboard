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
  /** The stream is open but no snapshot has come for {@link STALL_MS}: «Loading plans…» would wait forever. */
  stalled: boolean
  resetScreenState(): void
  /** The lane the plan is focused on (route `?lane=`); the seq bumps on every request, so a repeat click flies again. */
  lane: LaneFocus | null
  focusLane(lane: string | null): void
  /** The lane the graph camera currently looks at — the sidebar tree highlights it. */
  laneInView: string | null
  setLaneInView(lane: string | null): void
}

export type LaneFocus = { lane: string; seq: number }

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
  stalled: boolean
  /** Per-plan lane focus. Not stored: a lane is where the reader went, the route carries it. */
  lanes: Record<string, LaneFocus>
  laneInView: string | null
}

const VIEWS: ViewKind[] = ['graph', 'work', 'review']
const DENSITIES: Density[] = ['overview', 'detail']
const LENSES: Lens[] = ['attention', 'running', 'ready', 'review']

/** Plans are chats: everything the human tuned — view, density, open task — is remembered per plan. */
export const planScope = (root: string, planId?: string): string => (planId ? `${root}:${planId}` : root)
const OLD_PREFIX = 'dsh-orchestra:'
const PREFIX = 'crewboard:'
/** How long a live stream may stay without a snapshot before the screen says so. */
export const STALL_MS = 10_000
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

function forget(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    /* same guard as write() */
  }
}

/**
 * Remembered screen state is a convenience that may throw on stale data; its failure is told once
 * per key, not once per snapshot frame (the owner's console held ~7 000 messages).
 */
const reported = new Set<string>()
function report(key: string, reason: string, error?: unknown): void {
  if (reported.has(key)) return
  reported.add(key)
  const detail = error instanceof Error ? `: ${error.message}` : ''
  console.error(`Crewboard: ${reason}${detail} [${key}]`)
}

/** «Reset screen state»: every Crewboard key of this origin, including the pre-rename ones migration would copy back. */
export function clearScreenStorage(): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(PREFIX) || key?.startsWith(OLD_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch { /* storage is optional */ }
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
 * comes back. A remembered choice this session has never seen (a repository renamed, removed, or
 * listed under another spelling since) is not held: `repos[0]` serves it until it shows up, so a
 * stale value can never leave the screen without a plan.
 */
export function pickRepo(repos: readonly RepoSnapshot[], repoRoot: string | null, last: RepoSnapshot | undefined): RepoSnapshot | undefined {
  const found = repos.find((r) => r.root === repoRoot)
  if (found) return found
  if (repoRoot && last?.root === repoRoot) return last
  return repos[0]
}

/** A remembered task selection counts only while the plan still has that task. */
function storedTask(repo: RepoSnapshot, selected: Record<string, string>): string | undefined {
  const scope = planScope(repo.root, repo.planId)
  const id = (scope in selected ? selected[scope] : read(taskKey(scope))) || undefined
  return id && repo.tasks.some((task) => task.id === id) ? id : undefined
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
    stalled: false,
    lanes: {},
    laneInView: null,
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
  /** `planUse` was asked for the pending route; until then a snapshot on another plan must apply it. */
  let planAsked = false
  let laneSeq = 0

  // One failing subscriber must not keep the others (React among them) from the new state.
  const emit = () => {
    for (const l of [...listeners]) {
      try {
        l()
      } catch (error) {
        report('listener', 'a screen subscriber failed', error)
      }
    }
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
    const task = (request?.repo === repo.root && request.plan === (repo.planId ?? '_') ? request.task : undefined) ?? storedTask(repo, state.selected)
    return { repo: repo.root, plan: repo.planId ?? '_', view: request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.view === 'settings' ? 'settings' : state.views[scope] ?? asView(read(viewKey(scope))) ?? 'graph',
      ...(task ? { task } : {}), ...(task && request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.task === task && request.tab ? { tab: request.tab } : {}),
      ...(request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.draft ? { draft: request.draft } : {}),
      ...(request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.run && task ? { run: request.run } : {}),
      ...(request?.repo === repo.root && request.plan === (repo.planId ?? '_') && request.run && request.step && task ? { step: request.step } : {}),
      ...(lensOf(scope) ? { lens: lensOf(scope)! } : {}),
      ...(state.lanes[scope] ? { lane: state.lanes[scope].lane } : {}) }
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
      if (!state.snapshot) { pendingRoute = route; planAsked = false; return }
      // The fallback must be a listed repository: a held `lastRepo` is missing too, and routing to it recursed without end.
      const listed = state.snapshot.repos
      const fallback = listed.find((item) => item.root === state.repoRoot) ?? (state.repoRoot && state.lastRepo?.root === state.repoRoot ? undefined : listed[0])
      if (fallback) applyRoute({ repo: fallback.root, plan: fallback.planId ?? '_', view: 'graph' })
      return
    }
    const plan = repo.plans?.find((item) => item.id === route.plan)
    pendingRoute = repo.planId !== route.plan && route.plan !== '_' && plan ? route : undefined
    if (pendingRoute && plan) {
      planAsked = true
      const asked = pendingRoute
      const drop = () => { if (pendingRoute === asked) pendingRoute = undefined }
      void api.planUse(route.repo, route.plan).then((result) => { if (!result.ok) drop() }).catch(drop)
    }
    const scope = planScope(repo.root, repo.planId)
    const validTask = !pendingRoute && route.task && repo.tasks.some((task) => task.id === route.task) ? route.task : undefined
    const validTab = validTask && (route.tab === 'overview' || route.tab === 'activity' || route.tab === 'changes' || route.tab === 'contract' || route.tab === 'review-run' || route.tab === 'review-task') ? route.tab : undefined
    const view = route.view === 'settings' ? 'graph' : route.view
    const lens = asLens(route.lens ?? null)
    // A lane is applied only once the route's plan is on screen: the pending route comes back here then.
    const lanes = { ...state.lanes }
    if (!pendingRoute && route.lane !== undefined) lanes[scope] = { lane: route.lane, seq: ++laneSeq }
    else if (!pendingRoute) delete lanes[scope]
    applyingRoute = true
    write(REPO_KEY, repo.root)
    write(viewKey(scope), view)
    write(taskKey(scope), validTask ?? '')
    write(lensKey(scope), lens ?? '')
    set({ repoRoot: repo.root, views: { ...state.views, [scope]: view }, selected: { ...state.selected, [scope]: validTask ?? '' }, queueOpen: false,
      lenses: lens ? { ...state.lenses, [scope]: lens } : Object.fromEntries(Object.entries(state.lenses).filter(([key]) => key !== scope)), lanes,
      routeRequest: { route: { ...route, plan: pendingRoute ? route.plan : repo.planId ?? '_', task: validTask, tab: validTab, run: validTask ? route.run : undefined, lens }, seq: (state.routeRequest?.seq ?? 0) + 1 } })
    applyingRoute = false
    if (!pendingRoute) queueMicrotask(() => queueMicrotask(() => saveRoute('replace')))
  }

  /** Remembered state failed on this data: forget it, say so once, and let the defaults stand. */
  const guarded = (key: string, reason: string, step: () => void, undo: () => void): void => {
    try {
      step()
    } catch (error) {
      try {
        undo()
      } catch {
        /* the defaults stand either way */
      }
      report(key, reason, error)
    }
  }
  const safeApply = (route: OrchestraRoute): void =>
    guarded(routeKey(route.repo), 'the remembered route could not be restored and was forgotten', () => applyRoute(route), () => {
      applyingRoute = false
      if (pendingRoute === route) pendingRoute = undefined
      forget(routeKey(route.repo))
    })

  const start = (): (() => void) => {
    let alive = true
    // A live stream that never delivers a snapshot is told on screen, not left on «Loading plans…».
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const armStall = () => {
      stallTimer = setTimeout(() => {
        if (!alive || state.snapshot) return
        if (state.connection !== 'live') { armStall(); return }
        report('snapshot-timeout', `no snapshot arrived within ${STALL_MS / 1000} s on a live connection`)
        set({ stalled: true })
      }, STALL_MS)
    }
    armStall()
    api
      .state()
      .then((r) => {
        if (alive && r.ok) receive(r.value)
      })
      .catch(() => {})
    let es: EventSource | undefined
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`${API_PREFIX}/events`)
      es.addEventListener('snapshot', (event) => {
        if (!alive) return
        let parsed: OrchestraSnapshot
        try {
          parsed = JSON.parse((event as MessageEvent<string>).data) as OrchestraSnapshot
        } catch (error) {
          // Only a frame that is not JSON is skipped; everything after parsing is receive()'s to guard.
          report('frame', 'a snapshot frame that is not JSON was skipped', error)
          return
        }
        receive(parsed)
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
      if (stallTimer) clearTimeout(stallTimer)
      es?.close()
    }
  }

  /**
   * The snapshot is stored first; the remembered route, repository and waiting task are applied after
   * it, each on its own guard. A throw there used to drop every snapshot inside the frame's catch, and
   * the screen stayed on «Loading plans…» for good (owner, 2026-09-24).
   */
  const receive = (incoming: OrchestraSnapshot): void => {
    if (!Array.isArray(incoming?.repos)) {
      report('snapshot', 'a snapshot without a repository list was skipped')
      return
    }
    const snapshot = reuseRepos(incoming)
    const found = snapshot.repos.find((r) => r.root === state.repoRoot)
    set({ snapshot, connection: 'live', stalled: false, ...(found ? { lastRepo: found } : {}) })
    guarded('pending-waiting', 'the task to open could not be selected', () => resolveWaiting(snapshot.repos), () => { pendingWaiting = undefined })
    const target = pendingRoute
    guarded(target ? routeKey(target.repo) : 'pending-route', 'the pending route could not be applied and was forgotten', () => resolveRoute(snapshot.repos), () => {
      pendingRoute = undefined
      if (target) forget(routeKey(target.repo))
    })
    guarded(REPO_KEY, 'the remembered repository could not be restored and was forgotten', () => restoreRemembered(snapshot.repos), () => {
      restoredFallback = true
      const root = state.repoRoot
      forget(REPO_KEY)
      if (root) forget(routeKey(root))
      set({ repoRoot: null })
    })
  }

  /** JSON snapshots contain only wire data; a repository keeps its reference only when every field is unchanged. */
  const reuseRepos = (incoming: OrchestraSnapshot): OrchestraSnapshot => {
    const repos = incoming.repos.map((repo) => {
      const previous = state.snapshot?.repos.find((candidate) => candidate.root === repo.root)
      return previous && JSON.stringify(previous) === JSON.stringify(repo) ? previous : repo
    })
    return repos.some((repo, index) => repo !== incoming.repos[index]) ? { ...incoming, repos } : incoming
  }

  const resolveWaiting = (repos: readonly RepoSnapshot[]): void => {
    if (!pendingWaiting) return
    const target = pendingWaiting
    const ready = repos.find((repo) => repo.root === target.root && (!target.planId || repo.planId === target.planId))
    if (!ready) return
    pendingWaiting = undefined
    const id = target.taskId ?? acceptableTasks(ready)[0]?.id
    if (!id) return
    const scope = planScope(target.root, ready.planId)
    write(taskKey(scope), id)
    set({ selected: { ...state.selected, [scope]: id }, queueOpen: false })
  }

  const resolveRoute = (repos: readonly RepoSnapshot[]): void => {
    if (!pendingRoute) return
    const target = pendingRoute
    const next = repos.find((item) => item.root === target.repo)
    if (!next && repos.length === 0) return
    // After `planUse` the host switches the plan; until its snapshot comes the route waits. A route
    // that arrived before any snapshot has not asked yet: applying it asks, or falls back.
    if (next && next.planId !== target.plan && target.plan !== '_' && planAsked) return
    pendingRoute = undefined
    queueMicrotask(() => safeApply(target))
  }

  /** A bare route restores the last route remembered for the repository on screen, once. */
  const restoreRemembered = (repos: readonly RepoSnapshot[]): void => {
    if (restoredFallback || pendingRoute || state.routeRequest || typeof window === 'undefined' || window.location.hash.startsWith('#orchestra/')) return
    const selected = pickRepo(repos, state.repoRoot, state.lastRepo)
    // An empty first snapshot (the host still building) must not use up the one restore.
    if (!selected) return
    restoredFallback = true
    const remembered = parseRoute(read(routeKey(selected.root)) ?? '')
    if (remembered) queueMicrotask(() => safeApply(remembered))
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
      routeController = createRouteController({ read: routeFor, apply: safeApply, selectPanel: () => selectMainPanel(PANEL_ID), window,
        onLeave: () => {} })
      stopRoute = routeController.start()
      if (!window.location.hash.startsWith('#orchestra/')) {
        const root = state.repoRoot
        const remembered = root ? parseRoute(read(routeKey(root)) ?? '') : null
        if (remembered) { restoredFallback = true; safeApply(remembered) }
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
    /** «Copy link» on a lane row: the plan on its current view, focused on that lane. */
    laneLink(lane: string): string {
      const route = routeFor()
      return route ? `${window.location.origin}${window.location.pathname}${window.location.search}${formatRoute({ ...route, lane, task: undefined, tab: undefined, draft: undefined, run: undefined, step: undefined })}` : window.location.href
    },
    focusLane(lane: string | null): void {
      const scope = currentScope()
      if (!scope) return
      const lanes = { ...state.lanes }
      if (lane === null) delete lanes[scope]
      else lanes[scope] = { lane, seq: ++laneSeq }
      set({ lanes })
      saveRoute('replace')
    },
    setLaneInView(lane: string | null): void {
      if (state.laneInView !== lane) set({ laneInView: lane })
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
    /**
     * «Reset screen state»: forget every remembered Crewboard value of this origin and start over
     * with defaults, keeping the subscribers. Written without `this`: the screen calls it unbound.
     */
    resetScreenState(): void {
      clearScreenStorage()
      reported.clear()
      pendingWaiting = undefined
      pendingRoute = undefined
      planAsked = false
      restoredFallback = false
      routeController?.leave()
      const restart = listeners.size > 0
      close?.()
      close = undefined
      state = initialState()
      emit()
      if (restart) close = start()
    },
    reset(): void {
      close?.()
      close = undefined
      listeners.clear()
      state = initialState()
      pendingWaiting = undefined
      pendingRoute = undefined
      planAsked = false
      restoredFallback = false
      reported.clear()
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
  const selectedId = repo ? storedTask(repo, state.selected) ?? null : null
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
    stalled: state.stalled && state.connection === 'live',
    resetScreenState: store.resetScreenState,
    lane: scope ? state.lanes[scope] ?? null : null,
    focusLane: store.focusLane,
    laneInView: state.laneInView,
    setLaneInView: store.setLaneInView,
  }
}
