// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { Attention } from '../../src/shared/types.js'
import { BoardView } from '../../src/client/views/board.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())

const stalled: Attention = { kind: 'stalled', severity: 'alert', taskId: 'stuck', runId: 'run_dsh-1', message: 'тишина 9 мин', hint: 'проверьте тест' }

const repo = makeRepo(
  [
    makeTask({ id: 'go', title: 'Можно стартовать', status: 'ready' }),
    makeTask({ id: 'work', title: 'В работе', status: 'running', worker: 'dsh', activeSince: '2026-09-22T11:55:00Z' }),
    makeTask({ id: 'stuck', title: 'Завис воркер', status: 'running', worker: 'devin' }),
    makeTask({ id: 'check', title: 'Ждёт приёмки', status: 'in_review' }),
    makeTask({ id: 'wait', title: 'Ждёт зависимость', status: 'blocked', deps: ['go'], blockedBy: ['go'] }),
    makeTask({ id: 'draft', title: 'Черновик задачи', status: 'backlog' }),
    makeTask({ id: 'done', title: 'Уже принята', status: 'accepted' }),
  ],
  [stalled],
)

const column = (name: RegExp) => within(screen.getByRole('region', { name }))

it('puts tasks in the column matching their status and attention', () => {
  setLang('ru')
  render(<BoardView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(column(/^Требует внимания/).getByRole('button', { name: /Завис воркер/ })).toBeTruthy()
  expect(column(/^Требует внимания/).getByText(/тишина 9 мин/)).toBeTruthy()
  expect(column(/^Можно запускать/).getByRole('button', { name: /Можно стартовать/ })).toBeTruthy()
  expect(column(/^Идёт/).getByRole('button', { name: /В работе/ })).toBeTruthy()
  expect(column(/^Идёт/).queryByRole('button', { name: /Завис воркер/ })).toBeNull()
  expect(column(/^Ждёт приёмки/).getByRole('button', { name: /Ждёт приёмки/ })).toBeTruthy()
  expect(column(/^Ждёт: /).getByRole('button', { name: /Ждёт зависимость/ })).toBeTruthy()
  expect(column(/^Бэклог/).getByRole('button', { name: /Черновик задачи/ })).toBeTruthy()
})

it('shows a short accepted column in place, muted, without a fold', () => {
  setLang('ru')
  render(<BoardView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(column(/^Приняты/).getByRole('button', { name: /Уже принята/ })).toBeTruthy()
  expect(column(/^Приняты/).queryByRole('button', { name: /Показать все/ })).toBeNull()
})

it('the lens dims every non-matching card in place and keeps the counts whole', () => {
  setLang('ru')
  const { container } = render(<BoardView repo={repo} selectedId={null} onSelect={() => {}} density="overview" lens="ready" />)
  // Nothing is filtered out: all seven cards stay where they were, six of them step back.
  expect(column(/^Можно запускать/).getByRole('button', { name: /Можно стартовать/ })).toBeTruthy()
  expect(column(/^Бэклог/).getByRole('button', { name: /Черновик задачи/ })).toBeTruthy()
  expect(container.querySelectorAll('.orc-lens-dim')).toHaveLength(6)
  expect(screen.getByRole('region', { name: 'Идёт: 1' })).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Требует внимания: 1' })).toBeTruthy()
})

it('selects a task on click', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<BoardView repo={repo} selectedId="go" onSelect={onSelect} density="detail" />)
  await user.click(screen.getByRole('button', { name: /В работе/ }))
  expect(onSelect).toHaveBeenCalledWith('work')
  expect(screen.getByRole('button', { name: /Можно стартовать/ }).getAttribute('aria-pressed')).toBe('true')
})

it('shows the same provider mark and model on a card', () => {
  setLang('ru')
  render(<BoardView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  const card = column(/^Идёт/).getByRole('button', { name: /В работе/ })
  expect(card.querySelector('.orc-card__identity')?.textContent).toBe('DSDeepSeek V4 Flash')
})
