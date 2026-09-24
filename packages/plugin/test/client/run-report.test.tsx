// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { TaskDetail } from '../../src/shared/types.js'
import { App } from '../../src/client/app.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import {
  FakeEventSource,
  installEventSource,
  installFetch,
  installMatchMedia,
  jsonOk,
  makeDetail,
  makeRepo,
  makeSnapshot,
  makeTask,
} from './helpers.js'

function mountPanel(detail: TaskDetail, task = makeTask({ id: 'a', status: 'in_review', runs: 1, lastRunId: 'run-1' })) {
  installFetch((url) => (url.includes('/api/task') ? jsonOk(detail) : jsonOk(null)))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  return screen.findByRole('region', { name: 'Итог работы' })
}

const report = (patch: Partial<NonNullable<TaskDetail['report']>> = {}) => ({
  runId: 'run-1',
  text: '- Сделано **первое**\n- Сделано `второе`',
  source: 'section' as const,
  truncated: false,
  ...patch,
})

afterEach(() => cleanup())
beforeEach(() => {
    localStorage.clear()
  resetOrchestraStore()
})

it('shows the report card with a list for an in_review task and never trusts HTML in the text', async () => {
  setLang('ru')
  const detail = makeDetail({
    id: 'a',
    status: 'in_review',
    report: report({ text: 'Что сделано:\n- пункт **один**\n- `код` два\n- <img src=x onerror=1>' }),
  })
  const card = await mountPanel(detail)

  const items = within(card).getAllByRole('listitem')
  expect(items).toHaveLength(3)
  expect(items[0]?.querySelector('strong')?.textContent).toBe('один')
  expect(items[1]?.querySelector('code')?.textContent).toBe('код')
  // Raw markup from the worker renders as text, never as an element.
  expect(card.querySelector('img')).toBeNull()
  expect(items[2]?.textContent).toBe('<img src=x onerror=1>')
})

it('marks a report without an «Отчёт» section as the start of the answer', async () => {
  setLang('ru')
  const detail = makeDetail({ id: 'a', status: 'in_review', report: report({ source: 'final' }) })
  const card = await mountPanel(detail)
  expect(within(card).getByText('Воркер не написал раздел «Отчёт» — показано начало его ответа')).toBeTruthy()
})

it('shows file count once in the verdict facts and keeps changes in its tab', async () => {
  setLang('ru')
  const user = userEvent.setup()
  const detail = makeDetail({ id: 'a', status: 'in_review', changedFiles: ['a.ts', 'b.ts', 'c.ts'], verdict: { kind: 'result', facts: [{ code: 'files_changed', count: 3, tone: 'ok' }] }, report: report() })
  const card = await mountPanel(detail)
  expect(within(card).queryByText(/3 files changed|изменено файлов: 3/)).toBeNull()
  const panel = screen.getByRole('complementary', { name: 'Задача: Задача a' })
  expect(within(panel).getAllByText('изменено файлов: 3')).toHaveLength(1)
  await user.click(within(panel).getByRole('tab', { name: 'Изменения · 3' }))
  expect(within(panel).getByRole('tab', { name: 'Изменения · 3' }).getAttribute('aria-selected')).toBe('true')
})

it('a queue row carries the first line of the report under the title', async () => {
  setLang('ru')
  installMatchMedia(false)
  installEventSource()
  const snapshot = makeSnapshot(
    makeRepo([makeTask({ id: 'a', title: 'Готова к приёмке', status: 'in_review', worker: 'dsh', runs: 1, lastRunId: 'run-1' })]),
  )
  installFetch((url) => {
    if (url.includes('/api/task')) {
      return jsonOk(
        makeDetail({ id: 'a', status: 'in_review', report: report({ text: '- Первая строка отчёта\n- вторая' }) }),
      )
    }
    return jsonOk(url.includes('/api/cost') ? { generatedAt: '', runs: [], totals: {}, accepted: [] } : snapshot)
  })
  render(<App />)
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', snapshot)
  })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Ждут вас/ }))
  const queue = screen.getByRole('complementary', { name: 'Очередь приёмки' })
  const row = within(queue).getByText('Готова к приёмке').closest('li')!
  expect(await within(row).findByText('Первая строка отчёта')).toBeTruthy()
})
