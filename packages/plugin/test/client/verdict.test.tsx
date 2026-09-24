// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskDetail } from '../../src/shared/types.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { BoardView } from '../../src/client/views/board.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installFetch, installMatchMedia, jsonOk, makeDetail, makeRepo, makeTask, type FetchCall } from './helpers.js'
import { setLang } from '../../src/client/i18n.js'
import { ensureStyles } from '../../src/client/styles.js'

afterEach(cleanup)
beforeEach(() => setLang('ru'))

function panel(detail: TaskDetail) {
  const task = makeTask({ id: 'a', status: 'in_review' })
  const calls = installFetch((url) => url.includes('/api/task') ? jsonOk(detail) : jsonOk(null))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  return calls
}

it.each([
  ['result', 'Результат получен'],
  ['negative', 'Отрицательный результат'],
  ['disputed', 'Спорно'],
] as const)('shows the %s verdict supplied by core', async (kind, label) => {
  panel(makeDetail({ id: 'a', verdict: { kind, why: 'negative', mismatch: 'no_files', facts: [{ code: 'files_changed', count: 2, tone: 'ok' }] } }))
  const band = await screen.findByRole('status')
  expect(band.textContent).toContain(label)
  expect(band.querySelector('.orc-verdict__mark')?.getAttribute('aria-hidden')).toBe('true')
  expect(band.querySelector('.orc-verdict__mark')?.textContent).toBe(kind === 'result' ? '✓' : kind === 'negative' ? '−' : '?')
  expect(band.querySelector('strong')?.textContent).toBe(label)
  expect(screen.getAllByText('изменено файлов: 2')).toHaveLength(1)
  expect(screen.getByText('изменено файлов: 2').classList.contains('orc-verdict__fact--ok')).toBe(true)
  if (kind === 'negative') expect(band.textContent).toContain('получен отрицательный результат')
  if (kind === 'disputed') expect(band.textContent).toContain('Заявлен результат, но изменённых файлов нет.')
})

it('localizes the same file count in the acceptance panel', async () => {
  const detail = makeDetail({ id: 'a', verdict: { kind: 'result', facts: [{ code: 'files_changed', count: 2, tone: 'ok' }] } })
  setLang('ru')
  panel(detail)
  await screen.findByRole('status')
  expect(screen.getByText('изменено файлов: 2')).toBeTruthy()
  cleanup()
  setLang('en')
  panel(detail)
  await screen.findByRole('status')
  expect(screen.getByText('2 files changed')).toBeTruthy()
})

it('localizes the claim gap and check status in both languages', async () => {
  const detail = makeDetail({ id: 'a', verdict: { kind: 'disputed', mismatch: 'claim_missing', facts: [
    { code: 'checks_run', count: 1, tone: 'ok' }, { code: 'checks_unreported', count: 2, tone: 'flat' },
  ] } })
  setLang('ru')
  panel(detail)
  await screen.findByRole('status')
  expect(screen.getByText(/В отчёте нет явного заявления о результате/)).toBeTruthy()
  expect(screen.getByText('по отчёту запущена проверка контракта: 1')).toBeTruthy()
  expect(screen.getByText('проверки контракта не упомянуты: 2')).toBeTruthy()
  cleanup()
  setLang('en')
  panel(detail)
  await screen.findByRole('status')
  expect(screen.getByText(/The report makes no explicit result claim/)).toBeTruthy()
  expect(screen.getByText('1 contract check reported as run')).toBeTruthy()
  expect(screen.getByText('2 contract checks not reported')).toBeTruthy()
})

