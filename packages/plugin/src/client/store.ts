import { useSyncExternalStore } from 'react'
import type { SteerResult } from '@crewboard/core'
import type { OrchestraRepoSnapshot, OrchestraSnapshot, RepoSnapshot } from '../shared/types.js'
import { shared } from './api.js'
import { hostEvents } from './host-events.js'
import type { Lens } from './lens.js'
import { acceptableTasks, firstWaiting, type WaitingTarget } from './review.js'
import { createRouteController, formatRoute, NOW_ROUTE, parseRoute, type OrchestraRoute } from './route.js'
import { selectMainPanel } from './layout.js'
import { PANEL_ID } from '../shared/types.js'

export type { Lens }
export type ViewKind = 'graph' | 'work' | 'review'
export type Density = 'overview' | 'detail'
export type Connection = 'live' | 'reconnecting'

export type Orchestra = {
  snapshot: OrchestraSnapshot | null
  connection: Connection
  repo: OrchestraRepoSnapshot | undefined
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
  /** The global «Now» screen is open (`#orchestra/now`); it is not a per-plan view. */
  nowOpen: boolean
  openNow(): void
  closeNow(): void
  /** Open a project at its remembered plan/view/task/tab, else its current plan. */
  openRemembered(root: string): void
  /** True while an explicitly selected plan's read-only snapshot is still loading (never a silent fallback). */
  browseLoading: boolean
  /** The error of a failed selected-plan read, by root+plan; the screen must not silently show the current plan. */
  browseError: string | null
  /** The physical root of the plan being browsed while it loads or failed; null when the served current plan is shown. */
  browseRoot: string | null
  /** Re-ask the selected plan after a failed read, without leaving the browse. */
  retryBrowse(): void
  /** The last explicit task focus (a row/link/walk jump), never a restored remembered selection. */
  focus: { task: string; seq: number } | null
}

/** `explicit` marks a lane the reader just picked (a tree click), not a lane merely restored with a route. */
export type LaneFocus = { lane: string; seq: number; explicit?: boolean }

/**
 * The read-only snapshot of an explicitly selected plan that is not the served CLI `current` one. It is read
 * through `shared.planState`, never `plan-use`, so browsing cannot move the shared pointer. `version` is the
 * `${generation}:${plan.rev}` token the read was made at; a later SSE generation re-asks (one plan on demand,
 * never all plans).
 */
export type BrowseSnapshot = {
  root: string
  plan: string
  version: string
  snapshot?: OrchestraRepoSnapshot
  error?: string
}

/**
 * Window-session memory (never localStorage): the unsent composer text, the open panel tab/run, the feed's
 * reading anchor and follow state, all keyed by the physical `root` + `plan` + `task` they belong to. A poll or
 * a same-task refresh reads it back; a task in another plan or repository can never inherit it. It lives in the
 * shared store module so the main client and every lazily loaded screen hold one map.
 */
/** A steer delivery receipt, keyed to the exact text and — when known — the run it was sent against. */
export type Delivery = {
  /**
   * `sending` while the request is in flight; `unconfirmed` when a restored `sending` receipt has outlived
   * {@link SENDING_TTL_MS} without an answer (a client state, never a claim that the send failed); otherwise
   * the host's own delivery kind.
   */
  state: 'sending' | 'unconfirmed' | SteerResult['delivery']
  /** The exact submitted text, so a newer draft typed before the answer is never mislabelled. */
  text: string
  /** The run captured before the await; a later run's receipt never reads as this one's. */
  runId?: string
  steerId?: string
  /** When the state was recorded. */
  at: number
  /** The host's own receipt, when it answered; a `sending`/`unconfirmed` entry has none. */
  result?: SteerResult
}

