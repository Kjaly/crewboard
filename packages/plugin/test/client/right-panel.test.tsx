// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { OrchestraPlanSummary, OrchestraSnapshot } from '../../src/shared/types.js'
import { OrchestraTabBody } from '../../src/client/right-pane.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import {
  FakeEventSource,
  ROOT,
  installEventSource,
  installFetch,
  installMatchMedia,
  jsonFail,
  jsonOk,
  makeDetail,
  makeRepo,
  makeSnapshot,
  makeTask,
} from './helpers.js'

type SessionState = { byId: Record<string, { cwd?: string } | undefined> }

/** The slot hands the body a `useSessions` selector hook; the fake answers from a fixed map. */
function fakeSessions(map: Record<string, string>) {
  const state: SessionState = { byId: Object.fromEntries(Object.entries(map).map(([id, cwd]) => [id, { cwd }])) }
  return <T,>(select: (s: SessionState) => T): T => select(state)
}

/** A plan summary as the host ships it — `chat` appears once `chats.json` binds a session. */
beforeEach(() => setLang('ru'))

const makePlan = (id: string, patch: Partial<OrchestraPlanSummary> = {}): OrchestraPlanSummary => ({
  id,
  goal: 'цель плана',
  archived: false,
  current: id === 'main',
  rev: 1,
  updatedAt: '2026-09-22T12:00:00Z',
  taskCount: 3,
  running: 0,
  inReview: 0,
  waitingHuman: 0,
  ready: 0,
  accepted: 0,
  attention: [],
  ...patch,
})

async function mount(opts: {
  sessionId?: string
  sessions?: Record<string, string>
  snapshot: OrchestraSnapshot
  answer?: (url: string) => unknown
}) {
  installMatchMedia(false)
  installEventSource()
  const calls = installFetch((url) => {
    if (url.includes('/api/cost')) return jsonOk({ generatedAt: '', runs: [], totals: {}, accepted: [] })
    if (url.includes('/api/task')) return jsonOk(makeDetail({ id: 'x', changedFiles: ['src/a.ts', 'src/b.ts'] }))
    const own = opts.answer?.(url)
    return own ?? jsonOk(opts.snapshot)
  })
  const sessions = fakeSessions(opts.sessions ?? { 's-1': ROOT })
  const utils = render(<OrchestraTabBody sessionId={opts.sessionId ?? 's-1'} useSessions={sessions} />)
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', opts.snapshot)
  })
  return { calls, sessions, ...utils }
}

beforeEach(() => {
  setLang('ru')
  localStorage.clear()
  resetOrchestraStore()
})
afterEach(() => cleanup())

it('shows the plan of its session workspace and follows the session to another one', async () => {
  const alpha = makeRepo([makeTask({ id: 'a1', title: 'Задача альфы', status: 'running', worker: 'dsh', activeSince: '2026-09-22T11:00:00Z' })], [], {
    root: '/ws/alpha',
    goal: 'План альфа',
  })
  const beta = makeRepo([makeTask({ id: 'b1', title: 'Задача беты', status: 'ready' })], [], { root: '/ws/beta', goal: 'План бета' })
  const snap = makeSnapshot(alpha, beta)
  const sessions = fakeSessions({ 's-1': '/ws/alpha', 's-2': '/ws/beta' })

  const { rerender } = await mount({ sessionId: 's-1', sessions: { 's-1': '/ws/alpha', 's-2': '/ws/beta' }, snapshot: snap })
  expect(screen.getByRole('heading', { name: 'План альфа' })).toBeTruthy()
  expect(screen.getByText('Задача альфы')).toBeTruthy()
  expect(screen.queryByText('План бета')).toBeNull()

  // The shell re-uses the tab for another session: a new sessionId means a new workspace, hence a new plan.
  rerender(<OrchestraTabBody sessionId="s-2" useSessions={sessions} />)
  expect(screen.getByRole('heading', { name: 'План бета' })).toBeTruthy()
  expect(screen.getByText('Задача беты')).toBeTruthy()
  expect(screen.queryByText('План альфа')).toBeNull()
})

it('«Принять» posts the same request as the review queue, and «declined» shows in the row', async () => {
  const user = userEvent.setup()
  const snap = makeSnapshot(
    makeRepo([makeTask({ id: 'a', title: 'Готова к приёмке', status: 'in_review', worker: 'dsh', runs: 1, lastRunId: 'run-1' })], [], {
      goal: 'План',
      planId: 'main',
      plans: [makePlan('main')],
    }),
  )
  const { calls } = await mount({ snapshot: snap, answer: (url) => (url.endsWith('/accept') ? jsonFail('declined') : undefined) })

  const row = screen.getByText('Готова к приёмке').closest('li')!
  await user.click(within(row).getByRole('button', { name: 'Принять' }))

  const post = calls.find((c) => c.url.endsWith('/accept'))
  expect(post?.method).toBe('POST')
  expect(post?.headers['x-orchestra-client']).toBe('1')
  expect(post?.body).toMatchObject({ repo: ROOT, task: 'a' })
  expect(await within(row).findByText('Отменено в окне подтверждения')).toBeTruthy()
})

it('a workspace without a plan offers «Завести план» and posts /plan-init with the goal', async () => {
  const user = userEvent.setup()
  // hasPlan is what decides — a fresh workspace still reports degraded: true (2k/2 journal).
  const repo = makeRepo([], [], { hasPlan: false, degraded: true, error: 'no plans', goal: '', title: 'Пустая папка' })
  const { calls } = await mount({ snapshot: makeSnapshot(repo), answer: (url) => (url.endsWith('/plan-init') ? jsonOk(repo) : undefined) })

  expect(screen.getByText('В этой папке нет плана.')).toBeTruthy()
  expect(screen.queryByText(/не читается/)).toBeNull()

  await user.type(screen.getByLabelText('Цель плана'), 'Собрать релиз')
  await user.click(screen.getByRole('button', { name: 'Завести план' }))

  const post = calls.find((c) => c.url.endsWith('/plan-init'))
  expect(post?.method).toBe('POST')
  expect(post?.body).toMatchObject({ repo: ROOT, goal: 'Собрать релиз' })
})

it('«Сделать этот чат оркестратором» posts the binding and the header follows', async () => {
  const user = userEvent.setup()
  const repo = makeRepo([makeTask({ id: 'a', title: 'Задача', status: 'ready' })], [], {
    goal: 'План',
    planId: 'main',
    plans: [makePlan('main')],
  })
  const bound = { ...repo, plans: [makePlan('main', { chat: { sessionId: 's-1', wake: true } })] }
  const { calls } = await mount({ snapshot: makeSnapshot(repo), answer: (url) => (url.endsWith('/chat-bind') ? jsonOk({ sessionId: 's-1', wake: true }) : undefined) })

  expect(screen.getByText(/чат не назначен/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Сделать этот чат оркестратором' }))

  const post = calls.find((c) => c.url.endsWith('/chat-bind'))
  expect(post?.method).toBe('POST')
  expect(post?.body).toMatchObject({ repo: ROOT, plan: 'main', sessionId: 's-1' })

  // The host refresh lands as an SSE snapshot; the caption then reads «этот чат ведёт план».
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', makeSnapshot(bound))
  })
  expect(screen.getByText(/этот чат ведёт план/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Сделать этот чат оркестратором' })).toBeNull()
})
