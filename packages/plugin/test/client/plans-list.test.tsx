// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { plansOf, type PlanItem } from '../../src/client/plans.js'
import { RepoSidebar } from '../../src/client/sidebar.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { formatRoute } from '../../src/client/route.js'
import { type FetchCall, FakeEventSource, ROOT, installEventSource, installFetch, jsonFail, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))

let calls: FetchCall[] = []

const plan = (p: Partial<PlanItem> & { id: string }): PlanItem => ({
  goal: `План ${p.id}`,
  archived: false,
  current: false,
  rev: 1,
  updatedAt: '2026-09-22T11:00:00Z',
  taskCount: 0,
  running: 0,
  inReview: 0,
  waitingHuman: 0,
  ready: 0,
  accepted: 0,
  attention: [],
  ...p,
})

const plans = () => [
  plan({ id: 'main', goal: 'Плагин 1–2e', current: true, taskCount: 4, ready: 1, accepted: 2 }),
  plan({
    id: 'bg',
    goal: 'Фоновый рефактор',
    taskCount: 3,
    running: 1,
    inReview: 2,
    waitingHuman: 2,
    attention: [{ kind: 'stalled', severity: 'alert', taskId: 't1', runId: 'run_1', message: 'воркер молчит 12 мин' }],
  }),
  plan({ id: 'old', goal: 'Старый план', archived: true, taskCount: 2, accepted: 2 }),
]

const fixtureRepo = () => makeRepo([makeTask({ id: 'a' })], [], { planId: 'main', plans: plans() })

function mountSidebar(repo = fixtureRepo(), snapshot = makeSnapshot(repo)) {
  calls = installFetch(() => jsonOk(null))
  render(<RepoSidebar snapshot={snapshot} repo={repo} open onToggle={() => {}} />)
}

const posts = (name: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(`/api/${name}`))

beforeEach(() => {
  calls = []
  localStorage.clear()
})
afterEach(() => cleanup())