export type TaskMemory = {
  /** The open panel tab of this task (`overview`, `activity`, …). */
  tab?: string
  /** The run the panel is showing, when the tab follows a run. */
  run?: string
  /** The unsent composer text — private, session-only. */
  draft?: string
  /** The last steer delivery receipt of this task. */
  delivery?: Delivery
  /**
   * The feed reading anchor: the deterministic identity of the topmost turn (`kind|ts[|ordinal]`), so a poll
   * — or a return — finds the exact row even when two turns share a timestamp.
   */
  anchor?: string
  /**
   * The viewport's position *within* that anchor, measured from the anchor's own rect: how far the anchor's top
   * sits above the scroll viewport's top. It keeps the same reading alignment halfway through a tall message
   * and never trusts `offsetTop`, whose `offsetParent` may be a different element.
   */
  anchorOffset?: number
  /** The fallback scroll offset used when the anchor is not in the bounded history any more. */
  offset?: number
  /** The run this reading position belongs to; a new run starts fresh instead of inheriting an old scroll. */
  feedRun?: string
  /** Whether the feed follows new events to the bottom. */
  follow?: boolean
}

/**
 * A restored `sending` receipt older than this no longer counts as a live request (the panel or the tab was
 * closed while it was in flight). It reads as the client state `unconfirmed` — never as a factual failure —
 * so a restored composer is not disabled forever while the real answer can still arrive and update it.
 */
export const SENDING_TTL_MS = 30_000

/** The graph camera pose as the session remembers it — the shape `Pose` of the graph camera, kept structural. */
export type CameraPose = { x: number; y: number; scale: number; touched: boolean }

/** Per-plan session memory: the camera pose restored only on a return, not on every refresh. */
export type PlanMemory = { camera?: CameraPose; work?: { filter?: string; doneOpen?: boolean } }

const taskMemory = new Map<string, TaskMemory>()
const planMemory = new Map<string, PlanMemory>()
/**
 * The exact physical copy the reader last used within a family (`familyId` → physical root). A project click
 * in the switcher or on «Now» restores this copy, so a family with a main checkout and busy worktrees does not
 * silently jump back to whichever copy happens to look active on the next poll. Window memory only.
 */
const familyCopies = new Map<string, string>()

let memoryRevision = 0
const memoryListeners = new Set<() => void>()
const emitMemory = (): void => {
  memoryRevision += 1
  for (const listener of [...memoryListeners]) {
    try {
      listener()
    } catch { /* one subscriber must not keep the others from the new memory */ }
  }
}

/** Subscribe to window-session memory changes (composer drafts and receipts, tabs, feed state). */
export const subscribeMemory = (listener: () => void): (() => void) => {
  memoryListeners.add(listener)
  return () => { memoryListeners.delete(listener) }
}
/** The memory generation, for `useSyncExternalStore`. */
export const memoryOfRevision = (): number => memoryRevision

const taskMemoryKey = (root: string, plan: string | undefined, task: string): string => `${root}\0${plan ?? ''}\0${task}`
const planMemoryKey = (root: string, plan: string | undefined): string => `${root}\0${plan ?? ''}`

/** The session memory of one task, without creating it. */
export const taskMemoryOf = (root: string, plan: string | undefined, task: string): TaskMemory => taskMemory.get(taskMemoryKey(root, plan, task)) ?? {}

/** Records a task's session memory; `undefined` values clear the field. Never written to storage. */
export const rememberTask = (root: string, plan: string | undefined, task: string, patch: Partial<TaskMemory>): TaskMemory => {
  const key = taskMemoryKey(root, plan, task)
  const next: TaskMemory = { ...(taskMemory.get(key) ?? {}) }
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete next[field as keyof TaskMemory]
    else (next as Record<string, unknown>)[field] = value
  }
  taskMemory.set(key, next)
  emitMemory()
  return next
}

/**
 * A delivery as a restored UI should read it. A `sending` receipt that outlived {@link SENDING_TTL_MS} reads as
 * the client state `unconfirmed` — elapsed time proves nothing about the send, so this is never called a
 * failure. Only the host's own answer (an error, or a queued/refused/abandoned/delivered receipt) declares a
 * failed or accepted state. The draft is preserved either way, and a later real reply still updates the memory.
 */
export function restoredDelivery(delivery: Delivery | undefined, now = Date.now()): Delivery | undefined {
  if (!delivery) return undefined
  if (delivery.state !== 'sending' || now - delivery.at < SENDING_TTL_MS) return delivery
  return { ...delivery, state: 'unconfirmed' }
}

/**
 * The receipt as it applies to `runId`: a receipt captured against another run is not this run's current
 * feedback (a new run must never show an old queued receipt). A receipt with no captured run still applies.
 */
