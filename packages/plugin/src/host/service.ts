import { existsSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { BUILD_ID } from '../shared/build.js'
import { basename, join } from 'node:path'
import { type Backends, type DshWorkspace, CREWBOARD_DIR, advanceDraftJobs, draftsStamp, recoverDraftOrphans, type RepoPreferenceMap, type RepoSnapshot, buildRepoSnapshot, createRepoFamilyResolver, gcRecheckAccepted, loadPlan, mergeWorkspaces, nodeExec, discoverWorktreeRepos, folderKey, type Exec, type RepositoryRef, resolveRouting, splitSuggestion, worktreeConfigPath, loadProfileStore, markOutsidePreset, type SidebarOrder } from '@crewboard/core'
import type { OrchestraRepoSnapshot, OrchestraSnapshot, WorkerInfo, WorkerSettingsIssue } from '../shared/types.js'
import type { ChatBindings } from './chat.js'
import type { OrchestraConfig } from './config.js'

/** Files a plan save or a broken read writes beside the plan: no refresh of their own (the save brings one). */
const QUARANTINE_COPY = /\.(corrupt-[^/\\]*|prev(\.tmp-[^/\\]*)?)$/

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
    return {
      generatedAt: this.deps.now().toISOString(),
      build: BUILD_ID,
      workers: this.workers,
      ...(this.workerSettings ? { workerSettings: this.workerSettings } : this.routingFailure ? { workerSettings: { code: 'unreadable' as const, detail: this.routingFailure } } : {}),
      ...(this.order && (this.order.repos?.length || Object.keys(this.order.plans ?? {}).length) ? { order: this.order } : {}),
      repos: this.repositories()
        .map((r) => this.snapshots.get(r.root))
        .filter((s): s is OrchestraRepoSnapshot => s !== undefined),
    }
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
        const chats = this.deps.chatsFor ? await this.deps.chatsFor(root).catch(() => undefined) : undefined
        const enriched = await withChats(root, s, chats)
        phase('chats')
        const env = this.deps.env ?? process.env
        // Routing that cannot be resolved (an unreadable plan — pq1 — or broken worker settings — B07) leaves
        // the snapshot without it; the repository itself is always served.
        const routingOf = (planId: string | undefined) => resolveRouting(root, planId, env).catch((err: unknown) => {
          if (!(s.degraded && s.error)) this.routingFailure = messageOf(err)
          return undefined
        })
        const plans = await Promise.all((enriched.plans ?? []).map(async (plan) => {
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
        // A full snapshot that landed while this quick one was read is never replaced by it.
        if (quick && this.snapshots.has(root) && !this.snapshots.get(root)?.partial) return
        this.snapshots.set(root, { ...enriched, ...(stamp ? { draftsStamp: stamp } : {}), tasks, family, ...(flags.pinned ? { pinned: true } : {}), ...(flags.hidden ? { hidden: true } : {}), plans, ...(effectiveRouting ? { effectiveRouting } : {}), ...(title ? { title } : {}), ...origin })
      })
    if (quick) return p
    const tracked = p.finally(() => {
      this.inflight.delete(root)
    })
    this.inflight.set(root, tracked)
    return tracked
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
