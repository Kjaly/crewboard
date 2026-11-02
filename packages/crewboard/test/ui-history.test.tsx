// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/ui/app.js'
import { fakeApi } from './ui-fixtures.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const openHistory = async (f = fakeApi()) => {
  render(<App api={f.api} />)
  await screen.findByRole('tree')
  await userEvent.click(screen.getByRole('tab', { name: 'История' }))
  return { f, panel: await screen.findByRole('tabpanel', { name: 'История' }) }
}

describe('history tab', () => {
  it('shows the conversation in order with a session divider and assignment cards', async () => {
    const { panel } = await openHistory()
    expect(within(panel).getByText('Хочу кухню полного цикла')).toBeTruthy()
    expect(within(panel).getByText('Раздал работу.')).toBeTruthy()
    const card = within(panel).getByRole('button', { name: /Мобильная панель/ })
    expect(within(card).getByText('Ждёт вас')).toBeTruthy()
    expect(within(panel).getByText('3 действия')).toBeTruthy()
  })

  it('opens the node in the tree from its card', async () => {
    const { panel } = await openHistory()
    await userEvent.click(within(panel).getByRole('button', { name: /Мобильная панель/ }))
    expect(screen.getByRole('tab', { name: 'Сейчас' }).getAttribute('aria-selected')).toBe('true')
    const ctx = screen.getByRole('complementary', { name: 'Контекст поручения' })
    expect(within(ctx).getByRole('heading', { name: 'Мобильная панель' })).toBeTruthy()
  })

  it('shows a card for work no longer in the tree as inactive', async () => {
    const { panel } = await openHistory()
    expect(within(panel).getByRole('button', { name: /Удалённое поручение/ }).getAttribute('aria-disabled')).toBe('true')
  })

  it('says plainly when the full conversation is not available', async () => {
    const f = fakeApi()
    f.state.history = { available: false, truncated: false, items: [] }
    const { panel } = await openHistory(f)
    expect(within(panel).getByText('Полный разговор недоступен: транскрипт Claude Code не найден.')).toBeTruthy()
    expect(within(panel).getByText('Хочу кухню полного цикла')).toBeTruthy()
  })

  it('jumps from a node to its place in the history', async () => {
    const f = fakeApi()
    render(<App api={f.api} />)
    await userEvent.click(await screen.findByRole('treeitem', { name: /Мобильная панель/ }))
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Контекст поручения' })).getByRole('button', { name: 'Открыть в истории' }))
    const panel = await screen.findByRole('tabpanel', { name: 'История' })
    await waitFor(() => expect(within(panel).getByRole('button', { name: /Мобильная панель/ }).hasAttribute('data-focused')).toBe(true))
  })
})

describe('analytics tab', () => {
  it('draws a lane per provider and says «нет данных» where money is unknown', async () => {
    const f = fakeApi()
    f.api.analytics = async () => ({
      from: '2026-11-02T10:00:00Z', to: '2026-11-02T10:30:00Z',
      lanes: [
        { provider: 'codex', bars: [{ assignmentId: 'box', title: 'Модель короба', start: '2026-11-02T10:02:00Z', end: '2026-11-02T10:10:00Z', outcome: 'completed' }] },
        { provider: 'deepseek', bars: [{ assignmentId: 'pdf', title: 'Сборочная инструкция', start: '2026-11-02T10:04:00Z', end: '2026-11-02T10:09:00Z', outcome: 'completed' }] },
      ],
      byProvider: { codex: { runs: 1, runsWithoutData: 0, usd: 0.04, apiUsd: 0.06 }, deepseek: { runs: 1, runsWithoutData: 1 } },
      byAssignment: [],
    })
    render(<App api={f.api} />)
    await screen.findByRole('tree')
    await userEvent.click(screen.getByRole('tab', { name: 'Аналитика' }))
    const panel = await screen.findByRole('tabpanel', { name: 'Аналитика' })
    expect(within(panel).getByRole('region', { name: 'Codex' })).toBeTruthy()
    expect(within(panel).getByRole('region', { name: 'DeepSeek' })).toBeTruthy()
    const costs = within(panel).getByRole('table', { name: 'Затраты по провайдерам' })
    expect(within(costs).getByText('$0.04')).toBeTruthy()
    expect(within(costs).getByText('$0.06')).toBeTruthy()
    expect(within(costs).getAllByText('нет данных').length).toBeGreaterThan(0)
  })
})

describe('history milestones', () => {
  it('shows closing or cancelling work as a line, not as another assignment card', async () => {
    const f = fakeApi()
    f.state.history = { available: true, truncated: false, items: [
      { kind: 'session', ts: '2026-11-02T10:00:00Z', sessionId: 's1' },
      { kind: 'assignment', ts: '2026-11-02T10:03:00Z', tool: 'assign', goalId: 'g', assignmentId: 'ux', title: 'Мобильная панель' },
      { kind: 'assignment', ts: '2026-11-02T10:09:00Z', tool: 'cancel', goalId: 'g', assignmentId: 'ux' },
    ] }
    const { panel } = await openHistory(f)
    expect(within(panel).getAllByRole('button', { name: /Мобильная панель/ }).length).toBe(1)
    expect(within(panel).getByText('Работа отменена: Мобильная панель')).toBeTruthy()
  })
})

describe('history freshness', () => {
  it('re-reads the conversation while the tab is open, even without journal changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { f } = await openHistory()
      const before = f.state.calls.history
      await act(async () => {
        vi.advanceTimersByTime(11_000)
      })
      expect(f.state.calls.history).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