export function deliveryForRun(delivery: Delivery | undefined, runId: string | undefined, now = Date.now()): Delivery | undefined {
  const restored = restoredDelivery(delivery, now)
  if (!restored) return undefined
  if (restored.runId && runId && restored.runId !== runId) return undefined
  return restored
}

/**
 * The feed position to restore for `runId`: the remembered reading position only when it was captured against
 * this same run. A new run gets `undefined` and starts fresh — it must never inherit the previous run's scroll.
 */
export function feedPositionOf(memory: TaskMemory, runId: string | undefined): { anchor?: string; anchorOffset?: number; offset?: number; follow?: boolean } | undefined {
  if (!runId || memory.feedRun !== runId) return undefined
  if (memory.anchor === undefined && memory.anchorOffset === undefined && memory.offset === undefined && memory.follow === undefined) return undefined
  return {
    ...(memory.anchor !== undefined ? { anchor: memory.anchor } : {}),
    ...(memory.anchorOffset !== undefined ? { anchorOffset: memory.anchorOffset } : {}),
    ...(memory.offset !== undefined ? { offset: memory.offset } : {}),
    ...(memory.follow !== undefined ? { follow: memory.follow } : {}),
  }
}

/**
 * The memory patch of a settled steer. Only an accepted write — the host answered `delivered` in a live
 * queued/sent/acknowledged state — clears the draft, and only the exact submitted revision. A refused,
 * abandoned or failed request keeps its text so the person can retry or correct it, and a newer draft typed
 * before the answer survives. The receipt is always stored.
 */
export function steerSettledPatch(memory: TaskMemory, submitted: string, delivery: Delivery): Partial<TaskMemory> {
  const result = delivery.result
  const accepted = !!result && result.delivery === 'delivered' && result.state !== 'abandoned' && result.state !== 'refused'
  const clear = accepted && memory.draft === submitted
  return { ...(clear ? { draft: '' } : {}), delivery }
}

/** The session memory of one plan (camera pose), without creating it. */
export const planMemoryOf = (root: string, plan: string | undefined): PlanMemory => planMemory.get(planMemoryKey(root, plan)) ?? {}

/** Records a plan's session memory. Never written to storage. */
export const rememberPlan = (root: string, plan: string | undefined, patch: Partial<PlanMemory>): PlanMemory => {
  const key = planMemoryKey(root, plan)
  const next: PlanMemory = { ...(planMemory.get(key) ?? {}), ...patch }
  planMemory.set(key, next)
  emitMemory()
  return next
}

/**
 * The session memory of one task, subscribed: a screen that unmounts while a steer is in flight still leaves
 * the receipt in the shared map, and the restored screen observes it here. Returns the memory and a writer.
 */
export function useTaskMemory(root: string, plan: string | undefined, task: string): [TaskMemory, (patch: Partial<TaskMemory>) => void] {
  useSyncExternalStore(subscribeMemory, memoryOfRevision, memoryOfRevision)
  return [taskMemoryOf(root, plan, task), (patch) => { rememberTask(root, plan, task, patch) }]
}

/** The session memory of one plan (the graph camera pose), subscribed. */
export function usePlanMemory(root: string, plan: string | undefined): [PlanMemory, (patch: Partial<PlanMemory>) => void] {
  useSyncExternalStore(subscribeMemory, memoryOfRevision, memoryOfRevision)
  return [planMemoryOf(root, plan), (patch) => { rememberPlan(root, plan, patch) }]
}

/** The physical copy the reader last used within a family, if any. Never written to storage. */
export const familyCopyOf = (familyId: string): string | undefined => familyCopies.get(familyId)
/** Remembers the physical copy a person just opened, so the family click returns to it. */
export function rememberFamilyCopy(familyId: string, root: string): void {
  if (familyCopies.get(familyId) === root) return
  familyCopies.set(familyId, root)
  emitMemory()
}

/** The remembered family copy, subscribed: a switcher re-renders when a copy is chosen. */
export function useFamilyCopy(): (familyId: string) => string | undefined {
  useSyncExternalStore(subscribeMemory, memoryOfRevision, memoryOfRevision)
  return familyCopyOf
}

