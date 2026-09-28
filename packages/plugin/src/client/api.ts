import { API_PREFIX, type AcceptResult, type RepoSnapshot as SharedRepoSnapshot, type OrchestraSnapshot, type PlanCost, type RepoSnapshot, type Routing, type RunStepSummary, type TaskDetail, type TaskReviewDetail, type Trajectory, type WorkersInfo, type WorktreeGcResult, type WorktreePolicyResult, type WorktreesInfo, type WorkerPreset, type EffectiveRouting, type SidebarOrder, type CheckSetting, type DefaultBaseSetting } from '../shared/types.js'
import type { WorktreePolicy, Recipe } from '@crewboard/core'
import type { Finding, PlanDraft } from '../../../core/src/plan/draft.js'
import type { DraftJobSummary } from '../../../core/src/plan/draft-jobs.js'

/** A worker on the Welcome checklist: «ready» only when the launch's own preflight passed. */
export type WelcomeWorkerStatus = 'ready' | 'sign_in' | 'missing' | 'not_ready' | 'unchecked'

export type { DraftJobSummary }
export type DraftJobDetail = { job: DraftJobSummary; answer?: string }
/** Who writes a draft if nobody picks (`agent`, null when no worker passes preflight), who was passed over and why, and the workers a person may pick. */
export type DraftWorkerInfo = { agent: string | null; skipped: Array<{ id: string; reason: string }>; options: string[]; message?: string; detail?: string }

export type DraftSummary = { id: string; goal: string; source: PlanDraft['source']; taskCount: number; findings: Finding[] }
export type DraftDetail = { draft: PlanDraft; findings: Finding[] }

