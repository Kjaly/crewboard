// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { BoardView } from '../../src/client/views/board.js'
import { ConsoleView } from '../../src/client/views/console.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())

it('board: a long «Приняты» column shows the last six and folds the rest behind «Показать все»', async () => {
  setLang('ru')
  const user = userEvent.setup()
  const repo = makeRepo([
    makeTask({ id: 'go', title: 'Живая задача', status: 'ready' }),
    ...Array.from({ length: 24 }, (_, i) => makeTask({ id: `a${i}`, title: `Принятая задача ${i}`, status: 'accepted' })),
  ])
  render(<BoardView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)

  const col = within(screen.getByRole('region', { name: 'Приняты: 24' }))
  expect(col.getAllByRole('button', { name: /Принятая задача/ })).toHaveLength(6)
  // The archive keeps the tail: the most recent card is visible, the oldest is folded away.
  expect(col.getByRole('button', { name: /Принятая задача 23/ })).toBeTruthy()
  expect(col.queryByRole('button', { name: /Принятая задача 0\b/ })).toBeNull()

  await user.click(col.getByRole('button', { name: 'Показать все 24' }))
  expect(col.getAllByRole('button', { name: /Принятая задача/ })).toHaveLength(24)

  await user.click(col.getByRole('button', { name: 'Свернуть' }))
  expect(col.getAllByRole('button', { name: /Принятая задача/ })).toHaveLength(6)
})

it('console: an empty plan gets one calm line instead of three hollow blocks', () => {
  setLang('ru')
  render(<ConsoleView repo={makeRepo([])} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(screen.getByText(/ещё нет задач/)).toBeTruthy()
  expect(screen.queryByRole('region')).toBeNull()
})

it('console: a settled plan shows accepted work with no dependents for human review', () => {
  setLang('ru')
  const repo = makeRepo([makeTask({ id: 'done', title: 'Уже принята', status: 'accepted' })])
  render(<ConsoleView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(screen.getByRole('region', { name: 'Принято, но никуда не ведёт: 1' })).toBeTruthy()
})

it('console: a live plan splits attention left and work right, totals closing the grid', () => {
  setLang('ru')
  const repo = makeRepo(
    [
      makeTask({ id: 'stuck', title: 'Завис воркер', status: 'running' }),
      makeTask({ id: 'work', title: 'В работе', status: 'running' }),
      makeTask({ id: 'go', title: 'Можно стартовать', status: 'ready' }),
    ],
    [{ kind: 'stalled', severity: 'alert', taskId: 'stuck', runId: 'run_dsh-1', message: 'тишина 9 мин' }],
    { criticalPath: ['go'] },
  )
  const { container } = render(<ConsoleView repo={repo} selectedId={null} onSelect={() => {}} density="detail" />)
  const cols = container.querySelectorAll('.orc-console > .orc-console__col')
  expect(cols).toHaveLength(2)
  expect(within(cols[0] as HTMLElement).getByRole('region', { name: /^Требует внимания/ })).toBeTruthy()
  expect(within(cols[1] as HTMLElement).getByRole('region', { name: /^Идут/ })).toBeTruthy()
  expect(within(cols[1] as HTMLElement).getByRole('region', { name: /^Можно запускать/ })).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Итоги плана' })).getByText('go')).toBeTruthy()
})

it('console: the lens dims non-matching rows in place, counts intact', () => {
  setLang('ru')
  const repo = makeRepo(
    [
      makeTask({ id: 'stuck', title: 'Завис воркер', status: 'running' }),
      makeTask({ id: 'work', title: 'В работе', status: 'running' }),
      makeTask({ id: 'go', title: 'Можно стартовать', status: 'ready' }),
    ],
    [{ kind: 'stalled', severity: 'alert', taskId: 'stuck', runId: 'run_dsh-1', message: 'тишина 9 мин' }],
  )
  const { container } = render(<ConsoleView repo={repo} selectedId={null} onSelect={() => {}} density="overview" lens="ready" />)
  // «stuck» appears twice (attention + «Идут»): four rows, only the ready one stays bright.
  expect(container.querySelectorAll('.orc-row')).toHaveLength(4)
  expect(container.querySelectorAll('.orc-row.orc-lens-dim')).toHaveLength(3)
  expect(screen.getByRole('region', { name: 'Идут: 2' })).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Требует внимания: 1' })).toBeTruthy()
})