describe('repository sidebar', () => {
  it('shows no plan rows before a plan exists', () => {
    const repo = makeRepo([], [], { hasPlan: false, plans: [], goal: '', root: ROOT })
    expect(plansOf(repo)).toEqual([])
    mountSidebar(repo)
    expect(screen.getByRole('button', { name: 'repo' })).toBeTruthy()
    expect(screen.queryByText('цель плана')).toBeNull()
  })

  it('marks the current plan and shows a background plan’s counters', () => {
    mountSidebar()
    const current = screen.getByRole('treeitem', { name: /Плагин 1–2e/ })
    expect(current.getAttribute('aria-current')).toBe('true')
    const bg = screen.getByRole('treeitem', { name: /^Фоновый рефактор/ })
    expect(bg.getAttribute('aria-current')).toBeNull()
    const mark = bg.querySelector('.orc-srow__state')
    expect(mark?.getAttribute('aria-label')).toBe('1 в работе · 2 ждут вас · 1 ошибка')
    expect(mark?.querySelector('.orc-sdot--failed')).toBeTruthy()
  })

  it('switches plan on click, never on the current one', async () => {
    const user = userEvent.setup()
    mountSidebar()
    await user.click(screen.getByRole('treeitem', { name: /^Фоновый рефактор/ }))
    await waitFor(() => expect(posts('plan-use')).toHaveLength(1))
    expect(posts('plan-use')[0]?.body).toEqual({ repo: ROOT, plan: 'bg' })
    await user.click(screen.getByRole('treeitem', { name: /Плагин 1–2e/ }))
    expect(posts('plan-use')).toHaveLength(1)
  })

  it('creates a plan from the composer on Enter', async () => {
    const user = userEvent.setup()
    mountSidebar()
    // rg1: a new plan starts from the repository row's menu; «+» next to Repositories adds a repository.
    await user.click(screen.getByRole('button', { name: /^Действия для репозитория/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Новый план…' }))
    await user.type(screen.getByRole('textbox', { name: 'Цель нового плана' }), 'Переписать рендер{Enter}')
    await waitFor(() => expect(posts('plan-new')).toHaveLength(1))
    expect(posts('plan-new')[0]?.body).toEqual({ repo: ROOT, goal: 'Переписать рендер' })
  })

  it('keeps the archive folded under the repo, then unarchives from the menu', async () => {
    const user = userEvent.setup()
    mountSidebar()
    expect(screen.queryByText('Старый план')).toBeNull()
    await user.click(screen.getByRole('treeitem', { name: /Архив · 1/ }))
    expect(screen.getByText('Старый план')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Действия с планом «Старый план»' }))
    await user.click(screen.getByRole('menuitem', { name: 'Вернуть из архива' }))
    await waitFor(() => expect(posts('plan-archive')).toHaveLength(1))
    expect(posts('plan-archive')[0]?.body).toEqual({ repo: ROOT, plan: 'old', archived: false })
  })

  it('renames a plan inline from its menu', async () => {
    const user = userEvent.setup()
    mountSidebar()
    await user.click(screen.getByRole('button', { name: 'Действия с планом «Фоновый рефактор»' }))
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать…' }))
    const field = screen.getByRole('textbox', { name: 'Новое название плана «Фоновый рефактор»' })
    await user.clear(field)
    await user.type(field, 'Рефактор трассы{Enter}')
    await waitFor(() => expect(posts('plan-rename')).toHaveLength(1))
    expect(posts('plan-rename')[0]?.body).toEqual({ repo: ROOT, plan: 'bg', goal: 'Рефактор трассы' })
  })

  it('pins and hides a repository from its row menu', async () => {
    const user = userEvent.setup()
    mountSidebar()
    await user.click(screen.getByRole('button', { name: 'Действия для репозитория «repo»' }))
    await user.click(screen.getByRole('menuitem', { name: 'Закрепить' }))
    await waitFor(() => expect(posts('repo-flag')).toHaveLength(1))
    expect(posts('repo-flag')[0]?.body).toEqual({ repo: ROOT, flag: 'pinned', value: true })
    await user.click(screen.getByRole('button', { name: 'Действия для репозитория «repo»' }))
    await user.click(screen.getByRole('menuitem', { name: 'Скрыть' }))
    await waitFor(() => expect(posts('repo-flag')).toHaveLength(2))
    expect(posts('repo-flag')[1]?.body).toEqual({ repo: ROOT, flag: 'hidden', value: true })
  })

  it('lists a background plan’s wait in the inbox across repositories', async () => {
    const user = userEvent.setup()
    mountSidebar()
    const row = screen.getAllByRole('button', { name: /Фоновый рефактор/ }).find((el) => el.classList.contains('orc-ibrow'))
    expect(row).toBeTruthy()
    expect(row?.getAttribute('title')).toContain('2 ждут вас')
    await user.click(row as HTMLElement)
    await waitFor(() => expect(posts('plan-use')).toHaveLength(1))
  })

  it('falls back to the plan on screen when the host sends no plans list', () => {
    mountSidebar(makeRepo([makeTask({ id: 'a' })]))
    expect(screen.getByRole('treeitem', { name: /цель плана/ }).getAttribute('aria-current')).toBe('true')
    expect(plansOf(makeRepo([]))).toHaveLength(1)
  })
})

describe('sidebar in the screen', () => {
  async function mountApp() {
    installEventSource()
    const repo = fixtureRepo()
    const snapshot = makeSnapshot(repo)
    calls = installFetch(() => jsonOk(snapshot))
    render(<App />)
    await act(async () => {
      FakeEventSource.last?.emit('snapshot', snapshot)
    })
    return repo
  }

  beforeEach(() => resetOrchestraStore())

  it('shows the sidebar and remembers the view per plan', async () => {
    const user = userEvent.setup()
    await mountApp()
    expect(screen.getByRole('navigation', { name: 'Репозитории' })).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'Работа' }))
    expect(localStorage.getItem(`crewboard:view:${ROOT}:main`)).toBe('work')
  })

  it('collapses to a badge rail with repository initials', async () => {
    const user = userEvent.setup()
    await mountApp()
    await user.click(screen.getByRole('button', { name: 'Свернуть планы' }))
    expect(screen.getByRole('navigation', { name: 'Репозитории' })).toBeTruthy()
    expect(document.querySelector('.orc-plans__badge')?.getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Развернуть планы' })).toBeTruthy()
    expect(localStorage.getItem('crewboard:plans-open')).toBe('0')
  })
})

describe('draft review in the screen', () => {
  const draft = {
    id: 'next', goal: 'Новый маршрут', source: 'chat' as const, lanes: ['Поставка'], decisions: ['Сначала схема'],
    tasks: [{ id: 'schema', title: 'Создать схему', lane: 'Поставка', class: 'code', kind: 'implement', deps: [], contract: 'schema.ts', acceptance: ['Схема работает'], sources: ['spec.md'] }],
  }
  const summary = (findings: unknown[] = []) => [{ id: draft.id, goal: draft.goal, source: draft.source, taskCount: 1, findings }]
  const repo = fixtureRepo()
  const snapshot = makeSnapshot(repo)
  function mountDraft(findings: unknown[] = [], approveResponse: unknown = jsonOk({ plan: 'next' })) {
    resetOrchestraStore()
    installEventSource()
    let discarded = false
    calls = installFetch((url) => {
      if (url.includes('/api/plan-drafts?')) return jsonOk(discarded ? [] : summary(findings))
      if (url.includes('/api/plan-draft?')) return jsonOk({ draft, findings })
      if (url.includes('/api/plan-draft-approve')) return approveResponse
      if (url.includes('/api/plan-draft-discard')) { discarded = true; return jsonOk(null) }
      if (url.includes('/api/state')) return jsonOk(snapshot)
      return jsonOk(null)
    })
    render(<App />)
    act(() => { FakeEventSource.last?.emit('snapshot', snapshot) })
  }

  it('restores draft review from its route after reload', async () => {
    window.history.replaceState(null, '', formatRoute({ repo: ROOT, plan: 'main', view: 'graph', draft: 'next' }))
    mountDraft()
    orchestraStore.startRouting()
    // Restoring a route waits for the snapshot and the draft; a loaded full run needs more than 1 s.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Утвердить как план' })).toBeTruthy(), { timeout: 5000 })
    cleanup()
    mountDraft()
    orchestraStore.startRouting()
    // Restoring a route waits for the snapshot and the draft; a loaded full run needs more than 1 s.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Утвердить как план' })).toBeTruthy(), { timeout: 5000 })
    window.history.replaceState(null, '', '/')
  })

  it('shows drafts under the repository and refreshes them on a snapshot', async () => {
    mountDraft()
    await waitFor(() => expect(screen.getByRole('button', { name: /Новый маршрут/ })).toBeTruthy())
    expect(screen.getByText('Черновики')).toBeTruthy()
    expect(screen.getByText('1 задача')).toBeTruthy()
    const before = calls.filter((call) => call.url.includes('/api/plan-drafts?')).length
    act(() => { FakeEventSource.last?.emit('snapshot', { ...snapshot, generatedAt: '2026-09-23T12:00:00Z' }) })
    await waitFor(() => expect(calls.filter((call) => call.url.includes('/api/plan-drafts?')).length).toBeGreaterThan(before))
  })

  it('shows a blocking finding and disables approval with a reason', async () => {
    const user = userEvent.setup()
    mountDraft([{ code: 'missing_dependency', data: { task: 'schema', dependency: 'absent' } }])
    await user.click(await screen.findByRole('button', { name: /Новый маршрут/ }))
    expect(screen.getByRole('button', { name: 'Утвердить как план' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Устраните препятствия перед утверждением')).toBeTruthy()
    expect(screen.getByText(/schema.*absent/)).toBeTruthy()
    expect(posts('plan-draft-approve')).toHaveLength(0)
  })

  it('approves an advisory draft and switches to the resulting plan', async () => {
    const user = userEvent.setup()
    mountDraft([{ code: 'missing_acceptance', data: { task: 'schema' } }])
    await user.click(await screen.findByRole('button', { name: /Новый маршрут/ }))
    expect(screen.getByText('Сначала схема')).toBeTruthy()
    expect(screen.getByText('spec.md')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Утвердить как план' }))
    await waitFor(() => expect(posts('plan-draft-approve')).toHaveLength(1))
    await waitFor(() => expect(posts('plan-use')).toHaveLength(1))
    expect(posts('plan-use')[0]?.body).toEqual({ repo: ROOT, plan: 'next' })
    act(() => { FakeEventSource.last?.emit('snapshot', makeSnapshot(makeRepo([], [], { planId: 'next', goal: draft.goal, plans: [plan({ id: 'next', goal: draft.goal, current: true })] }))) })
    expect(screen.getByRole('treeitem', { name: draft.goal }).getAttribute('aria-current')).toBe('true')
  })

  it('discards after inline confirmation and removes the row', async () => {
    const user = userEvent.setup()
    mountDraft()
    await user.click(await screen.findByRole('button', { name: /Новый маршрут/ }))
    await user.click(screen.getByRole('button', { name: 'Удалить черновик' }))
    expect(posts('plan-draft-discard')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(posts('plan-draft-discard')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByText('Черновики')).toBeNull())
  })

  it('translates a host 422 inline', async () => {
    const user = userEvent.setup()
    mountDraft([], jsonFail('draft_invalid', 422))
    await user.click(await screen.findByRole('button', { name: /Новый маршрут/ }))
    await user.click(screen.getByRole('button', { name: 'Утвердить как план' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'В черновике есть препятствия. Обновите и проверьте его снова.')
  })
})
