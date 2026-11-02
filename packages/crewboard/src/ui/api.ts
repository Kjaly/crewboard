import type { LiveChange } from '../live.js'
import type { AssignmentView, GoalEvent, ProviderId, RequestAction } from '../model/types.js'
import type { GoalAnalytics } from '../analytics.js'
import type { GoalHistory } from '../history/sessions.js'
import type { ProjectSummary } from '../owner.js'
import type { AgentReadiness } from '../doctor.js'

export type { LiveChange }

/** A registered agent as the screen shows it. */
export type AgentBadge = { id: string; label: string; color?: string }

/** Everything the screen asks the server; tests pass an in-memory one. */
export type Api = {
  projects(): Promise<ProjectSummary[]>
  agents(): Promise<AgentBadge[]>
  doctor(): Promise<AgentReadiness[]>
  goal(project: string, goalId: string): Promise<AssignmentView>
  events(project: string, goalId: string, assignmentId: string): Promise<GoalEvent[]>
  history(project: string, goalId: string): Promise<GoalHistory>
  analytics(project: string, goalId: string): Promise<GoalAnalytics>
  answer(project: string, goalId: string, assignmentId: string, text: string): Promise<'ok' | 'conflict'>
  request(project: string, goalId: string, assignmentId: string, action: RequestAction, text?: string, provider?: ProviderId): Promise<'ok' | 'conflict'>
  emergencyStop(project: string, goalId: string, assignmentId: string): Promise<'ok' | 'conflict'>
  live(onChange: (c: LiveChange) => void, onStatus: (online: boolean) => void): () => void
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function post(url: string, body: unknown): Promise<'ok' | 'conflict'> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 409) return 'conflict'
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return 'ok'
}

export function httpApi(base = ''): Api {
  return {
    request: (project, goalId, assignmentId, action, text, provider) =>
      post(`${base}/api/request`, { project, goalId, assignmentId, action, ...(text ? { text } : {}), ...(provider ? { provider } : {}) }),
    emergencyStop: (project, goalId, assignmentId) => post(`${base}/api/emergency-stop`, { project, goalId, assignmentId }),
    projects: () => getJson(`${base}/api/projects`),
    agents: () => getJson(`${base}/api/agents`),
    doctor: () => getJson(`${base}/api/doctor`),
    goal: (project, goalId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}?${q({ project })}`),
    history: (project, goalId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}/history?${q({ project })}`),
    analytics: (project, goalId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}/analytics?${q({ project })}`),
    events: (project, goalId, assignmentId) => getJson(`${base}/api/goals/${encodeURIComponent(goalId)}/events?${q({ project, assignmentId })}`),
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