export const CLIENT_HEADER = 'x-orchestra-client'
/** `vars` — a refusal's parameters (a launch error's), for the screen to say in its own words. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; message?: string; vars?: Record<string, string | number> }

async function readJson<T>(res: Response): Promise<ApiResult<T>> {
  try {
    return (await res.json()) as ApiResult<T>
  } catch {
    return { ok: false, error: `http_${res.status}` }
  }
}

async function post<T>(name: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
  // A write may change anything read for its repository (pf1): the next reader asks the host again.
  if (typeof body.repo === 'string') forgetRepo(body.repo)
  const res = await fetch(`${API_PREFIX}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' },
    body: JSON.stringify(body),
  })
  return readJson<T>(res)
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString()

export const api = {
  recipe: async (repo: string): Promise<ApiResult<{ recipe: Recipe | null; detected: Recipe }>> => readJson(await fetch(`${API_PREFIX}/recipe?${query({ repo })}`)),
  saveRecipe: (repo: string, recipe: Recipe) => post<Recipe>('recipe-save', { repo, recipe }),
  onboardingWorkers: async (repo: string): Promise<ApiResult<Array<{ id: string; label: string; status: WelcomeWorkerStatus; checks: Array<{ name: string; ok: boolean; detail: string }> }>>> => readJson(await fetch(`${API_PREFIX}/onboarding-workers?${query({ repo })}`)),
  specFiles: async (repo: string): Promise<ApiResult<string[]>> => readJson(await fetch(`${API_PREFIX}/spec-files?${query({ repo })}`)),
  /** Starts a background draft job and answers at once; the job then shows up in planDraftJobs. */
  draftFrom: (repo: string, file: string, agent?: string) => post<{ job: DraftJobSummary }>('plan-draft-from', { repo, file, ...(agent ? { agent } : {}) }),
  draftWorker: async (repo: string): Promise<ApiResult<DraftWorkerInfo>> => readJson(await fetch(`${API_PREFIX}/draft-worker?${query({ repo })}`)),
  /** Saves an uploaded or pasted spec under .orchestration/specs and starts the same background draft job. */
  specUpload: (repo: string, spec: { name?: string; text: string }, agent?: string) => post<{ path: string; job: DraftJobSummary }>('spec-upload', { repo, ...spec, ...(agent ? { agent } : {}) }),
  exampleCreate: (repo: string, lang: 'en' | 'ru') => post<{ plan: string }>('example-create', { repo, lang }),
  exampleRemove: (repo: string) => post<null>('example-remove', { repo }),
  chatOpen: (repo: string, plan?: string, prompt?: string, goal?: string) => post<{ sessionId: string; created: boolean }>('chat-open', { repo, ...(plan ? { plan } : {}), ...(prompt ? { prompt } : {}), ...(goal ? { goal } : {}) }),
  presets: async (repo: string): Promise<ApiResult<{ presets: WorkerPreset[]; effectiveRouting: EffectiveRouting }>> => readJson(await fetch(`${API_PREFIX}/presets?${query({ repo })}`)),
  savePreset: (repo: string, preset: WorkerPreset) => post<WorkerPreset[]>('presets', { repo, preset }),
  deletePreset: (repo: string, id: string) => post<{ usedIn: string[] }>('preset-delete', { repo, id }),
  repoPreset: (repo: string, id?: string) => post<EffectiveRouting>('repo-preset', { repo, id }),
  repoFlag: (repo: string, flag: 'pinned' | 'hidden', value: boolean) => post<{ pinned?: boolean; hidden?: boolean }>('repo-flag', { repo, flag, value }),
  /** Adds a folder to Crewboard's repository list; the host answers with the repository root it listed. */
  repoAdd: (path: string) => post<{ root: string }>('repo-add', { path }),
  /** Forgets a folder from Crewboard's list; the folder itself is not touched. */
  repoRemove: (root: string) => post<{ root: string; stillListed: string[] }>('repo-remove', { root }),
  /** Saves the piece of the manual order the client changed; `null` resets to automatic sorting. */
  sideOrder: (repo: string, order: SidebarOrder | null) => post<SidebarOrder>('side-order', { repo, order }),
  planPreset: (repo: string, planId: string, id?: string) => post<EffectiveRouting>('plan-preset', { repo, planId, id }),
  orchestratorCheck: (repo: string, scope: 'repo' | 'plan', value: boolean | null, planId?: string) => post<CheckSetting>('orchestrator-check', { repo, scope, value, ...(planId ? { planId } : {}) }),
  /** bs1: the base new copies branch from; `value: null` clears the override at that scope. */
  defaultBase: (repo: string, scope: 'repo' | 'plan', value: string | null, planId?: string) => post<DefaultBaseSetting>('default-base', { repo, scope, value, ...(planId ? { planId } : {}) }),
  state: async (): Promise<ApiResult<OrchestraSnapshot>> => readJson(await fetch(`${API_PREFIX}/state`)),
  task: async (repo: string, id: string): Promise<ApiResult<TaskDetail>> => readJson(await fetch(`${API_PREFIX}/task?${query({ repo, id })}`)),
  diff: async (repo: string, id: string, file: string): Promise<string> => {
    const res = await fetch(`${API_PREFIX}/diff?${query({ repo, id, file })}`)
    return res.ok ? res.text() : ''
  },
  fileUrl: (repo: string, id: string, file: string, side: 'before' | 'after') => `${API_PREFIX}/file?${query({ repo, id, file, side })}`,
  cost: async (repo: string): Promise<ApiResult<PlanCost>> => readJson(await fetch(`${API_PREFIX}/cost?${query({ repo })}`)),
  runSteps: async (repo: string, runs: string[]): Promise<ApiResult<Record<string, RunStepSummary>>> => readJson(await fetch(`${API_PREFIX}/run-steps?${query({ repo, runs: runs.join(',') })}`)),
  taskReview: async (repo: string, task: string): Promise<ApiResult<TaskReviewDetail>> => readJson(await fetch(`${API_PREFIX}/task-review?${query({ repo, task })}`)),
  trace: async (repo: string, id: string, run?: string, page?: { cursor?: string; seek?: string }): Promise<ApiResult<Trajectory>> =>
    readJson(await fetch(`${API_PREFIX}/trace?${query({ repo, id, ...(run ? { run } : {}), ...page })}`)),
  /** No agent: the host runs the task's own worker; with none set, the first enabled worker of the task's class (orch workers). */
  /** `dirtyCopy` — the person's answer when the copy holds uncommitted changes (fo1): continue with them, or reset it. */
  run: (repo: string, task: string, agent?: string, dirtyCopy?: 'keep' | 'reset', base?: string) =>
    post<{ runId: string; agent: string; worktree?: { path: string; branch: string }; baseNotice?: { checkedOut: string; base: string } }>('run', { repo, task, ...(agent ? { agent } : {}), ...(dirtyCopy ? { dirtyCopy } : {}), ...(base ? { base } : {}) }),
  workers: async (repo: string): Promise<ApiResult<WorkersInfo>> => readJson(await fetch(`${API_PREFIX}/workers?${query({ repo })}`)),
  saveWorkers: (repo: string, routing: Routing) => post<null>('workers-save', { repo, routing }),
  /** A new run in the same worktree, carrying the previous run's context (host route `POST /relaunch`). */
  relaunch: (repo: string, task: string, opts: { agent?: string; note?: string; fromStep?: string }) => post<{ runId: string }>('relaunch', { repo, task, ...opts }),
  /** «Continue» a run that ended unfinished: a relaunch with the direction to finish and report (host route `POST /continue`). */
  continueRun: (repo: string, task: string) => post<{ runId: string }>('continue', { repo, task }),
  /** «Run checks here» (ck1): the contract's <checks> run in the task's copy; the answer is the refreshed detail. */
  runChecks: (repo: string, task: string) => post<TaskDetail>('run-checks', { repo, task }),
  steer: (repo: string, task: string, message: string) => post('steer', { repo, task, message }),
  stop: (repo: string, task: string) => post('stop', { repo, task }),
  accept: (repo: string, task: string) => post<AcceptResult>('accept', { repo, task }),
  /** mg1: the person's Merge — the host checks, asks natively, merges and cleans the copy. */
  merge: (repo: string, task: string, strategy: 'no-ff' | 'squash') => post<{ task: string; into: string; strategy: 'no-ff' | 'squash'; commit: string; copy: 'removed' | 'kept_recent' | 'kept' | 'gone'; keptBecause?: string }>('merge', { repo, task, strategy }),
  /** mk1: the person's Mark as merged… — the host asks natively and records the reason. */
  markMerged: (repo: string, task: string, reason: string) => post<{ task: string; into: string }>('mark-merged', { repo, task, reason }),
  taskAdd: (repo: string, title: string, result: string) => post<{ id: string }>('task-add', { repo, title, result }),
  taskUpsert: (repo: string, input: { id: string; parent: string; title: string; class?: string; lane?: string; depends: boolean; note: string; replace: boolean }) => post<{ id: string }>('task-upsert', { repo, ...input }),
  taskStatus: (repo: string, task: string, status: 'backlog' | 'ready') => post('task-status', { repo, task, status }),
  worktreeOpen: (repo: string, task: string, reveal: boolean) => post('worktree-open', { repo, task, reveal }),
  worktrees: async (repo: string): Promise<ApiResult<WorktreesInfo>> => readJson(await fetch(`${API_PREFIX}/worktrees?${query({ repo })}`)),
  worktreeGc: (repo: string, tasks: string[]) => post<WorktreeGcResult>('worktree-gc', { repo, tasks }),
  worktreePolicy: (repo: string, policy: WorktreePolicy) => post<WorktreePolicyResult>('worktree-policy', { repo, policy }),
  acceptBatch: (repo: string, tasks: string[]) => post<{ accepted: string[] }>('accept-batch', { repo, tasks }),
  /** wk1: `rerun` sends back and starts the next run at once — the previous worker unless `agent` names another. */
  reject: (repo: string, task: string, reason: string, rerun?: { rerun: true; agent?: string }) => post<{ task: string; status: 'rejected'; run?: { runId: string; agent: string } }>('reject', { repo, task, reason, ...(rerun ?? {}) }),
  drop: (repo: string, task: string, reason: string) => post('drop', { repo, task, reason }),
  positions: (repo: string, planId: string, expectedRev: number, positions: Array<{ task: string; pos: { x: number; y: number } | null }>) =>
    post<null>('pos', { repo, planId, expectedRev, positions }),
  /** “Start a plan” in a workspace without one — the same init `orch init` does; the answer is the fresh repo snapshot. */
  planInit: (repo: string, goal: string) => post<RepoSnapshot>('plan-init', { repo, goal }),
  /** “Make this chat the orchestrator”: bind the session this panel lives in to the plan (`chats.json` from 2i). */
  chatBind: (repo: string, sessionId: string, plan?: string) =>
    post<{ sessionId: string; wake: boolean }>('chat-bind', plan ? { repo, plan, sessionId } : { repo, sessionId }),
  planNew: (repo: string, goal: string, plan?: string) => post<{ plan: string }>('plan-new', plan ? { repo, goal, plan } : { repo, goal }),
  planUse: (repo: string, plan: string) => post('plan-use', { repo, plan }),
  planArchive: (repo: string, plan: string, archived: boolean) => post('plan-archive', { repo, plan, archived }),
  planRename: (repo: string, plan: string, goal: string) => post('plan-rename', { repo, plan, goal }),
  planDrafts: async (repo: string): Promise<ApiResult<DraftSummary[]>> => readJson(await fetch(`${API_PREFIX}/plan-drafts?${query({ repo })}`)),
  planDraft: async (repo: string, id: string): Promise<ApiResult<DraftDetail>> => readJson(await fetch(`${API_PREFIX}/plan-draft?${query({ repo, id })}`)),
  planDraftApprove: (repo: string, id: string) => post<{ plan: string }>('plan-draft-approve', { repo, id }),
  planDraftDiscard: (repo: string, id: string) => post<null>('plan-draft-discard', { repo, id }),
  planDraftJobs: async (repo: string): Promise<ApiResult<DraftJobSummary[]>> => readJson(await fetch(`${API_PREFIX}/plan-draft-jobs?${query({ repo })}`)),
  planDraftJob: async (repo: string, id: string): Promise<ApiResult<DraftJobDetail>> => readJson(await fetch(`${API_PREFIX}/plan-draft-job?${query({ repo, id })}`)),
  planDraftJobRepair: (repo: string, id: string) => post<DraftJobSummary>('plan-draft-job-repair', { repo, id }),
  planDraftJobDiscard: (repo: string, id: string) => post<DraftJobSummary>('plan-draft-job-discard', { repo, id }),
  /** «A browser-notifying client is here» heartbeat; the host falls back to macOS when it stops. */
  notifyPresence: (clientId: string, enabled: boolean) => post<null>('notify-presence', { clientId, enabled }),
}

