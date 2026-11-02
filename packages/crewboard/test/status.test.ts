import { describe, expect, it } from 'vitest'
import { availableActions, buildTree, deriveStatus, doingOf } from '../src/model/project.js'
import { LEAD_SILENT_PAUSE_MS, STALE_ABANDON_MS } from '../src/model/thresholds.js'
import type { Doing, GoalEvent, NewEvent, Status } from '../src/model/types.js'

const NOW = new Date('2026-11-02T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
let seq = 0
const ev = (e: Partial<NewEvent> & { type: GoalEvent['type'] }, ts = ago(60_000)): GoalEvent =>
  ({ goalId: 'g', assignmentId: 'a', actor: 'system', ...e, seq: ++seq, ts }) as GoalEvent

const assigned = () => ev({ type: 'assigned', parentId: 'g', title: 'Короб', criteria: ['c'], resultKind: 'local', provider: 'codex', after: [] })
const started = () => ev({ type: 'run_started', runId: 'r1', agent: 'codex/', cwd: '/repo' })
const question = () => ev({ type: 'question', text: 'Шторка?', options: [] })
const ctx = (parentStatus: Status | null = 'running') => ({ parentStatus, isRoot: false, now: NOW })

describe('deriveStatus', () => {
  it.each<[string, () => GoalEvent[], ReturnType<typeof ctx> | { parentStatus: null; isRoot: true; now: Date; leadLastSeen?: Date }, Status]>([
    ['только поручено', () => [assigned()], ctx(), 'queued'],
    ['запущено', () => [assigned(), started()], ctx(), 'running'],
    ['вопрос ведущему', () => [assigned(), started(), question()], ctx(), 'waiting_answer'],
    ['эскалация', () => [assigned(), started(), question(), ev({ type: 'escalated', text: 'Шторка?', options: [], why: 'вкус' })], ctx(), 'waiting_owner'],
    ['ведущий сам спросил владельца, без вопроса исполнителя', () => [assigned(), started(), ev({ type: 'escalated', text: 'Цвет фасада?', options: [], why: 'вкус' })], ctx(), 'waiting_owner'],
    ['ответ получен', () => [assigned(), started(), question(), ev({ type: 'escalated', text: 'Шторка?', options: [], why: 'вкус' }), ev({ type: 'answered', text: 'Шторка' })], ctx(), 'running'],
    ['закрыто', () => [assigned(), started(), ev({ type: 'reported', summary: 'ok' }), ev({ type: 'closed', summary: 'ok' })], ctx(), 'done'],
    ['отменено', () => [assigned(), ev({ type: 'cancelled', reason: 'курс' })], ctx(), 'cancelled'],
    ['родитель отменён', () => [assigned(), started()], ctx('cancelled'), 'abandoned'],
    ['запуск кончился без итога давно', () => [assigned(), started(), ev({ type: 'run_ended', runId: 'r1', outcome: 'failed' }, ago(STALE_ABANDON_MS + 1000))], ctx(), 'abandoned'],
    ['запуск упал недавно: ход за ведущим', () => [assigned(), started(), ev({ type: 'run_ended', runId: 'r1', outcome: 'failed', reason: 'auth' })], ctx(), 'waiting_answer'],
    ['доложил итог: ждёт решения ведущего', () => [assigned(), started(), ev({ type: 'reported', summary: 'ok' }), ev({ type: 'run_ended', runId: 'r1', outcome: 'completed' })], ctx(), 'waiting_answer'],
    ['переоткрыто после закрытия', () => [assigned(), started(), ev({ type: 'reported', summary: 'ok' }), ev({ type: 'closed', summary: 'ok' }), ev({ type: 'reopened', note: 'добавь кнопку' })], ctx(), 'waiting_answer'],
    ['возвращено после отмены', () => [assigned(), ev({ type: 'cancelled', reason: 'курс' }), ev({ type: 'reopened', note: 'вернули' })], ctx(), 'queued'],
    ['корень, ведущий молчит', () => [ev({ type: 'goal_started', assignmentId: 'g', title: 'Кухня', criteria: [] })], { parentStatus: null, isRoot: true, now: NOW, leadLastSeen: new Date(ago(LEAD_SILENT_PAUSE_MS + 1000)) }, 'paused'],
    ['корень, ведущий на связи', () => [ev({ type: 'goal_started', assignmentId: 'g', title: 'Кухня', criteria: [] })], { parentStatus: null, isRoot: true, now: NOW, leadLastSeen: new Date(ago(60_000)) }, 'running'],
  ])('%s', (_name, events, c, expected) => {
    expect(deriveStatus(events(), c)).toBe(expected)
  })
})

describe('buildTree', () => {
  it('nests children by parent and abandons work under a cancelled node', () => {
    const events: GoalEvent[] = [
      ev({ type: 'goal_started', assignmentId: 'g', title: 'Кухня', criteria: [] }),
      ev({ type: 'assigned', assignmentId: 'box', parentId: 'g', title: 'Короб', criteria: [], resultKind: 'branch', provider: 'codex', after: [] }),
      ev({ type: 'assigned', assignmentId: 'geo', parentId: 'box', title: 'Тесты', criteria: [], resultKind: 'local', provider: 'codex', after: [] }),
      ev({ type: 'run_started', assignmentId: 'geo', runId: 'r2', agent: 'codex/', cwd: '/repo' }),
      ev({ type: 'cancelled', assignmentId: 'box', reason: 'курс изменён' }),
    ]
    const root = buildTree(events, NOW, NOW)
    expect(root.id).toBe('g')
    expect(root.children.map((c) => c.id)).toEqual(['box'])
    const box = root.children[0]!
    expect(box.status).toBe('cancelled')
    expect(box.children[0]!.id).toBe('geo')
    expect(box.children[0]!.status).toBe('abandoned')
  })
})

describe('doingOf', () => {
  it.each<[string, () => GoalEvent[], Status, Doing]>([
    ['упал', () => [assigned(), started(), ev({ type: 'run_ended', runId: 'r1', outcome: 'failed', reason: 'auth' })], 'waiting_answer', { kind: 'failed', reason: 'auth' }],
    ['доложил', () => [assigned(), started(), ev({ type: 'reported', summary: 'ok' }), ev({ type: 'run_ended', runId: 'r1', outcome: 'completed' })], 'waiting_answer', { kind: 'reported' }],
    ['ждёт владельца', () => [assigned(), started(), question()], 'waiting_owner', { kind: 'waiting_owner' }],
    ['прогресс', () => [assigned(), started(), ev({ type: 'progress', text: 'Пишет тесты, 6 из 9' })], 'running', { kind: 'text', text: 'Пишет тесты, 6 из 9' }],
  ])('%s', (_name, events, status, expected) => {
    expect(doingOf(events(), status)).toEqual(expected)
  })
})

describe('requests, handoffs and actions in the tree', () => {
  const tree = (...extra: GoalEvent[]) =>
    buildTree([ev({ type: 'goal_started', assignmentId: 'g', title: 'Кухня', criteria: [] }), assigned(), started(), ...extra], NOW, NOW).children[0]!

  it('takes the provider from the last handoff and remembers the chain', () => {
    const a = tree(ev({ type: 'reassigned', provider: 'claude' }))
    expect(a.provider).toBe('claude')
    expect(a.handoffs).toEqual([{ from: 'codex', to: 'claude' }])
  })

  it.each([
    ['pending', () => [ev({ type: 'owner_requested', requestId: 'r1', action: 'stop' })], { id: 'r1', action: 'stop', state: 'pending' }],
    ['declined', () => [ev({ type: 'owner_requested', requestId: 'r1', action: 'stop' }), ev({ type: 'request_decided', requestId: 'r1', decision: 'declined', reason: 'нужна для инструкции' })], { id: 'r1', state: 'declined', reason: 'нужна для инструкции' }],
    ['accepted', () => [ev({ type: 'owner_requested', requestId: 'r1', action: 'stop' }), ev({ type: 'request_decided', requestId: 'r1', decision: 'accepted' })], undefined],
  ] as const)('shows a %s request', (_name, events, expected) => {
    const base = [ev({ type: 'goal_started', assignmentId: 'g', title: 'Кухня', criteria: [] }), assigned(), started()]
    const a = buildTree([...base, ...events()], NOW, NOW).children[0]!
    if (expected === undefined) expect(a.request).toBeUndefined()
    else expect(a.request).toMatchObject(expected)
  })

  it.each([
    ['running', 'running', true, ['clarify', 'stop', 'handoff', 'discuss']],
    ['waiting for the lead', 'waiting_answer', true, ['clarify', 'stop', 'handoff', 'discuss']],
    ['queued', 'queued', true, ['start_now', 'cancel', 'discuss']],
    ['done', 'done', true, ['reopen', 'discuss']],
    ['cancelled', 'cancelled', true, ['revive', 'discuss']],
    ['abandoned', 'abandoned', true, ['revive', 'discuss']],
    ['waiting for you', 'waiting_owner', true, ['discuss']],
  ] as const)('offers the right actions when %s', (_name, status, online, expected) => {
    const a = { ...tree(), status, request: undefined }
    expect(availableActions(a, online)).toEqual(expected)
  })

  it('offers only discussion while a request waits, and an emergency stop when the lead is away', () => {
    const pending = tree(ev({ type: 'owner_requested', requestId: 'r1', action: 'clarify', text: 'x' }))
    expect(availableActions(pending, true)).toEqual(['discuss'])
    expect(availableActions({ ...tree(), status: 'running' }, false)).toContain('emergency_stop')
  })
})
