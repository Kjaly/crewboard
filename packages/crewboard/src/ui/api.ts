import type { AgentsConfig, AgentsConfigView } from '../workers/agents.js'
import type { LiveChange } from '../live.js'
import type { AssignmentView, GoalEvent, ProviderId, RequestAction } from '../model/types.js'
import type { GoalAnalytics } from '../analytics.js'
import type { GoalHistory } from '../history/sessions.js'
import type { ProjectSummary } from '../owner.js'
import type { AgentReadiness } from '../doctor.js'
import type { ProviderUsage } from '../usage.js'
import type { CatalogModel } from '../workers/catalog.js'
import type { RunSteps } from '../workers/steps.js'

export type { LiveChange }

/** The mutation succeeded even if its follow-up read failed. Never retry the mutation for that failure. */
export type SendResult = { refreshFailed: boolean }
export type DiscussResult = SendResult & { copied: boolean; prompt: string }

/** A registered agent as the screen shows it. */
export type AgentBadge = {
  id: string
  label: string
  color?: string
  icon?: string
  /** The default model, the suggested models, the accepted effort levels and the default one. All may be absent: older servers send none. */
  model?: string
  models?: Array<{ id: string; label?: string; note?: string; efforts?: string[] } | string>
  catalog?: CatalogModel[]
  efforts?: string[]
  defaultEffort?: string | null
}

/** What a handoff request asks of the new worker besides the provider. */
export type HandoffPick = { model?: string; effort?: string | null }

/** Everything the screen asks the server; tests pass an in-memory one. */
export type Api = {
  projects(): Promise<ProjectSummary[]>
  agents(): Promise<AgentBadge[]>
  agentsConfig(): Promise<AgentsConfigView>
  saveAgentsConfig(config: AgentsConfig, revision: string): Promise<AgentsConfigView | 'conflict'>
  models(agent: string, refresh?: boolean): Promise<CatalogModel[]>
  doctor(): Promise<AgentReadiness[]>
  usage(): Promise<ProviderUsage[]>
  goal(project: string, goalId: string): Promise<AssignmentView>
  events(project: string, goalId: string, assignmentId: string): Promise<GoalEvent[]>
  history(project: string, goalId: string): Promise<GoalHistory>
  analytics(project: string, goalId: string): Promise<GoalAnalytics>
  answer(project: string, goalId: string, assignmentId: string, text: string): Promise<'ok' | 'conflict'>
  request(project: string, goalId: string, assignmentId: string, action: RequestAction, text?: string, provider?: ProviderId, pick?: HandoffPick): Promise<'ok' | 'conflict'>
  withdrawRequest(project: string, goalId: string, assignmentId: string, requestId: string): Promise<'ok' | 'conflict'>
  emergencyStop(project: string, goalId: string, assignmentId: string): Promise<'ok' | 'conflict'>
  steps(project: string, runId: string, since: number): Promise<RunSteps>
  live(onChange: (c: LiveChange) => void, onStatus: (online: boolean) => void): () => void
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

/** True for a failed request the server answered with 404: the thing asked for does not exist (any more). */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && /^404\b/.test(error.message)
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function post(url: string, body: unknown): Promise<'ok' | 'conflict'> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 409) return 'conflict'
  if (!res.ok) {
    const body = await res.text()
    let message = body
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      // Some servers return plain text instead of JSON.
    }
    throw new Error(message || String(res.status))
  }
  return 'ok'
}

export function httpApi(base = ''): Api {
  return {
    request: (project, goalId, assignmentId, action, text, provider, pick) =>
      post(`${base}/api/request`, {
        project, goalId, assignmentId, action,
        ...(text ? { text } : {}), ...(provider ? { provider } : {}),
        ...(pick?.model ? { model: pick.model } : {}), ...(pick?.effort !== undefined ? { effort: pick.effort } : {}),
      }),
    withdrawRequest: (project, goalId, assignmentId, requestId) => post(`${base}/api/request/withdraw`, { project, goalId, assignmentId, requestId }),
    emergencyStop: (project, goalId, assignmentId) => post(`${base}/api/emergency-stop`, { project, goalId, assignmentId }),
    agentsConfig: () => getJson(`${base}/api/agents-config`),
    async saveAgentsConfig(config, revision) {
      const res = await fetch(`${base}/api/agents-config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, revision }) })
      if (res.status === 409) return 'conflict'
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      return await res.json() as AgentsConfigView
    },
    projects: () => getJson(`${base}/api/projects`),
    agents: () => getJson(`${base}/api/agents`),
    models: (agent, refresh = false) => getJson(`${base}/api/models?${q({ agent, ...(refresh ? { refresh: '1' } : {}) })}`),
    doctor: () => getJson(`${base}/api/doctor`),
    usage: () => getJson(`${base}/api/usage`),
    goal: (project, goalId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}?${q({ project })}`),
    history: (project, goalId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}/history?${q({ project })}`),
    analytics: (project, goalId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}/analytics?${q({ project })}`),
    events: (project, goalId, assignmentId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}/events?${q({ project, assignmentId })}`),
    steps: (project, runId, since) => getJson(`${base}/api/runs/${encodeURIComponent(runId)}/steps?${q({ project, since: String(since) })}`),
    answer: (project, goalId, assignmentId, text) => post(`${base}/api/answer`, { project, goalId, assignmentId, text }),
    live(onChange, onStatus) {
      // EventSource reconnects by itself; `hello` arrives on every (re)connect.
      const source = new EventSource(`${base}/api/live`)
      source.addEventListener('hello', () => onStatus(true))
      source.addEventListener('change', (e) => onChange(JSON.parse((e as MessageEvent<string>).data) as LiveChange))
      source.onerror = () => onStatus(false)
      return () => source.close()
    },
  }
}

/** Collects pushes and hands them over together once `ms` passes without being flushed: one refresh per burst. */
export function coalesce<T>(fn: (batch: T[]) => void, ms: number): { push(item: T): void; cancel(): void } {
  let batch: T[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    push(item) {
      batch.push(item)
      timer ??= setTimeout(() => {
        const out = batch
        batch = []
        timer = undefined
        fn(out)
      }, ms)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
      batch = []
    },
  }
}
