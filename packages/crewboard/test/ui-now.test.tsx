// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coalesce } from '../src/ui/api.js'
import { App } from '../src/ui/app.js'
import { initialLang, setLang } from '../src/ui/text.js'
import { userEvent } from '@testing-library/user-event'
import { fakeApi, kitchen, node } from './ui-fixtures.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  setLang('ru')
})

describe('coalesce', () => {
  it('folds a burst of live changes into one refresh', () => {
    vi.useFakeTimers()
    const batches: number[][] = []
    const c = coalesce<number>((b) => batches.push(b), 250)
    for (let i = 0; i < 20; i++) {
      c.push(i)
      vi.advanceTimersByTime(5)
    }
    expect(batches).toEqual([])
    vi.advanceTimersByTime(250)
    expect(batches.length).toBe(1)
    expect(batches[0]!.length).toBe(20)
  })
})

describe('Now screen', () => {
  it('shows the goal and what its work is doing in one line', async () => {
    const { api } = fakeApi()
    render(<App api={api} />)
    expect(await screen.findByRole('heading', { name: 'Кухня полного цикла' })).toBeTruthy()
    const summary = screen.getByRole('region', { name: 'Сводка' })
    for (const text of ['1 ждёт вас', '1 ждёт ведущего', '1 идёт', '1 в очереди', '1 завершено']) expect(within(summary).getByText(text)).toBeTruthy()
  })
})

describe('language', () => {
  it('switches the whole screen to English and remembers the choice', async () => {
    const { api } = fakeApi()
    render(<App api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to English' }))
    expect(screen.getByRole('tab', { name: 'Now' })).toBeTruthy()
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('1 waiting for you')).toBeTruthy()
    expect(document.documentElement.lang).toBe('en')
    expect(initialLang()).toBe('en')
  })
})

