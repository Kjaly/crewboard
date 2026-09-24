// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { FeedTab, groupEvents, NotesTab, RunsTab } from '../../src/client/panel/tabs.js'
import { makeDetail } from './helpers.js'

beforeEach(() => setLang('ru'))
afterEach(() => cleanup())

it('groups only consecutive commands and edits, preserving the first timestamp', async () => {
  const events = [
    { ts: '2026-09-22T12:00:00Z', kind: 'action' as const, text: 'pnpm test' },
    { ts: '2026-09-22T12:01:00Z', kind: 'action' as const, text: 'pnpm build' },
    { ts: '2026-09-22T12:02:00Z', kind: 'message' as const, text: 'Тесты прошли.' },
    { ts: '2026-09-22T12:03:00Z', kind: 'file' as const, text: 'panel.tsx' },
    { ts: '2026-09-22T12:04:00Z', kind: 'file' as const, text: 'styles.ts' },
    { ts: '2026-09-22T12:05:00Z', kind: 'steer' as const, text: 'Проверь размеры' },
  ]
  expect(groupEvents(events).map((g) => [g.kind, g.ts, g.events.length])).toEqual([
    ['action', events[0]?.ts, 2], ['message', events[2]?.ts, 1], ['file', events[3]?.ts, 2], ['steer', events[5]?.ts, 1],
  ])
  const { container } = render(<FeedTab detail={makeDetail({ id: 'a', events })} />)
  expect(container.querySelectorAll('time')).toHaveLength(4)
  expect(screen.getByText('2 команды')).toBeTruthy()
  expect(screen.getByText('2 правки')).toBeTruthy()
  expect(screen.getByText('Тесты прошли.')).toBeTruthy()
  expect(screen.getByText(/Ваша поправка/).parentElement?.textContent).toContain('Проверь размеры')
  await userEvent.setup().click(screen.getByText('2 команды'))
  expect(screen.getByText('pnpm build')).toBeTruthy()
})

it('keeps human notes out of runs', () => {
  const detail = makeDetail({ id: 'a', notes: [{ at: '2026-09-22T12:00:00Z', type: 'steer', text: 'Сначала тесты' }] })
  const { rerender } = render(<RunsTab detail={detail} />)
  expect(screen.queryByText(/Сначала тесты/)).toBeNull()
  rerender(<NotesTab detail={detail} />)
  expect(screen.getByText(/Сначала тесты/)).toBeTruthy()
})

it('does not merge commands across a risk message or a human intervention', () => {
  const events = [
    { ts: '2026-09-22T12:00:00Z', kind: 'action' as const, text: 'pnpm test' },
    { ts: '2026-09-22T12:01:00Z', kind: 'message' as const, text: 'Не удалось проверить' },
    { ts: '2026-09-22T12:02:00Z', kind: 'action' as const, text: 'pnpm build' },
    { ts: '2026-09-22T12:03:00Z', kind: 'steer' as const, text: 'Проверь ещё раз' },
    { ts: '2026-09-22T12:04:00Z', kind: 'action' as const, text: 'pnpm typecheck' },
  ]
  expect(groupEvents(events).map((group) => [group.kind, group.events.length])).toEqual([
    ['action', 1], ['message', 1], ['action', 1], ['steer', 1], ['action', 1],
  ])
})
