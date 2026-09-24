import { API_PREFIX, type AcceptResult, type OrchestraSnapshot, type PlanCost, type RepoSnapshot, type Routing, type RunStepSummary, type TaskDetail, type TaskReviewDetail, type Trajectory, type WorkersInfo, type WorktreeGcResult, type WorktreePolicyResult, type WorktreesInfo, type WorkerPreset, type EffectiveRouting, type SidebarOrder, type CheckSetting } from '../shared/types.js'
import type { WorktreePolicy, Recipe } from '@crewboard/core'
import type { Finding, PlanDraft } from '../../../core/src/plan/draft.js'
import type { DraftJobSummary } from '../../../core/src/plan/draft-jobs.js'

/** A worker on the Welcome checklist: «ready» only when the launch's own preflight passed. */
export type WelcomeWorkerStatus = 'ready' | 'sign_in' | 'missing' | 'not_ready' | 'unchecked'

export type { DraftJobSummary }
export type DraftJobDetail = { job: DraftJobSummary; answer?: string }

export type DraftSummary = { id: string; goal: string; source: PlanDraft['source']; taskCount: number; findings: Finding[] }
export type DraftDetail = { draft: PlanDraft; findings: Finding[] }

export const CLIENT_HEADER = 'x-orchestra-client'
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; message?: string }

async function readJson<T>(res: Response): Promise<ApiResult<T>> {
  try {
    return (await res.json()) as ApiResult<T>
  } catch {
    return { ok: false, error: `http_${res.status}` }
  }
}

async function post<T>(name: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
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
  draftFrom: (repo: string, file: string) => post<{ job: DraftJobSummary }>('plan-draft-from', { repo, file }),
  /** Saves an uploaded or pasted spec under .orchestration/specs and starts the same background draft job. */
  specUpload: (repo: string, spec: { name?: string; text: string }) => post<{ path: string; job: DraftJobSummary }>('spec-upload', { repo, ...spec }),
  exampleCreate: (repo: string, lang: 'en' | 'ru') => post<{ plan: string }>('example-create', { repo, lang }),
  exampleRemove: (repo: string) => post<null>('example-remove', { repo }),
  chatOpen: (repo: string, plan?: string, prompt?: string) => post<{ sessionId: string; created: boolean }>('chat-open', { repo, ...(plan ? { plan } : {}), ...(prompt ? { prompt } : {}) }),
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
  run: (repo: string, task: string, agent?: string) =>
    post<{ runId: string; agent: string; worktree?: { path: string; branch: string } }>('run', agent ? { repo, task, agent } : { repo, task }),
  workers: async (repo: string): Promise<ApiResult<WorkersInfo>> => readJson(await fetch(`${API_PREFIX}/workers?${query({ repo })}`)),
  saveWorkers: (repo: string, routing: Routing) => post<null>('workers-save', { repo, routing }),
  /** A new run in the same worktree, carrying the previous run's context (host route `POST /relaunch`). */
  relaunch: (repo: string, task: string, opts: { agent?: string; note?: string; fromStep?: string }) => post<{ runId: string }>('relaunch', { repo, task, ...opts }),
  /** «Continue» a run that ended unfinished: a relaunch with the direction to finish and report (host route `POST /continue`). */
  continueRun: (repo: string, task: string) => post<{ runId: string }>('continue', { repo, task }),
  steer: (repo: string, task: string, message: string) => post('steer', { repo, task, message }),
  stop: (repo: string, task: string) => post('stop', { repo, task }),
  accept: (repo: string, task: string) => post<AcceptResult>('accept', { repo, task }),
  taskUpsert: (repo: string, input: { id: string; parent: string; title: string; class?: string; lane?: string; depends: boolean; note: string; replace: boolean }) => post<{ id: string }>('task-upsert', { repo, ...input }),
  taskStatus: (repo: string, task: string, status: 'backlog' | 'ready') => post('task-status', { repo, task, status }),
  worktreeOpen: (repo: string, task: string, reveal: boolean) => post('worktree-open', { repo, task, reveal }),
  worktrees: async (repo: string): Promise<ApiResult<WorktreesInfo>> => readJson(await fetch(`${API_PREFIX}/worktrees?${query({ repo })}`)),
  worktreeGc: (repo: string, tasks: string[]) => post<WorktreeGcResult>('worktree-gc', { repo, tasks }),
  worktreePolicy: (repo: string, policy: WorktreePolicy) => post<WorktreePolicyResult>('worktree-policy', { repo, policy }),
  acceptBatch: (repo: string, tasks: string[]) => post<{ accepted: string[] }>('accept-batch', { repo, tasks }),
  reject: (repo: string, task: string, reason: string) => post('reject', { repo, task, reason }),
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