/**
 * One request per resource and version (pf1). It lives here, in the module every screen bundle shares, so the
 * main client and the screens hold one cache. Drafts, draft jobs, presets, worktrees and task detail were asked for by
 * every component that showed them and again on every snapshot — a dozen requests in a row for the same list, most
 * still pending. Here a key (`drafts:<root>`) holds one request per version: a caller asking while it is in flight, or
 * after it answered, gets the same answer. The version is what the snapshot says about the resource (the drafts stamp,
 * the plan revision); a new one asks the host again. A resource the version does not fully describe (a task's
 * contract is a file of its own) is reused only for `maxAgeMs` after it answered — long enough for the components
 * that open together to share one request, short enough that opening it again reads it again. A failed request is not
 * remembered, and a write for a repository forgets everything read for it.
 */
type Entry = { repo: string; version: string | undefined; promise: Promise<unknown>; settledAt?: number }

const entries = new Map<string, Entry>()

const failed = (value: unknown): boolean => !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false

function store<T>(key: string, repo: string, version: string | undefined, fetcher: () => Promise<T>): Promise<T> {
  const promise = fetcher()
  const entry: Entry = { repo, version, promise }
  entries.set(key, entry)
  const drop = () => { if (entries.get(key) === entry) entries.delete(key) }
  promise.then((value) => { if (failed(value)) drop(); else entry.settledAt = Date.now() }, drop)
  return promise
}

