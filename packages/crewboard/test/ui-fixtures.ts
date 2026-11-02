import type { AssignmentView, GoalEvent, Status } from '../src/model/types.js'
import type { ProjectSummary } from '../src/owner.js'
import type { Api, AgentBadge } from '../src/ui/api.js'
import type { LiveChange } from '../src/live.js'
import type { GoalHistory } from '../src/history/sessions.js'

export const node = (id: string, status: Status, extra: Partial<AssignmentView> = {}, children: AssignmentView[] = []): AssignmentView => ({
  id, parentId: 'g', title: id, criteria: [], resultKind: 'local', provider: 'codex', after: [], handoffs: [], status, doing: { kind: 'text', text: `doing ${id}` }, children, ...extra,
})

export const kitchen = (): AssignmentView =>
  node('g', 'running', { parentId: null, title: 'Кухня полного цикла', provider: 'lead', resultKind: 'goal', quote: 'Хочу кухню полного цикла' }, [
    node('hw', 'done', { title: 'Исследовать петли' }),
    node('box', 'running', { title: 'Модель короба', criteria: ['Панели с толщиной'], quote: 'Раздал работу' }, [node('geo', 'waiting_answer', { parentId: 'box', title: 'Тесты геометрии' })]),
    node('ux', 'waiting_owner', { title: 'Мобильная панель', provider: 'claude' }),
    node('pdf', 'queued', { title: 'Сборочная инструкция', provider: 'deepseek' }),
  ])

/** An `Api` in memory: tests change `tree`/`projects`, then `emit` a live change or a connection status. */
export function fakeApi(init: { projects?: ProjectSummary[]; tree?: AssignmentView; events?: Record<string, GoalEvent[]>; agents?: AgentBadge[] } = {}) {
  const state = {
    doctor: [] as Array<{ id: string; label: string; ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> }>,
    agents: init.agents ?? [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }, { id: 'deepseek', label: 'DeepSeek' }],
    tree: init.tree ?? kitchen(),
    projects: init.projects ?? [{ repo: '/repo/cabinet', name: 'cabinet', goals: [{ goalId: 'g', title: 'Кухня полного цикла', createdAt: '2026-11-02T10:00:00Z', status: 'running' as Status, leadOnline: true, counts: { waiting_owner: 1, running: 2, queued: 1, finished: 1 } }] }],
    events: init.events ?? {},
    answers: [] as string[],
    requests: [] as Array<{ id: string; action: string; text?: string; provider?: string }>,
    stops: [] as string[],
    answerResult: 'ok' as 'ok' | 'conflict' | 'fail',
    trees: {} as Record<string, AssignmentView>,
    delays: {} as Record<string, number>,
    calls: { projects: 0, goal: 0, history: 0 },
    history: { available: true, truncated: false, items: [
      { kind: 'session', ts: '2026-11-02T10:00:00Z', sessionId: 's1' },
      { kind: 'owner', ts: '2026-11-02T10:01:00Z', text: 'Хочу кухню полного цикла' },
      { kind: 'lead', ts: '2026-11-02T10:02:00Z', text: 'Раздал работу.' },
      { kind: 'assignment', ts: '2026-11-02T10:03:00Z', tool: 'assign', goalId: 'g', assignmentId: 'ux', title: 'Мобильная панель' },
      { kind: 'assignment', ts: '2026-11-02T10:04:00Z', tool: 'assign', goalId: 'g', assignmentId: 'gone', title: 'Удалённое поручение' },
      { kind: 'actions', ts: '2026-11-02T10:05:00Z', count: 3 },
    ] } as GoalHistory,
  }
  let onChange: ((c: LiveChange) => void) | undefined
  let onStatus: ((online: boolean) => void) | undefined
  const api: Api = {
    async agents() {
      return state.agents
    },
    async doctor() {
      return state.doctor
    },
    async projects() {
      state.calls.projects += 1
      return state.projects
    },
    async goal(_p, goalId) {
      state.calls.goal += 1
      const tree = state.trees[goalId] ?? state.tree
      const delay = state.delays[goalId]
      if (delay) await new Promise((r) => setTimeout(r, delay))
      return tree
    },
    async events(_p, _g, id) {
      return state.events[id] ?? []
    },
    async answer(_p, _g, _a, text) {
      state.answers.push(text)
      await new Promise((r) => setTimeout(r, 20))
      if (state.answerResult === 'fail') throw new Error('Failed to fetch')
      return state.answerResult
    },
    async request(_p, _g, id, action, text, provider) {
      state.requests.push({ id, action, ...(text ? { text } : {}), ...(provider ? { provider } : {}) })
      await new Promise((r) => setTimeout(r, 20))
      return 'ok'
    },
    async emergencyStop(_p, _g, id) {
      state.stops.push(id)
      return 'ok'
    },
    async history() {
      state.calls.history += 1
      return state.history
    },
    async analytics() {
      return { from: '2026-11-02T10:00:00Z', to: '2026-11-02T11:00:00Z', lanes: [], byProvider: {}, byAssignment: [] }
    },
    live(change, status) {
      onChange = change
      onStatus = status
      status(true)
      return () => {
        onChange = undefined
      }
    },
  }
  return {
    api,
    state,
    emit: (c: LiveChange) => onChange?.(c),
    online: (v: boolean) => onStatus?.(v),
  }
}