describe('tree and context', () => {
  const items = () => screen.getAllByRole('treeitem').map((el) => el.getAttribute('data-id'))

  it('puts what waits for you first and folds finished work', async () => {
    const { api } = fakeApi()
    render(<App api={api} />)
    await screen.findByRole('tree')
    expect(items()).toEqual(['g', 'ux', 'box', 'geo', 'pdf'])
    await userEvent.click(screen.getByRole('button', { name: 'Завершено 1' }))
    expect(items()).toContain('hw')
  })

  it('shows where a node came from and what counts as done', async () => {
    const { api } = fakeApi()
    render(<App api={api} />)
    await userEvent.click(await screen.findByRole('treeitem', { name: /Модель короба/ }))
    const panel = screen.getByRole('complementary', { name: 'Контекст поручения' })
    expect(within(panel).getByRole('heading', { name: 'Модель короба' })).toBeTruthy()
    expect(within(panel).getByText('Раздал работу')).toBeTruthy()
    expect(within(panel).getByText('Панели с толщиной')).toBeTruthy()
  })

  it('moves the selection when the selected node disappears', async () => {
    const f = fakeApi()
    render(<App api={f.api} />)
    await userEvent.click(await screen.findByRole('treeitem', { name: /Модель короба/ }))
    const t = kitchen()
    t.children = t.children.filter((c) => c.id !== 'box')
    f.state.tree = t
    act(() => f.emit({ project: '/repo/cabinet', goalId: 'g', seq: 9 }))
    const panel = screen.getByRole('complementary', { name: 'Контекст поручения' })
    await waitFor(() => expect(within(panel).getByRole('heading', { name: 'Мобильная панель' })).toBeTruthy(), { timeout: 2000 })
  })

  it('falls back to the root when nothing waits for you', async () => {
    const t = node('g', 'running', { parentId: null, title: 'Кухня полного цикла', provider: 'lead', resultKind: 'goal' }, [node('box', 'running', { title: 'Модель короба' })])
    const { api } = fakeApi({ tree: t })
    render(<App api={api} />)
    const panel = await screen.findByRole('complementary', { name: 'Контекст поручения' })
    expect(within(panel).getByRole('heading', { name: 'Кухня полного цикла' })).toBeTruthy()
  })

  it('explains how to connect Claude Code when there are no goals', async () => {
    const { api } = fakeApi({ projects: [] })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<App api={api} />)
    expect(await screen.findByRole('heading', { name: 'Подключите Claude Code' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Скопировать' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^claude mcp add --transport http crewboard http:\/\/.+\/mcp$/))
  })
})

describe('answering and the connection', () => {
  const escalation = (): Record<string, import('../src/model/types.js').GoalEvent[]> => ({
    ux: [
      { seq: 1, ts: '2026-11-02T10:12:00Z', goalId: 'g', assignmentId: 'ux', actor: 'lead', type: 'assigned', parentId: 'g', title: 'Мобильная панель', criteria: [], resultKind: 'local', provider: 'claude', after: [] },
      { seq: 2, ts: '2026-11-02T10:58:00Z', goalId: 'g', assignmentId: 'ux', actor: 'worker', type: 'question', text: 'Шторка или слой?', options: ['Шторка снизу', 'Полноэкранный слой'] },
      { seq: 3, ts: '2026-11-02T10:59:00Z', goalId: 'g', assignmentId: 'ux', actor: 'lead', type: 'escalated', text: 'Шторка или слой?', options: ['Шторка снизу', 'Полноэкранный слой'], why: 'Это вопрос вашего вкуса' },
    ],
  })

  it('sends an option once, even on a double click', async () => {
    const f = fakeApi({ events: escalation() })
    render(<App api={f.api} />)
    const option = await screen.findByRole('button', { name: 'Шторка снизу' })
    await userEvent.dblClick(option)
    await waitFor(() => expect(f.state.answers).toEqual(['Шторка снизу']))
  })

  it('keeps the answered node selected after the tree moves on', async () => {
    const f = fakeApi({ events: escalation() })
    render(<App api={f.api} />)
    const option = await screen.findByRole('button', { name: 'Шторка снизу' })
    const t = kitchen()
    t.children = t.children.map((c) => (c.id === 'ux' ? { ...c, status: 'running' } : c))
    f.state.tree = t
    await userEvent.click(option)
    const panel = screen.getByRole('complementary', { name: 'Контекст поручения' })
    await waitFor(() => expect(within(panel).getByRole('heading', { name: 'Мобильная панель' })).toBeTruthy())
    await waitFor(() => expect(f.state.calls.goal).toBeGreaterThan(1))
    expect(within(panel).getByRole('heading', { name: 'Мобильная панель' })).toBeTruthy()
  })

  it('sends a typed answer and keeps the button off while the field is empty', async () => {
    const f = fakeApi({ events: escalation() })
    render(<App api={f.api} />)
    const send = await screen.findByRole('button', { name: 'Ответить' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByRole('textbox', { name: 'Свой ответ' }), 'Шторка, но выше')
    await userEvent.click(send)
    await waitFor(() => expect(f.state.answers).toEqual(['Шторка, но выше']))
  })

  it('refreshes instead of showing an error when the answer was already taken', async () => {
    const f = fakeApi({ events: escalation() })
    f.state.answerResult = 'conflict'
    render(<App api={f.api} />)
    const before = f.state.calls.goal
    await userEvent.click(await screen.findByRole('button', { name: 'Шторка снизу' }))
    await waitFor(() => expect(f.state.calls.goal).toBeGreaterThan(before))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens what waits for you from the summary and from the header', async () => {
    const t = kitchen()
    const f = fakeApi({ tree: t })
    render(<App api={f.api} />)
    await userEvent.click(await screen.findByRole('treeitem', { name: /Модель короба/ }))
    const panel = screen.getByRole('complementary', { name: 'Контекст поручения' })
    await userEvent.click(within(screen.getByRole('region', { name: 'Сводка' })).getByRole('button', { name: '1 ждёт вас' }))
    expect(within(panel).getByRole('heading', { name: 'Мобильная панель' })).toBeTruthy()
    await userEvent.click(screen.getByRole('treeitem', { name: /Модель короба/ }))
    await userEvent.click(screen.getByRole('button', { name: /Ждёт вас/ }))
    expect(within(panel).getByRole('heading', { name: 'Мобильная панель' })).toBeTruthy()
  })

  it('says when the server is gone and reloads when it is back', async () => {
    const f = fakeApi()
    render(<App api={f.api} />)
    await screen.findByRole('tree')
    act(() => f.online(false))
    expect(screen.getByRole('alert').textContent).toContain('Нет связи с сервером')
    const before = { ...f.state.calls }
    act(() => f.online(true))
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => {
      expect(f.state.calls.projects).toBeGreaterThan(before.projects)
      expect(f.state.calls.goal).toBeGreaterThan(before.goal)
    })
  })
})

describe('review fixes', () => {
  const escalationFor = (): Record<string, import('../src/model/types.js').GoalEvent[]> => ({
    ux: [{ seq: 3, ts: '2026-11-02T10:59:00Z', goalId: 'g', assignmentId: 'ux', actor: 'lead', type: 'escalated', text: 'Шторка или слой?', options: ['Шторка снизу'], why: 'вкус' }],
  })

  it('tells the owner when an answer did not go through and keeps the text', async () => {
    const f = fakeApi({ events: escalationFor() })
    f.state.answerResult = 'fail'
    render(<App api={f.api} />)
    const field = await screen.findByRole('textbox', { name: 'Свой ответ' })
    await userEvent.type(field, 'Шторка, но выше')
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }))
    expect(await screen.findByText('Ответ не отправлен. Проверьте связь и попробуйте ещё раз.')).toBeTruthy()
    expect((field as HTMLInputElement).value).toBe('Шторка, но выше')
  })

  it('keeps a closed mobile sheet out of reach of the keyboard', async () => {
    const mql = { matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }
    vi.stubGlobal('matchMedia', () => mql)
    const { api } = fakeApi()
    render(<App api={api} />)
    const panel = await screen.findByRole('complementary', { name: 'Контекст поручения', hidden: true })
    expect(panel.hasAttribute('inert')).toBe(true)
    await userEvent.click(screen.getByRole('treeitem', { name: /Модель короба/ }))
    expect(panel.hasAttribute('inert')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('moves through the tree with arrows only while the tree has focus', async () => {
    const { api } = fakeApi()
    render(<App api={api} />)
    const ux = await screen.findByRole('treeitem', { name: /Мобильная панель/ })
    expect(ux.getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{ArrowDown}')
    expect(ux.getAttribute('aria-selected')).toBe('true')
    ux.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('treeitem', { name: /Модель короба/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0).length).toBe(1)
  })

  it('never shows a slow tree of the goal you just left', async () => {
    const other = node('g2', 'running', { parentId: null, title: 'Шкаф', provider: 'lead', resultKind: 'goal' })
    const f = fakeApi({
      projects: [{ repo: '/repo/cabinet', name: 'cabinet', goals: [
        { goalId: 'g', title: 'Кухня полного цикла', createdAt: '2026-11-02T10:00:00Z', status: 'running', leadOnline: true, counts: { waiting_owner: 1, running: 1, queued: 0, finished: 0 } },
        { goalId: 'g2', title: 'Шкаф', createdAt: '2026-11-01T10:00:00Z', status: 'running', leadOnline: true, counts: { waiting_owner: 0, running: 0, queued: 0, finished: 0 } },
      ] }],
    })
    f.state.trees.g2 = other
    render(<App api={f.api} />)
    await screen.findByRole('heading', { name: 'Кухня полного цикла' })
    f.state.delays.g = 300
    act(() => f.emit({ project: '/repo/cabinet', goalId: 'g', seq: 5 }))
    await new Promise((r) => setTimeout(r, 300))
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Проекты и цели' })).getByRole('button', { name: /Шкаф/ }))
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Шкаф')
  })

  it('disables the header button while nothing waits for you', async () => {
    const t = node('g', 'running', { parentId: null, title: 'Кухня полного цикла', provider: 'lead', resultKind: 'goal' })
    const f = fakeApi({ tree: t })
    f.state.projects[0]!.goals[0]!.counts.waiting_owner = 0
    render(<App api={f.api} />)
    await screen.findByRole('tree')
    expect((screen.getByRole('button', { name: /Ждёт вас/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('actions in the tree', () => {
  const open = async (name: RegExp, init: Parameters<typeof fakeApi>[0] = {}) => {
    const f = fakeApi(init)
    render(<App api={f.api} />)
    await userEvent.click(await screen.findByRole('treeitem', { name }))
    return { f, panel: screen.getByRole('complementary', { name: 'Контекст поручения' }) }
  }

  it('offers what fits the status', async () => {
    const { panel } = await open(/Модель короба/)
    for (const name of ['Уточнить', 'Остановить', 'Передать', 'Обсудить с ведущим']) expect(within(panel).getByRole('button', { name })).toBeTruthy()
    await userEvent.click(screen.getByRole('treeitem', { name: /Сборочная инструкция/ }))
    for (const name of ['Начать раньше', 'Отменить']) expect(within(panel).getByRole('button', { name })).toBeTruthy()
  })

  it('asks to stop once, even on a double click', async () => {
    const { f, panel } = await open(/Модель короба/)
    await userEvent.dblClick(within(panel).getByRole('button', { name: 'Остановить' }))
    await waitFor(() => expect(f.state.requests).toEqual([{ id: 'box', action: 'stop' }]))
  })

  it('hands work to the chosen provider', async () => {
    const { f, panel } = await open(/Модель короба/)
    await userEvent.click(within(panel).getByRole('button', { name: 'Передать' }))
    await userEvent.click(within(panel).getByRole('button', { name: 'Claude' }))
    await waitFor(() => expect(f.state.requests).toEqual([{ id: 'box', action: 'handoff', provider: 'claude' }]))
  })

  it('shows a waiting request and leaves only discussion', async () => {
    const t = kitchen()
    t.children[1] = { ...t.children[1]!, request: { id: 'r1', action: 'stop', state: 'pending' } }
    const { panel } = await open(/Модель короба/, { tree: t })
    expect(within(panel).getByText('Запрошено: остановить. Ведущий решает')).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: 'Остановить' })).toBeNull()
    expect(within(panel).getByRole('button', { name: 'Обсудить с ведущим' })).toBeTruthy()
  })

  it('shows why the lead declined', async () => {
    const t = kitchen()
    t.children[1] = { ...t.children[1]!, request: { id: 'r1', action: 'stop', state: 'declined', reason: 'Нужна для инструкции' } }
    const { panel } = await open(/Модель короба/, { tree: t })
    expect(within(panel).getByText('Ведущий против: Нужна для инструкции')).toBeTruthy()
  })

  it('offers an emergency stop only while the lead is away', async () => {
    const f0 = fakeApi()
    f0.state.projects[0]!.goals[0]!.leadOnline = false
    render(<App api={f0.api} />)
    await userEvent.click(await screen.findByRole('treeitem', { name: /Модель короба/ }))
    const panel = screen.getByRole('complementary', { name: 'Контекст поручения' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Аварийная остановка' }))
    expect(f0.state.stops).toEqual([])
    await userEvent.click(within(panel).getByRole('button', { name: 'Точно остановить сейчас' }))
    await waitFor(() => expect(f0.state.stops).toEqual(['box']))
  })

  it('asks to stop the selected node with S while the tree has focus', async () => {
    const { f } = await open(/Модель короба/)
    const row = screen.getByRole('treeitem', { name: /Модель короба/ })
    row.focus()
    fireEvent.keyDown(row, { key: 'ы', code: 'KeyS' })
    await waitFor(() => expect(f.state.requests).toEqual([{ id: 'box', action: 'stop' }]))
  })
})

describe('sidebar', () => {
  const twoProjects = () =>
    fakeApi({
      projects: [
        { repo: '/repo/cabinet', name: 'cabinet', goals: [
          { goalId: 'g', title: 'Кухня полного цикла', createdAt: '2026-11-02T10:00:00Z', status: 'running', leadOnline: true, counts: { waiting_owner: 1, running: 2, queued: 1, finished: 1 } },
          { goalId: 'g2', title: 'Шкаф', createdAt: '2026-11-01T10:00:00Z', status: 'running', leadOnline: true, counts: { waiting_owner: 0, running: 1, queued: 0, finished: 3 } },
        ] },
        { repo: '/repo/newsroom', name: 'newsroom', goals: [
          { goalId: 'n1', title: 'Лента новостей', createdAt: '2026-10-30T10:00:00Z', status: 'running', leadOnline: false, counts: { waiting_owner: 2, running: 0, queued: 0, finished: 0 } },
        ] },
      ],
    })

  it('lists every project with its goals and what waits in each', async () => {
    const { api } = twoProjects()
    render(<App api={api} />)
    const nav = await screen.findByRole('navigation', { name: 'Проекты и цели' })
    expect(within(nav).getByText('cabinet')).toBeTruthy()
    expect(within(nav).getByText('newsroom')).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /Лента новостей.*2 ждут вас/ })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /Кухня полного цикла/ }).getAttribute('aria-current')).toBe('page')
  })

  it('switches to the goal you pick', async () => {
    const f = twoProjects()
    f.state.trees.n1 = node('n1', 'running', { parentId: null, title: 'Лента новостей', provider: 'lead', resultKind: 'goal' })
    render(<App api={f.api} />)
    const nav = await screen.findByRole('navigation', { name: 'Проекты и цели' })
    await userEvent.click(within(nav).getByRole('button', { name: /Лента новостей/ }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Лента новостей'))
  })
})

describe('lead presence', () => {
  it('re-reads presence on a timer, not only on journal changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const f = fakeApi()
    render(<App api={f.api} />)
    await screen.findByRole('tree')
    const before = f.state.calls.projects
    await act(async () => {
      vi.advanceTimersByTime(31_000)
    })
    expect(f.state.calls.projects).toBeGreaterThan(before)
  })
})
