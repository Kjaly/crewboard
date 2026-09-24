// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { deadEnds } from '../../src/client/dead-ends.js'
import { ConsoleView } from '../../src/client/views/console.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())

const acceptedAt = '2026-09-22T11:00:00Z'

it('includes accepted tasks with no dependents and excludes accepted prerequisites', () => {
  const repo = makeRepo([
    makeTask({ id: 'base', status: 'accepted', acceptedAt }),
    makeTask({ id: 'used', status: 'accepted', acceptedAt }),
    makeTask({ id: 'next', status: 'ready', deps: ['used'] }),
  ])
  expect(deadEnds(repo).map((task) => task.id)).toEqual(['base'])
})

it('does not list an accepted decision task', () => {
  const repo = makeRepo([makeTask({ id: 'decision', kind: 'decision', status: 'accepted', acceptedAt })])
  expect(deadEnds(repo)).toEqual([])
})

it('does not render the block when there are no dead ends', () => {
  const repo = makeRepo([makeTask({ id: 'active', status: 'running' })])
  render(<ConsoleView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(screen.queryByRole('region', { name: /Принято, но никуда не ведёт/ })).toBeNull()
})

it('selects a dead-end task when its row is clicked', async () => {
  setLang('ru')
  const task = makeTask({ id: 'finding', title: 'Аудит дал результат', status: 'accepted', worker: 'dsh', acceptedAt })
  const onSelect = vi.fn()
  render(<ConsoleView repo={makeRepo([task, makeTask({ id: 'active', status: 'running' })])} selectedId={null} onSelect={onSelect} density="overview" />)
  const block = within(screen.getByRole('region', { name: 'Принято, но никуда не ведёт: 1' }))
  expect(block.getByText(/dsh · принята/)).toBeTruthy()
  await userEvent.setup().click(block.getByRole('button', { name: /Аудит дал результат/ }))
  expect(onSelect).toHaveBeenCalledWith('finding')
})