/** Test seam: drop the window-session memory between renders. */
export function resetSessionMemory(): void {
  taskMemory.clear()
  planMemory.clear()
  familyCopies.clear()
  emitMemory()
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
  stalled: boolean
  /** Per-plan lane focus. Not stored: a lane is where the reader went, the route carries it. */
  lanes: Record<string, LaneFocus>
  laneInView: string | null
  /** The global «Now» screen is open; its own hash route never writes per-plan memory. */
  nowOpen: boolean
  /** The explicitly selected plan read read-only through `planState`; `null` while the served current plan is shown. */
  browse: BrowseSnapshot | null
  /**
   * An explicit task focus (a row/link/walk jump), bumped only by user navigation — never by restoring a
   * remembered route. The graph uses it to tell an explicit jump from remembered selection metadata.
   */
  focus: { task: string; seq: number } | null
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

/**
 * The repository the screen shows. When an explicitly selected plan is being browsed, its read-only snapshot
 * is overlaid on the served repository (family, pinned/hidden, the plan list), so every consumer reads the
 * selected plan's tasks and plan id while the CLI `current` pointer stays where it was. While that read is
 * still loading the screen shows nothing for the repository rather than silently falling back to `current`.
 */
export function shownRepo(state: Pick<State, 'snapshot' | 'repoRoot' | 'lastRepo' | 'browse'>): OrchestraRepoSnapshot | undefined {
  const browse = state.browse
  if (browse) {
    if (!browse.snapshot) return undefined
    const base = state.snapshot?.repos.find((r) => r.root === browse.root)
    return { ...(base ?? browse.snapshot), ...browse.snapshot, root: browse.root, planId: browse.plan }
  }
  return pickRepo(state.snapshot?.repos ?? [], state.repoRoot, state.lastRepo) as OrchestraRepoSnapshot | undefined
}

/** The version the on-demand plan read is keyed by: the repository generation plus the plan revision. */
export function browseVersionOf(served: RepoSnapshot & { generation?: number }, plan: string): string {
  const rev = served.plans?.find((item) => item.id === plan)?.rev
  return `${served.generation ?? served.rev}:${rev ?? ''}`
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
    nowOpen: false,
    browse: null,
    focus: null,
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
  let laneSeq = 0
  /** Bumped on every explicit task focus, so the graph can tell it from a restored selection. */
  let focusSeq = 0
  /**
   * A monotonically increasing token for the on-demand plan read: any newer request (another plan, or a newer
   * SSE generation) wins, so a slow answer for an abandoned selection can never overwrite the current one.
   */
  let browseSeq = 0
  /** The panel tabs a route may address; a route's tab is applied only for one of these. */
  const TABS = ['overview', 'activity', 'changes', 'contract', 'review-run', 'review-task']

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
    // The global screen owns its own hash and is reachable even with no repository on screen.
    if (state.nowOpen) return { ...NOW_ROUTE }
    const repo = shownRepo(state)
    if (!repo) return null
    const scope = planScope(repo.root, repo.planId)
    const request = state.routeRequest?.route
    const samePlan = request?.repo === repo.root && request.plan === (repo.planId ?? '_')
    const task = (samePlan ? request.task : undefined) ?? storedTask(repo, state.selected)
    return { repo: repo.root, plan: repo.planId ?? '_', view: samePlan && request.view === 'settings' ? 'settings' : state.views[scope] ?? asView(read(viewKey(scope))) ?? 'graph',
      ...(task ? { task } : {}), ...(task && samePlan && request.task === task && request.tab ? { tab: request.tab } : {}),
      ...(samePlan && request.draft ? { draft: request.draft } : {}),
      ...(samePlan && request.run && task ? { run: request.run } : {}),
      ...(samePlan && request.run && request.step && task ? { step: request.step } : {}),
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
  const browseMatches = (root: string, plan: string): boolean => state.browse?.root === root && state.browse.plan === plan

  /** Forget the read-only browse and show the served current plan again. */
  const clearBrowse = (): void => {
    if (!state.browse) return
    browseSeq++
    set({ browse: null })
  }

  /**
   * Read an explicitly selected plan read-only (`shared.planState`), never `plan-use`: the CLI `current` pointer
   * stays where it was. The pending selection is published synchronously, so `shownRepo` shows «loading» —
   * never the served current plan's tasks or action targets — until the answer lands. A same-scope re-read keeps
   * the previous snapshot visible while the newer generation is fetched. The captured `seq` is the guard: a
   * response lands only when no newer request (another plan, or a newer SSE generation) was made since; the
   * response's own `generation` is never trusted alone, because a refresh can land while the host builds it.
   */
  const requestBrowse = (root: string, plan: string, served: RepoSnapshot & { generation?: number }): void => {
    const version = browseVersionOf(served, plan)
    const seq = ++browseSeq
    const previous = browseMatches(root, plan) ? state.browse : undefined
    set({ browse: previous?.snapshot ? { ...previous, version } : { root, plan, version } })
    void shared.planState(root, plan, version)
      .then((result) => {
        if (seq !== browseSeq) return
        if (result.ok && result.value) set({ browse: { root, plan, version, snapshot: result.value } })
        else set({ browse: { root, plan, version, error: result.ok ? 'plan_state_empty' : result.error } })
        revalidateRoute()
      })
      .catch(() => { if (seq === browseSeq) set({ browse: { root, plan, version, error: 'plan_state_failed' } }) })
  }

  /**
   * After a selected plan's snapshot lands, check the pending route against its real tasks: an id the plan does
   * not have is dropped (and the hash normalized) instead of asking the host for a task that is not there. This
   * is where the provisional in-memory selection is validated — only now is it written to storage.
   */
  const revalidateRoute = (): void => {
    const repo = shownRepo(state)
    if (!repo) return
    const request = state.routeRequest?.route
    // A background target may name only a plan (the queue's «Перейти», a plan-level toast): once that plan is
    // read, the first task that waits for the person is the one to open.
    const waiting = pendingWaiting
    const waitingHere = !!waiting && waiting.root === repo.root && (!waiting.planId || waiting.planId === (repo.planId ?? ''))
    const waitingId = waitingHere ? (waiting!.taskId ?? acceptableTasks(repo)[0]?.id) : undefined
    if (waitingHere && waitingId) pendingWaiting = undefined
    if (!request || request.repo !== repo.root || request.plan !== (repo.planId ?? '_')) return
    const routeTask = request.task ?? waitingId
    const validTask = routeTask && repo.tasks.some((task) => task.id === routeTask) ? routeTask : undefined
    const validTab = validTask && TABS.includes(request.tab ?? '') ? request.tab : undefined
    const scope = planScope(repo.root, repo.planId)
    // Persist the now-validated selection (the pending provisional id becomes real, or is dropped).
    write(taskKey(scope), validTask ?? '')
    if (validTask === request.task && validTab === request.tab && (state.selected[scope] ?? '') === (validTask ?? '')) return
    set({ selected: { ...state.selected, [scope]: validTask ?? '' }, ...(validTask ? { queueOpen: false } : {}), routeRequest: { route: { ...request, task: validTask, tab: validTab, run: validTask ? request.run : undefined, step: validTask ? request.step : undefined }, seq: state.routeRequest?.seq ?? 0 } })
    saveRoute('replace')
  }

  /** Writes the route hash without consulting `shownRepo`: a browse still loading is not on screen yet. */
  const writeRouteHash = (route: OrchestraRoute, mode: 'push' | 'replace'): void => {
    write(routeKey(route.repo), formatRoute(route))
    routeController?.write(route, mode)
  }

  const applyRoute = (route: OrchestraRoute, mode: 'push' | 'replace' = 'push', explicitFocus = true) => {
    // The global «Now» screen: it is not a per-plan view, so it never touches the remembered plan,
    // view, task or tab. Its own hash is written by `openNow`, so Back and reload work unchanged.
    if (route.view === 'now') {
      applyingRoute = true
      set({ nowOpen: true, queueOpen: false })
      applyingRoute = false
      return
    }
    const served = state.snapshot?.repos.find((item) => item.root === route.repo)
    if (!served) {
      if (!state.snapshot) { pendingRoute = route; return }
      // The fallback must be a listed repository: a held `lastRepo` is missing too, and routing to it recursed without end.
      const listed = state.snapshot.repos
      const fallback = listed.find((item) => item.root === state.repoRoot) ?? (state.repoRoot && state.lastRepo?.root === state.repoRoot ? undefined : listed[0])
      if (fallback) applyRoute({ repo: fallback.root, plan: fallback.planId ?? '_', view: 'graph' }, mode)
      return
    }
    // An explicit plan the repository does not list fails closed: a browse error, never a silent fall to `current`.
    const requested = route.plan === '_' ? undefined : route.plan
    const browses = !!requested && requested !== served.planId
    if (browses && !(served.plans?.length && served.plans.some((item) => item.id === requested))) {
      browseSeq++
      applyingRoute = true
      write(REPO_KEY, served.root)
      const failed: OrchestraRoute = { ...route, plan: requested! }
      set({ repoRoot: served.root, queueOpen: false, nowOpen: false, browse: { root: served.root, plan: requested!, version: `${served.generation ?? served.rev}:?`, error: 'bad_plan' },
        routeRequest: { route: failed, seq: (state.routeRequest?.seq ?? 0) + 1 } })
      applyingRoute = false
      writeRouteHash(failed, mode)
      return
    }
    const targetPlan = browses ? requested : served.planId
    // The selection scope is the target plan, not the host's current one: the same task id in two plans must not share memory.
    const scope = planScope(served.root, targetPlan)
    // The target plan's task list: the served current one, or the browse snapshot once it has landed.
    const tasks = browses ? (browseMatches(served.root, targetPlan!) ? state.browse?.snapshot?.tasks : undefined) : served.tasks
    const known = !!tasks
    const validTask = route.task && (known ? tasks!.some((task) => task.id === route.task) : true) ? route.task : undefined
    const validTab = validTask && TABS.includes(route.tab ?? '') ? route.tab : undefined
    const view = route.view === 'settings' ? 'graph' : route.view
    const lens = asLens(route.lens ?? null)
    // While a browse loads, the route's own task/tab/run are kept in the request and hash (validated after the
    // answer lands, never dropped here); the selection is in memory only until the plan's tasks confirm it.
    const requestTask = known ? validTask : route.task
    const requestTab = known ? validTab : (route.task && route.tab ? route.tab : undefined)
    const requestRun = requestTask ? route.run : undefined
    const requestStep = requestRun ? route.step : undefined
    const normalized: OrchestraRoute = { ...route, plan: targetPlan ?? '_', task: requestTask, tab: requestTab, run: requestRun, step: requestStep, lens }
    const selectedTask = known ? validTask : route.task
    const lanes = { ...state.lanes }
    if (route.lane !== undefined) lanes[scope] = { lane: route.lane, seq: ++laneSeq, ...(explicitFocus ? { explicit: true } : {}) }
    else delete lanes[scope]
    applyingRoute = true
    write(REPO_KEY, served.root)
    write(viewKey(scope), view)
    if (known) write(taskKey(scope), selectedTask ?? '')
    write(lensKey(scope), lens ?? '')
    set({ repoRoot: served.root, views: { ...state.views, [scope]: view }, selected: { ...state.selected, [scope]: selectedTask ?? '' }, queueOpen: false, nowOpen: false,
      lenses: lens ? { ...state.lenses, [scope]: lens } : Object.fromEntries(Object.entries(state.lenses).filter(([key]) => key !== scope)), lanes,
      ...(explicitFocus && requestTask ? { focus: { task: requestTask, seq: ++focusSeq } } : {}),
      routeRequest: { route: normalized, seq: (state.routeRequest?.seq ?? 0) + 1 } })
    applyingRoute = false
    if (browses && targetPlan) {
      const version = browseVersionOf(served, targetPlan)
      const current = state.browse
      const matching = current?.root === served.root && current.plan === targetPlan && current.version === version
      // A pending or settled answer at this version is reused; a new generation (or a failed read on navigation) re-asks.
      if (!matching || current?.error) requestBrowse(served.root, targetPlan, served)
    } else if (state.browse) clearBrowse()
    // The hash is written from the requested coordinates at once, so Back / Now→task keep the exact pending target.
    writeRouteHash(normalized, mode)
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
  // Restoring a remembered route (boot, Back) never adds a history entry: it replaces the current one.
  const safeApply = (route: OrchestraRoute, explicitFocus = true): void =>
    guarded(routeKey(route.repo), 'the remembered route could not be restored and was forgotten', () => applyRoute(route, 'replace', explicitFocus), () => {
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
    shared
      .state()
      .then((r) => {
        if (alive && r.ok) receive(r.value)
      })
      .catch(() => {})
    // The stream is the tab's one (host-events.ts): the screen holds it while mounted, and the host's first frame
    // on every connection — a reopen after the tab was hidden included — is a full snapshot.
    const offSnapshot = hostEvents.subscribe('snapshot', (frame) => {
      if (!alive) return
      // Only a frame that is not JSON is skipped; everything after parsing is receive()'s to guard.
      if (!frame.ok) {
        report('frame', 'a snapshot frame that is not JSON was skipped', frame.error)
        return
      }
      receive(frame.data as OrchestraSnapshot)
    })
    const offLink = hostEvents.onLink((link) => {
      if (!alive) return
      if (link === 'live') set({ connection: 'live' })
      else if (link === 'reconnecting') set({ connection: 'reconnecting' })
    })
    return () => {
      alive = false
      if (stallTimer) clearTimeout(stallTimer)
      offLink()
      offSnapshot()
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
    // A browsed plan can move for runtime-only reasons (evidence, receipts, run logs, Git) without its `rev`.
    // The repository generation is the authoritative token: re-ask the one selected plan at the new generation,
    // never every plan. If the host itself switched `current` to the browsed plan, the browse is redundant and
    // the pending route is finalized against the now-served plan.
    const browse = state.browse
    if (browse) {
      const served = snapshot.repos.find((r) => r.root === browse.root)
      if (!served || served.planId === browse.plan) {
        clearBrowse()
        revalidateRoute()
      } else if (browse.snapshot && browseVersionOf(served, browse.plan) !== browse.version) {
        requestBrowse(browse.root, browse.plan, served)
      }
    }
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
    const ready = repos.find((repo) => repo.root === target.root)
    if (!ready) return
    pendingWaiting = undefined
    const plan = target.planId ?? ready.planId
    const scope = planScope(target.root, plan)
    // A background plan's first task is only known once that plan is read; its summary carries no task ids.
    const id = target.taskId ?? (plan === ready.planId ? acceptableTasks(ready)[0]?.id : undefined)
    if (id) write(taskKey(scope), id)
    applyRoute({ repo: target.root, plan: plan ?? '_', view: 'graph', ...(id ? { task: id } : {}) })
    set({ queueOpen: !!target.queue })
  }

  const resolveRoute = (repos: readonly RepoSnapshot[]): void => {
    if (!pendingRoute) return
    const target = pendingRoute
    const next = repos.find((item) => item.root === target.repo)
    if (!next && repos.length === 0) return
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
    if (remembered) queueMicrotask(() => safeApply(remembered, false))
  }

  const currentRepo = (): RepoSnapshot | undefined => shownRepo(state)
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
        if (remembered) { restoredFallback = true; safeApply(remembered, false) }
      }
    },
    stopRouting(): void { stopRoute?.(); stopRoute = undefined; routeController = undefined },
    applyRoute,
    navigate,
    openPlan(root: string, plan: string): void {
      // Leaving the global screen happens before the route is read, so its `now` view is never inherited.
      if (state.nowOpen) set({ nowOpen: false })
      const current = routeFor()
      // A plan click works even while another browse is still loading: the view is kept when known, else graph.
      const route: OrchestraRoute = { repo: root, plan, view: current && current.view !== 'now' ? current.view : 'graph' }
      applyRoute(route, 'push')
    },
    /** Open the global «Now» screen; it never writes a per-plan view/task/lane. */
    openNow(): void {
      if (state.nowOpen) return
      applyingRoute = true
      set({ nowOpen: true, queueOpen: false })
      applyingRoute = false
      const route = routeFor()
      if (route) routeController?.write(route, 'push')
    },
    /** Return from «Now» to the plan route the reader already had, which is still in memory. */
    closeNow(): void {
      if (!state.nowOpen) return
      const root = state.repoRoot ?? state.lastRepo?.root ?? state.snapshot?.repos[0]?.root
      const remembered = root ? parseRoute(read(routeKey(root)) ?? '') : null
      if (remembered && remembered.view !== 'now') {
        applyRoute(remembered, 'replace', false)
        return
      }
      applyingRoute = true
      set({ nowOpen: false })
      applyingRoute = false
      const route = routeFor()
      if (route) routeController?.write(route, 'replace')
    },
    /**
     * A project click restores where the reader last was in that physical checkout (plan, view, task,
     * tab) from the repository's own route; only a repository never visited falls back to its plan.
     */
    openRemembered(root: string): void {
      const remembered = parseRoute(read(routeKey(root)) ?? '')
      // A project click is user navigation: it pushes a history entry, so Back returns to where the reader was.
      if (remembered && remembered.view !== 'now') {
        guarded(routeKey(root), 'the remembered route could not be restored and was forgotten', () => applyRoute(remembered, 'push', false), () => forget(routeKey(root)))
        return
      }
      const repo = state.snapshot?.repos.find((item) => item.root === root)
      if (repo) store.openWaiting({ root, planId: repo.planId })
      else store.setRepo(root)
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
      else lanes[scope] = { lane, seq: ++laneSeq, explicit: true }
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
      // A repository choice leaves the global screen; its hash is replaced by the plan route.
      if (state.nowOpen) set({ nowOpen: false })
      // A browse belongs to its own physical root: switching repositories drops it rather than showing the old one.
      if (state.browse && state.browse.root !== root) clearBrowse()
      write(REPO_KEY, root)
      set({ repoRoot: root })
      saveRoute('push')
    },
    /** One navigation path for repo marks, sidebar and toasts. */
    openWaiting(target: WaitingTarget): void {
      if (state.nowOpen) set({ nowOpen: false })
      const repo = state.snapshot?.repos.find((candidate) => candidate.root === target.root)
      // The repository is not listed (yet): keep the intent and let it resolve when its snapshot arrives.
      if (!repo) {
        pendingWaiting = target
        write(REPO_KEY, target.root)
        if (target.taskId) {
          const scope = planScope(target.root, target.planId)
          write(taskKey(scope), target.taskId)
          state = { ...state, selected: { ...state.selected, [scope]: target.taskId } }
        }
        set({ repoRoot: target.root, queueOpen: !!target.queue })
        return
      }
      const plan = target.planId ?? repo.planId
      // A plan-level target (no task id) resolves its first waiting task once the plan is read.
      if (!target.taskId) pendingWaiting = target
      if (target.taskId) {
        const scope = planScope(target.root, plan)
        write(taskKey(scope), target.taskId)
        state = { ...state, selected: { ...state.selected, [scope]: target.taskId } }
      }
      const current = routeFor()
      const view = current?.repo === target.root && current.view !== 'now' ? current.view : 'graph'
      applyRoute({ repo: target.root, plan: plan ?? '_', view, task: target.taskId, tab: undefined, draft: undefined, run: undefined })
      set({ queueOpen: !!target.queue })
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
      const current = routeFor()
      const view = current?.repo === root && current.view !== 'now' ? current.view : 'graph'
      applyRoute({ repo: root, plan: planId ?? '_', view, task: id })
    },
    setQueueOpen(open: boolean): void {
      set({ queueOpen: open })
    },
    /** Re-ask the selected plan after a failed read: the same root+plan, a fresh request. */
    retryBrowse(): void {
      const browse = state.browse
      if (!browse) return
      const served = state.snapshot?.repos.find((item) => item.root === browse.root)
      if (served) requestBrowse(browse.root, browse.plan, served)
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
      restoredFallback = false
      browseSeq++
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
      restoredFallback = false
      browseSeq++
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
  resetSessionMemory()
}

/** One state instance per screen: every view and the task panel read the same selection. */
export function useOrchestra(): Orchestra {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const repo = shownRepo(state)
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
    nowOpen: state.nowOpen,
    openNow: store.openNow,
    closeNow: store.closeNow,
    openRemembered: store.openRemembered,
    browseLoading: !!state.browse && !state.browse.snapshot && !state.browse.error,
    browseError: state.browse?.error ?? null,
    browseRoot: state.browse?.root ?? null,
    retryBrowse: store.retryBrowse,
    focus: state.focus,
  }
}