/**
 * The answer for `key` at `version`: the request in flight or already answered for it, else a new one. Without a
 * version any remembered answer serves (a screen that has no revision to compare, like the worktree settings).
 */
export function loadOnce<T>(key: string, repo: string, version: string | undefined, fetcher: () => Promise<T>, maxAgeMs = Number.POSITIVE_INFINITY): Promise<T> {
  const known = entries.get(key)
  const fresh = known?.settledAt === undefined || Date.now() - known.settledAt <= maxAgeMs
  if (known && fresh && (version === undefined || known.version === version)) return known.promise as Promise<T>
  return store(key, repo, version ?? known?.version, fetcher)
}

/** Asks again and keeps the answer for `version` — a live feed's tick; other callers then share the newer answer. */
export function reload<T>(key: string, repo: string, version: string | undefined, fetcher: () => Promise<T>): Promise<T> {
  return store(key, repo, version, fetcher)
}

/** Forgets everything read for a repository: a write there may have changed any of it. */
export function forgetRepo(repo: string): void {
  for (const [key, entry] of entries) if (entry.repo === repo) entries.delete(key)
}

/** Test hook: forget every answer. */
export function forgetAll(): void {
  entries.clear()
}

/** The version of a task's detail: the plan revision and what the snapshot says moved the task. */
export function taskVersion(repo: Pick<SharedRepoSnapshot, 'rev' | 'tasks'>, taskId: string): string {
  const task = repo.tasks.find((item) => item.id === taskId)
  return `${repo.rev}:${task?.status ?? ''}:${task?.runs ?? 0}:${task?.lastRunId ?? ''}`
}

