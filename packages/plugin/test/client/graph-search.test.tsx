// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { GraphView } from '../../src/client/views/graph/index.js'
import { searchTasks } from '../../src/client/views/graph/search.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())

const tasks = [
  makeTask({ id: 'a1', title: 'Собрать раскладку' }),
  makeTask({ id: 'b2', title: 'Вторая задача', deps: ['a1'] }),
  makeTask({ id: 'c3', title: 'Проверить бандл', deps: ['a1'] }),
]
const repo = makeRepo(tasks)

it('ranks matches by id and title', () => {
  expect(searchTasks(tasks, 'b2').map((t) => t.id)).toEqual(['b2'])
  expect(searchTasks(tasks, 'задача').map((t) => t.id)).toEqual(['b2'])
  expect(searchTasks(tasks, 'зззз')).toEqual([])
  expect(searchTasks(tasks, '  ').map((t) => t.id)).toEqual(['a1', 'b2', 'c3'])
})

it('opens the field on ⌘K and selects a task on Enter', async () => {
  setLang('ru')
  installMatchMedia(false)
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<GraphView repo={repo} selectedId={null} onSelect={onSelect} density="overview" />)
  await screen.findByRole('button', { name: /Вторая задача/ })

  expect(screen.queryByLabelText('Поиск задачи по плану')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Найти' }))
  const field = await screen.findByLabelText('Поиск задачи по плану')

  await user.type(field, 'Вторая')
  expect(screen.getAllByRole('button', { name: /Вторая задача/ }).length).toBeGreaterThan(1)
  await user.keyboard('{Enter}')

  expect(onSelect).toHaveBeenCalledWith('b2')
  expect(screen.queryByLabelText('Поиск задачи по плану')).toBeNull()
})

it('closes the field on Escape without selecting anything', async () => {
  setLang('ru')
  installMatchMedia(false)
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<GraphView repo={repo} selectedId={null} onSelect={onSelect} density="overview" />)
  await screen.findByRole('button', { name: /Вторая задача/ })

  await user.click(screen.getByRole('button', { name: 'Найти' }))
  await screen.findByLabelText('Поиск задачи по плану')
  await user.keyboard('{Escape}')

  expect(screen.queryByLabelText('Поиск задачи по плану')).toBeNull()
  expect(onSelect).not.toHaveBeenCalled()
})
