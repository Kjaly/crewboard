import { existsSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { BUILD_ID } from '../shared/build.js'
import { basename, join } from 'node:path'
import { type Backends, type DshWorkspace, CREWBOARD_DIR, advanceDraftJobs, draftsStamp, recoverDraftOrphans, type RepoPreferenceMap, type RepoSnapshot, buildRepoSnapshot, createRepoFamilyResolver, gcRecheckAccepted, loadPlan, mergeWorkspaces, nodeExec, discoverWorktreeRepos, folderKey, type Exec, type RepositoryRef, resolveRouting, splitSuggestion, worktreeConfigPath, loadProfileStore, markOutsidePreset, type SidebarOrder, PlanIdError, planIds, PLAN_ID, type PlanProgressRef } from '@crewboard/core'
import type { OrchestraNow, OrchestraPlanSummary, OrchestraRepoSnapshot, OrchestraSnapshot, WorkerInfo, WorkerSettingsIssue } from '../shared/types.js'
import type { ChatBindings } from './chat.js'
import type { OrchestraConfig } from './config.js'

/** Files a plan save or a broken read writes beside the plan: no refresh of their own (the save brings one). */
const QUARANTINE_COPY = /\.(corrupt-[^/\\]*|prev(\.tmp-[^/\\]*)?)$/

/** How many explicit-plan snapshots the service keeps; the oldest is dropped past this. */
const PLAN_STATE_LIMIT = 24
/**
 * The upper bound on an explicit-plan answer even when its revision and repository generation are unchanged: a
 * short window that coalesces a burst of on-demand reads without ever serving a stale plan indefinitely.
 */
const PLAN_STATE_MAX_AGE_MS = 2000

export type Watcher = (dir: string, onChange: (file?: string) => void) => () => void

/** fs.watch is recursive on macOS/Windows; a missing directory or an unsupported platform falls back to polling only. */
export const fsWatcher: Watcher = (dir, onChange) => {
  try {
    const w = watch(dir, { recursive: true }, (_event, file) => onChange(file ? String(file) : undefined))
    w.on('error', () => {})
    return () => w.close()
  } catch {
    return () => {}
  }
}

export type ServiceDeps = {
  config: OrchestraConfig
  backendsFor(root: string): Backends
  now(): Date
  watcher?: Watcher
  debounceMs?: number
  /** When present, each repo snapshot carries the plan↔chat bindings of `<root>/.orchestration/chats.json`. */
  chatsFor?(root: string): Promise<ChatBindings>
  /**
   * The dsh workspaces that join `config.repos` as repositories. Read again on every traversal, so a
   * workspace created in dsh while the host runs appears without a reload (and a deleted one disappears).
   */
  workspaces?(): DshWorkspace[]
  /** Crewboard's own repository list (`repos.json`), read again on every traversal like the workspaces. */
  registered?(): string[]
  /** Runs `git worktree list` for discovery; the real git by default. */
  exec?: Exec
  workersFor?(): Promise<WorkerInfo[]>
  /** What is wrong with the saved worker settings (core `workerSettingsProblem`); shown as a banner. */
  workerSettingsFor?(): Promise<WorkerSettingsIssue | undefined>
  /** Per-repository pinned/hidden flags from the orchestra profile store. */
  prefsFor?(): Promise<RepoPreferenceMap>
  /** The owner's manual sidebar order from the orchestra profile store; absent means automatic. */
  orderFor?(): Promise<SidebarOrder>
  env?: NodeJS.ProcessEnv
  /** Told how long each phase of a repository refresh took (pf1): the first-load measurement reads it. */
  profile?(root: string, phase: string, ms: number): void
}

/** Extends the core snapshot with the plan chats the client needs; core knows nothing about them. */
async function withChats(root: string, snapshot: RepoSnapshot, chats: ChatBindings | undefined): Promise<OrchestraRepoSnapshot> {
  const plans = await Promise.all((snapshot.plans ?? []).map(async (plan) => {
    const binding = chats?.[plan.id]
    const fullPlan = await loadPlan(root, plan.id).catch(() => undefined)
    // dsh rejects tool output holding `undefined` («not lossless JSON»): add a key only with a value.
    const suggestion = fullPlan ? splitSuggestion(fullPlan) : undefined
    return { ...plan, ...(suggestion ? { suggestion } : {}), ...(binding ? { chat: { sessionId: binding.sessionId, wake: binding.wake } } : {}) }
  }))
  return { ...snapshot, plans }
}

export class OrchestraService {
  private readonly snapshots = new Map<string, OrchestraRepoSnapshot>()
  private readonly listeners = new Set<(s: OrchestraSnapshot) => void>()
  /** Listeners that also take the first paint (pf1): the screen's stream. Notifications and chat wake-ups wait for full snapshots. */
  private readonly early = new Set<(s: OrchestraSnapshot) => void>()
  private readonly inflight = new Map<string, Promise<void>>()
  /** Resolves a repository's main worktree; the cache is dropped only when the repository list moves. */
  private readonly families = createRepoFamilyResolver(nodeExec)
  /** Refreshes started and not yet settled; `idle()` waits for them. */
  private readonly running = new Set<Promise<void>>()
  private stopped = false
  private workers: WorkerInfo[] = []
  /** Broken worker settings found by the last full refresh; a failure there never stops the repositories. */
  private workerSettings: WorkerSettingsIssue | undefined
  /** The last worker-routing failure a repository refresh met; it becomes the banner when nothing more precise is known. */
  private routingFailure: string | undefined
  /** Repositories already scanned for pre-job draft runs; the scan runs once per host process. */
  private readonly orphansScanned = new Set<string>()
  /** The last sidebar order the store reported; snapshots keep serving it until a refresh re-reads. */
  private order: SidebarOrder | undefined
  /** Worktrees of listed repositories that hold a plan; found again on every full refresh. */
  private discovered: RepositoryRef[] = []
  /** Live `.orchestration` watchers by root; re-synced after each full refresh so a new repository is watched too. */
  private readonly watched = new Map<string, () => void>()
  private watchChange: ((root: string, file?: string) => void) | undefined
  /** Read-only snapshots of explicitly named plans, cached by `<root>\0<planId>`; bounded, dropped when revision/generation move. */
  private readonly planStates = new Map<string, { version: number; generation: number; at: number; snapshot: OrchestraRepoSnapshot }>()
  /** On-demand plan reads in flight, keyed by plan and generation, so two callers of one plan share a single build (no N+1). */
  private readonly planStatesInflight = new Map<string, Promise<OrchestraRepoSnapshot>>()
  /**
   * Bumped whenever a repository is refreshed — timer tick, watcher event or an explicit `refresh(root)`. A plan's
   * `rev` alone cannot describe runtime-only movement (evidence, receipts, run logs, files, Git), so the explicit-plan
   * cache is keyed by this generation too and never outlives it.
   */
  private readonly generations = new Map<string, number>()

  constructor(private readonly deps: ServiceDeps) {}

  /** The listed repositories: dsh workspaces, config repos, then Crewboard's own list, deduplicated by path. */
  private listed(): RepositoryRef[] {
    return mergeWorkspaces(this.deps.workspaces?.() ?? [], this.deps.config.repos, this.deps.registered?.() ?? [])
  }

  /** The repositories to serve right now: the listed ones, then the worktrees the last refresh discovered. */
  repositories(): RepositoryRef[] {
    const listed = this.listed()
    const keys = new Set(listed.map((r) => folderKey(r.root)))
    return [...listed, ...this.discovered.filter((r) => !keys.has(folderKey(r.root)))]
  }

  snapshot(): OrchestraSnapshot {
    const repos = this.repositories()
      .map((r) => this.snapshots.get(r.root))
      .filter((s): s is OrchestraRepoSnapshot => s !== undefined)
    return {
      generatedAt: this.deps.now().toISOString(),
      build: BUILD_ID,
      workers: this.workers,
      ...(this.workerSettings ? { workerSettings: this.workerSettings } : this.routingFailure ? { workerSettings: { code: 'unreadable' as const, detail: this.routingFailure } } : {}),
      ...(this.order && (this.order.repos?.length || Object.keys(this.order.plans ?? {}).length) ? { order: this.order } : {}),
      repos,
      now: this.nowProjection(repos),
    }
  }

  /**
   * The global «Now» projection, assembled from the per-plan `progress` the SSE traversal already derived — the
   * host never scans roots or plans again here. A plan whose read failed is named in `unknown`, so an empty
   * `items` is never silently a claim that nothing is happening.
   */
  private nowProjection(repos: OrchestraRepoSnapshot[]): OrchestraNow {
    const items: PlanProgressRef[] = []
    const unknown: Array<{ root: string; planId: string }> = []
    let partial = false
    for (const repo of repos) {
      if (repo.missing) continue
      if (repo.partial) partial = true
      // A repository whose plan could not be read (`degraded`) carries no `plans`: its current work is unknown,
      // not empty. `degraded` is set only when the plan read itself failed.
      if (repo.degraded && !(repo.plans?.length)) {
        unknown.push({ root: repo.root, planId: repo.planId ?? '' })
        continue
      }
      for (const plan of repo.plans ?? []) {
        if (!plan.progress || plan.progress.coverage === 'unknown') {
          unknown.push({ root: repo.root, planId: plan.id })
          continue
        }
        items.push(...plan.progress.items)
      }
    }
    return { coverage: unknown.length ? 'unknown' : partial ? 'partial' : 'known', items, unknown }
  }

  /**
   * `partial` (pf1): also hear the quick snapshot of repositories the host has not served yet — the plan graph and
   * statuses before merge detection, verdicts and conflicts. Only the screen asks for it: a notification or a chat
   * wake-up compares a snapshot with the one before, so it hears only full ones.
   */
  subscribe(fn: (s: OrchestraSnapshot) => void, options: { partial?: boolean } = {}): () => void {
    const set = options.partial ? this.early : this.listeners
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  private emit(partial: boolean): void {
    const snap = this.snapshot()
    for (const fn of this.early) fn(snap)
    if (partial) return
    for (const fn of this.listeners) fn(snap)
  }

  refresh(root?: string): Promise<void> {
    // After stop no new work starts: a timer or watcher firing late must not write into a gone HOME.
    if (this.stopped) return Promise.resolve()
    const p = this.refreshNow(root)
    this.running.add(p)
    void p.catch(() => undefined).finally(() => this.running.delete(p))
    return p
  }

  /** Resolves once every refresh already started has settled. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running])
  }

  private async refreshNow(root?: string): Promise<void> {
    // Worker settings are read apart from the repositories: a broken file keeps the last worker list and
    // becomes a banner, the traversal below still serves every repository (B07).
    let workersFailure: string | undefined
    if (this.deps.workersFor) this.workers = await this.deps.workersFor().catch((err: unknown) => { workersFailure = messageOf(err); return this.workers })
    if (this.deps.workerSettingsFor) this.workerSettings = await this.deps.workerSettingsFor().catch((err: unknown) => ({ code: 'unreadable' as const, detail: messageOf(err) }))
    if (!this.workerSettings && workersFailure) this.workerSettings = { code: 'unreadable', detail: workersFailure }
    if (!root) this.routingFailure = undefined
    if (this.deps.orderFor) this.order = await this.deps.orderFor().catch(() => this.order)
    if (!root) this.discovered = await discoverWorktreeRepos(this.listed(), this.deps.exec ?? nodeExec).catch(() => this.discovered)
    const repos = this.repositories()
    // Git is asked for a family only when this list changes, not on every tick.
    this.families.refresh(repos.map((r) => r.root))
    const targets = root ? [repos.find((r) => r.root === root) ?? { root }] : repos
    // pf1: a repository not served yet is first read quickly — its plans without git and without writes — and the
    // screen gets that at once; the full snapshot (merges, verdicts, conflicts, cleanup) follows.
    const fresh = targets.filter((r) => !this.snapshots.has(r.root) && !this.inflight.has(r.root))
    if (fresh.length) {
      await Promise.allSettled(fresh.map((r) => this.refreshOne(r, true)))
      this.emit(true)
    }
    // One repository failing to build must not keep the others (or the listeners) from their update.
    await Promise.allSettled(targets.map((r) => this.refreshOne(r)))
    if (!root) this.syncWatchers()
    this.emit(false)
  }

  private async refreshOne(ref: RepositoryRef, quick = false): Promise<void> {
    const { root, title } = ref
    // Every refresh is a new generation: an explicit-plan snapshot read before it is no longer fresh.
    this.generations.set(root, this.generationOf(root) + 1)
    const running = quick ? undefined : this.inflight.get(root)
    if (running) return running
    const origin = { ...(ref.sources?.length ? { sources: ref.sources } : {}), ...(ref.worktreeOf ? { worktreeOf: ref.worktreeOf } : {}) }
    // A listed folder that is gone (moved, deleted, an unplugged disk) is shown as missing — no git,
    // no plan read, no draft recovery — so it can be removed from the list without breaking anything.
    if (!existsSync(root)) {
      const now = this.deps.now().toISOString()
      this.snapshots.set(root, { root, goal: '', hasPlan: false, missing: true, rev: -1, updatedAt: now, tasks: [], ready: [], criticalPath: [], attention: [], degraded: false, family: { root, name: basename(root) }, ...origin, ...(title ? { title } : {}) })
      return
    }
    const profile = this.deps.profile
    let mark = performance.now()
    const phase = (name: string): void => {
      if (!profile) return
      const at = performance.now()
      profile(root, name, at - mark)
      mark = at
    }
    const p = (quick ? Promise.resolve() : this.advanceDrafts(root))
      .then(() => { phase('drafts'); return buildRepoSnapshot(root, this.deps.backendsFor(root), this.deps.now(), undefined, { ...(quick ? { quick } : {}), ...(profile ? { profile: (name: string, ms: number) => { profile(root, name, ms); mark = performance.now() } } : {}) }) })
      .then(async (s) => {
        if (!quick) {
          const gcEnv = { ...process.env, ...this.deps.env }
          await gcRecheckAccepted(root, { exec: nodeExec, now: this.deps.now, policyPath: worktreeConfigPath(gcEnv, gcEnv.HOME ?? '') }).catch(() => undefined)
          phase('gc')
        }
        const stamp = await draftsStamp(root).catch(() => '')
        const presented = await this.present(root, s, ref, { quick, stamp, phase })
        // A full snapshot that landed while this quick one was read is never replaced by it.
        if (quick && this.snapshots.has(root) && !this.snapshots.get(root)?.partial) return
        this.snapshots.set(root, presented)
      })
    if (quick) return p
    const tracked = p.finally(() => {
      this.inflight.delete(root)
    })
    this.inflight.set(root, tracked)
    return tracked
  }

  /**
   * The one place a core snapshot becomes the served repository view: chats, effective routing and the
   * `outsidePreset` marks, the family, prefs and origin. Shared by the refresh traversal and the on-demand
   * `planState` read, so both present the same shape. With `plans` given, the enriched summaries already in hand
   * are reused verbatim (the plan-state read must not re-read every plan through `withChats`).
   */
  private async present(root: string, s: RepoSnapshot, ref: RepositoryRef, opts: { quick: boolean; stamp?: string; phase: (name: string) => void; plans?: OrchestraPlanSummary[] }): Promise<OrchestraRepoSnapshot> {
    const { title } = ref
    const { phase } = opts
    const origin = { ...(ref.sources?.length ? { sources: ref.sources } : {}), ...(ref.worktreeOf ? { worktreeOf: ref.worktreeOf } : {}) }
    const enriched = opts.plans ? { ...s, plans: opts.plans } : await withChats(root, s, this.deps.chatsFor ? await this.deps.chatsFor(root).catch(() => undefined) : undefined)
    phase('chats')
    const env = this.deps.env ?? process.env
    // Routing that cannot be resolved (an unreadable plan — pq1 — or broken worker settings — B07) leaves
    // the snapshot without it; the repository itself is always served.
    const routingOf = (planId: string | undefined) => resolveRouting(root, planId, env).catch((err: unknown) => {
      if (!(s.degraded && s.error)) this.routingFailure = messageOf(err)
      return undefined
    })
    // The already-enriched summaries (plan-state) are reused verbatim: only the selected plan's routing is
    // resolved below. Without them, the refresh traversal enriches each plan once, as before.
    const plans = opts.plans ?? await Promise.all((enriched.plans ?? []).map(async (plan) => {
      const routing = await routingOf(plan.id)
      return routing ? { ...plan, effectiveRouting: routing } : plan
    }))
    const effectiveRouting = await routingOf(enriched.planId)
    const aliases = (await loadProfileStore(env, env.HOME ?? homedir()).catch(() => ({ aliases: {} }))).aliases
    const tasks = effectiveRouting ? markOutsidePreset(enriched.tasks, effectiveRouting, aliases) : enriched.tasks
    const resolved = await this.families.resolve(root).catch(() => ({ root, name: basename(root) }))
    // Git prints the real path; a family whose main checkout is served under another spelling
    // (`/tmp` vs `/private/tmp`) takes that spelling, so the group and the worktree mark line up.
    const familyKey = folderKey(resolved.root)
    const family = { ...resolved, root: this.repositories().find((r) => folderKey(r.root) === familyKey)?.root ?? resolved.root }
    const prefs = this.deps.prefsFor ? await this.deps.prefsFor().catch(() => ({} as RepoPreferenceMap)) : {}
    const flags = prefs[root] ?? {}
    phase('routing')
    return { ...enriched, ...(opts.stamp ? { draftsStamp: opts.stamp } : {}), tasks, family, generation: this.generationOf(root), ...(flags.pinned ? { pinned: true } : {}), ...(flags.hidden ? { hidden: true } : {}), plans, ...(effectiveRouting ? { effectiveRouting } : {}), ...(title ? { title } : {}), ...origin }
  }

  /**
   * A full, read-only snapshot of an explicitly named plan — the screen's `GET /api/plan-state`. It never moves
   * the `current` pointer and never reconciles run bookkeeping or merge state, and it reuses the plan summaries the
   * SSE traversal already derived (`skipSummaries`) instead of re-scanning every plan. Answers are coalesced while a
   * read is in flight and cached only within the repository's current generation and a short TTL: a `rev` alone
   * misses runtime-only movement (evidence, receipts, run logs, files, Git), so a refresh invalidates the cache at
   * once. A *corrupt* plan read still writes the reader's recovery quarantine copy (core `readPlanFile`), a recovery
   * artifact of a damaged file rather than a change to a healthy plan. The cache is bounded. `planId` omitted keeps
   * the legacy current-plan behavior; a present but empty/unknown plan fails closed.
   */
  async planState(root: string, planId?: string): Promise<OrchestraRepoSnapshot> {
    // `undefined` (omitted) is the legacy current-plan behavior; anything present must be a real plan id. An empty
    // string is refused, never folded into the current plan.
    const id = planId === undefined ? undefined : planId.trim()
    if (id !== undefined && (!PLAN_ID.test(id) || !(await planIds(root)).includes(id))) throw new PlanIdError(`No plan ${id || planId}`)
    const repo = this.snapshots.get(root)
    // Omitted plan: the already-served current snapshot is exactly the legacy answer.
    if (!id && repo) return repo
    const key = `${root}\0${id ?? ''}`
    const generation = this.generationOf(root)
    const known = this.planStates.get(key)
    const currentRev = id ? repo?.plans?.find((plan) => plan.id === id)?.rev : repo?.rev
    const fresh = known !== undefined
      && known.generation === generation
      && (currentRev === undefined || known.version === currentRev)
      && Date.now() - known.at < PLAN_STATE_MAX_AGE_MS
    if (fresh) return known.snapshot
    // In-flight reads coalesce per plan and generation: a refresh that bumped the generation starts a new read.
    const inflightKey = `${key}\0${generation}`
    const inflight = this.planStatesInflight.get(inflightKey)
    if (inflight) return inflight
    const ref = this.repositories().find((r) => r.root === root) ?? { root }
    const p = (async () => {
      const s = await buildRepoSnapshot(root, this.deps.backendsFor(root), this.deps.now(), id, { readOnly: true, skipSummaries: true })
      const presented = await this.present(root, s, ref, { quick: false, phase: () => {}, plans: repo?.plans ?? [] })
      // A refresh that landed while this read ran is a newer generation: this answer is served but must not seed
      // the cache as fresh.
      if (this.generationOf(root) === generation) {
        this.planStates.delete(key)
        this.planStates.set(key, { version: presented.rev, generation, at: Date.now(), snapshot: presented })
        while (this.planStates.size > PLAN_STATE_LIMIT) {
          const oldest = this.planStates.keys().next().value
          if (oldest === undefined) break
          this.planStates.delete(oldest)
        }
      }
      return presented
    })()
    this.planStatesInflight.set(inflightKey, p)
    try {
      return await p
    } finally {
      this.planStatesInflight.delete(inflightKey)
    }
  }

  private generationOf(root: string): number {
    return this.generations.get(root) ?? 0
  }

  /**
   * Draft jobs advance here: a worker finishing writes its run state under .orchestration, the watcher
   * refreshes, and the answer becomes a draft (or a job that needs repair) without anyone waiting on it.
   */
  private async advanceDrafts(root: string): Promise<void> {
    const backends = this.deps.backendsFor(root)
    if (!this.orphansScanned.has(root)) {
      this.orphansScanned.add(root)
      await recoverDraftOrphans(root, backends, this.deps.now()).catch(() => undefined)
    }
    await advanceDraftJobs(root, backends, this.deps.now()).catch(() => undefined)
  }

  start(): () => void {
    void this.refresh()
    const interval = setInterval(() => void this.refresh(), this.deps.config.refreshMs)
    const pending = new Map<string, NodeJS.Timeout>()
    this.watchChange = (root, file) => {
      // A quarantine copy is the reader's own output, not a change to show: refreshing on it read the
      // broken plan again, which wrote the next copy — the pq1 loop, three copies every 350 ms.
      if (file && QUARANTINE_COPY.test(file)) return
      const t = pending.get(root)
      if (t) clearTimeout(t)
      pending.set(
        root,
        setTimeout(() => {
          pending.delete(root)
          void this.refresh(root)
        }, this.deps.debounceMs ?? 300),
      )
    }
    this.syncWatchers()
    this.stopped = false
    return () => {
      this.stopped = true
      this.watchChange = undefined
      clearInterval(interval)
      for (const t of pending.values()) clearTimeout(t)
      this.syncWatchers()
    }
  }

  /** Watches exactly the served repositories: a newly listed or discovered one starts, a removed one stops. */
  private syncWatchers(): void {
    const onChange = this.watchChange
    const wanted = new Set(onChange ? this.repositories().map((r) => r.root) : [])
    for (const [root, unwatch] of this.watched) {
      if (wanted.has(root)) continue
      unwatch()
      this.watched.delete(root)
    }
    if (!onChange) return
    const watcher = this.deps.watcher ?? fsWatcher
    for (const root of wanted) {
      if (this.watched.has(root)) continue
      this.watched.set(root, watcher(join(root, CREWBOARD_DIR), (file) => onChange(root, file)))
    }
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