/**
 * The shared reads (pf1): the same list or detail asked by several components, or again on a snapshot that did not
 * move it, is one request. `version` — what the snapshot says about the resource; see `loadOnce`.
 */
/** How long an answer the version does not fully describe is reused after it came. */
export const SHARED_MAX_AGE_MS = 3000

export const shared = {
  /** The whole snapshot: the store's first read and the review centre's poll at boot are one request; an answer is never reused. */
  state: () => loadOnce('state', '', undefined, () => api.state(), 0),
  task: (repo: string, id: string, version: string | undefined) => loadOnce(`task:${repo}:${id}`, repo, version, () => api.task(repo, id), SHARED_MAX_AGE_MS),
  /** A live feed's tick: always asks, and the newer answer serves the next reader of the same version. */
  taskReload: (repo: string, id: string, version: string | undefined) => reload(`task:${repo}:${id}`, repo, version, () => api.task(repo, id)),
  planDrafts: (repo: string, version: string | undefined) => loadOnce(`drafts:${repo}`, repo, version, () => api.planDrafts(repo)),
  planDraftJobs: (repo: string, version: string | undefined) => loadOnce(`draft-jobs:${repo}`, repo, version, () => api.planDraftJobs(repo)),
  presets: (repo: string) => loadOnce(`presets:${repo}`, repo, undefined, () => api.presets(repo), SHARED_MAX_AGE_MS),
  /** Copies and their sizes: by the plan revision in the task panel (a run's start or end moves it), else briefly. */
  worktrees: (repo: string, version?: string) => loadOnce(`worktrees:${repo}`, repo, version, () => api.worktrees(repo), version === undefined ? SHARED_MAX_AGE_MS : Number.POSITIVE_INFINITY),
}
