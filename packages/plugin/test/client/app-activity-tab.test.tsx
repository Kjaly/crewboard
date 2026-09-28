// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

beforeEach(() => {
  setLang('ru')
  localStorage.clear()
  resetOrchestraStore()
})
afterEach(() => cleanup())

const nodeFor = async (id: string) => {
  await waitFor(() => expect(document.querySelector(`[data-task-id="${id}"] button`)).toBeTruthy())
  return document.querySelector(`[data-task-id="${id}"] button`) as HTMLElement
}
const selectedTab = (name: string) => screen.getByRole('tab', { name }).getAttribute('aria-selected')

it('opens Activity for a running task selected from the graph', async () => {
  const snapshot = makeSnapshot(makeRepo([makeTask({ id: 'run', title: 'Идёт сейчас', status: 'running' })]))
  installEventSource()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'run', status: 'running', runs: [] })) : jsonOk(snapshot)))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })

  await userEvent.setup().click(await nodeFor('run'))
  await waitFor(() => expect(selectedTab('Активность')).toBe('true'))
})

it('does not let a Changes request from one task linger onto the next', async () => {
  const user = userEvent.setup()
  const snapshot = makeSnapshot(makeRepo([makeTask({ id: 'a', title: 'Первая', status: 'ready' }), makeTask({ id: 'b', title: 'Вторая', status: 'ready' })]))
  installEventSource()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: url.includes('id=b') ? 'b' : 'a' })) : jsonOk(snapshot)))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })

  await user.click(await nodeFor('a'))
  await waitFor(() => expect(selectedTab('Обзор')).toBe('true'))
  await user.click(screen.getByRole('tab', { name: 'Изменения' }))
  expect(selectedTab('Изменения')).toBe('true')

  await user.click(await nodeFor('b'))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Вторая' })).toBeTruthy())
  expect(selectedTab('Обзор')).toBe('true')
  expect(selectedTab('Изменения')).toBe('false')
})

it('does not carry a tab request for a same-id task into another plan', async () => {
  const user = userEvent.setup()
  const p1 = makeSnapshot(makeRepo([makeTask({ id: 'x', title: 'Общая', status: 'ready' })], [], { planId: 'p1' }))
  installEventSource()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'x' })) : jsonOk(p1)))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', p1) })

  await user.click(await nodeFor('x'))
  await user.click(screen.getByRole('tab', { name: 'Изменения' }))
  expect(selectedTab('Изменения')).toBe('true')

  // The host switches plans; the same task id is selected in the new plan.
  act(() => { orchestraStore.selectIn(ROOT, 'p2', 'x') })
  const p2 = makeSnapshot(makeRepo([makeTask({ id: 'x', title: 'Общая', status: 'ready' })], [], { planId: 'p2' }))
  await act(async () => { FakeEventSource.last?.emit('snapshot', p2) })

  await waitFor(() => expect(orchestraStore.getState().snapshot?.repos[0]?.planId).toBe('p2'))
  await waitFor(() => expect(selectedTab('Обзор')).toBe('true'))
  expect(selectedTab('Изменения')).toBe('false')
})