it('keeps ordinary fact chips neutral in the shipped CSS', () => {
  ensureStyles()
  const css = document.querySelector('style[data-orchestra]')?.textContent ?? ''
  expect(css).not.toMatch(/\.orc-verdict__fact--ok\s*\{[^}]*color:/)
  expect(css).toMatch(/\.orc-verdict__fact--warn\{color:var\(--orc-warn\)/)
  expect(css).not.toMatch(/\.orc-verdict--result\s*\{[^}]*color:/)
})

// The chip printed its label and then a link with the same words, one drawn over the other
// (owner's screenshot, 2026-09-23). A fact that points at the report is a link and nothing else.
it('says a pointing fact once', async () => {
  const report = { runId: 'r', text: 'Результат: получен\nПроверки прошли', source: 'section' as const, truncated: false }
  const task = makeTask({ id: 'a', status: 'accepted' })
  const detail = makeDetail({ id: 'a', status: 'accepted', report, verdict: { kind: 'result', facts: [{ code: 'tests', tone: 'ok', sourceLine: 1 }] } })
  installFetch((url) => url.includes('/api/task') ? jsonOk(detail) : jsonOk(null))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  const facts = await screen.findByLabelText('Факты работы')
  expect(within(facts).getAllByText(/Проверки в отчёте/)).toHaveLength(1)
  expect(within(facts).getAllByRole('button')).toHaveLength(1)
})

it('links a long fact to its report line, opens a folded report, and marks that line', async () => {
  const long = 'Проверки: завершена подробная проверка всех сценариев сборки и приёмки без ошибок'
  const report = { runId: 'r', text: `Результат: получен\nКратко\nЕщё строка\n${long}`, source: 'section' as const, truncated: false }
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  const task = makeTask({ id: 'a', status: 'accepted' })
  const detail = makeDetail({ id: 'a', status: 'accepted', report, verdict: { kind: 'result', facts: [{ code: 'tests', tone: 'ok', sourceLine: 3 }] } })
  installFetch((url) => url.includes('/api/task') ? jsonOk(detail) : jsonOk(null))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  const link = await screen.findByRole('button', { name: /Проверки в отчёте/ })
  expect(link.textContent).not.toContain(long)
  const region = screen.getByRole('region', { name: 'Итог работы' })
  expect(within(region).getByRole('button', { name: 'Итог работы' }).getAttribute('aria-expanded')).toBe('false')
  await userEvent.setup().click(link)
  await waitFor(() => expect(within(region).getByRole('button', { name: 'Итог работы' }).getAttribute('aria-expanded')).toBe('true'))
  const line = within(region).getByText(long)
  expect(line.classList.contains('orc-report__pointer')).toBe(true)
  expect(scroll).toHaveBeenCalled()
})

it('jumps without scrolling animation under reduced motion', async () => {
  installMatchMedia(true)
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  const task = makeTask({ id: 'a', status: 'in_review' })
  const detail = makeDetail({ id: 'a', report: { runId: 'r', text: 'Результат: получен\nПроверки: подробный отчёт о выполненных шагах', source: 'section', truncated: false }, verdict: { kind: 'result', facts: [{ code: 'tests', tone: 'ok', sourceLine: 1 }] } })
  installFetch((url) => url.includes('/api/task') ? jsonOk(detail) : jsonOk(null))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  await userEvent.setup().click(await screen.findByRole('button', { name: /Проверки в отчёте/ }))
  await waitFor(() => expect(scroll).toHaveBeenCalledWith({ behavior: 'instant', block: 'center' }))
  expect(screen.getByText('Проверки: подробный отчёт о выполненных шагах').classList.contains('orc-report__pointer')).toBe(true)
})

it('keeps two acceptance actions and sends negative acceptance to the native-confirmed route', async () => {
  const calls = panel(makeDetail({ id: 'a', verdict: { kind: 'negative', why: 'negative', facts: [] } }))
  await screen.findByRole('status')
  const actions = screen.getByRole('complementary').querySelector('.orc-sec--actions > .orc-actions')!
  expect(within(actions as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['Принять', 'Вернуть…'])
  await userEvent.setup().click(within(actions as HTMLElement).getByRole('button', { name: 'Принять' }))
  await waitFor(() => expect(calls.filter((call: FetchCall) => call.method === 'POST' && call.url.includes('/api/accept'))).toHaveLength(1))
})

it('highlights lexical risk lines without changing the worker text', async () => {
  const text = '- Готово\n- Не удалось проверить\n- Всё собрано'
  panel(makeDetail({ id: 'a', status: 'in_review', report: { runId: 'r', text, source: 'section', truncated: false } }))
  const report = await screen.findByRole('region', { name: 'Итог работы' })
  expect(within(report).getByText('Подсвечены строки со словами риска')).toBeTruthy()
  expect(report.querySelectorAll('.orc-report__risk')).toHaveLength(1)
  expect(report.querySelector('.orc-report__risk')?.textContent).toBe('Не удалось проверить')
  expect([...report.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Готово', 'Не удалось проверить', 'Всё собрано'])
})

it('marks a dependent on board and graph when its predecessor closed without a result', async () => {
  const repo = makeRepo([
    makeTask({ id: 'a', title: 'Предшественник', status: 'accepted', closed: 'negative' }),
    makeTask({ id: 'b', title: 'Зависимая', status: 'ready', deps: ['a'] }),
  ])
  render(<BoardView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  const prior = within(screen.getByRole('region', { name: /^Приняты/ })).getByRole('button', { name: /Предшественник/ })
  expect(prior.textContent).toContain('закрыта: результата нет')
  expect(screen.getByRole('button', { name: /Зависимая/ }).textContent).toContain('Предшественник закрыт без результата')
  cleanup()
  installMatchMedia(false)
  render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  expect((await screen.findByRole('button', { name: /Предшественник/ })).getAttribute('aria-label')).toContain('закрыта: результата нет')
  expect((await screen.findByRole('button', { name: /Зависимая/ })).getAttribute('aria-label')).toContain('предшественник закрыт без результата')
})
