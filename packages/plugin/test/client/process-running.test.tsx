// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { App } from '../../src/client/app.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import type { OrchestraSnapshot, RepoSnapshot } from '../../src/shared/types.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const mount = async (snap: OrchestraSnapshot) => {
  installEventSource()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a' })) : jsonOk(snap)))
  render(<App />)
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', snap)
  })
}

beforeEach(() => {
  setLang('ru')
  localStorage.clear()
  resetOrchestraStore()
})
afterEach(() => cleanup())

it('shows running work once: the strip stage is the element, the header adds no second chip', async () => {
  await mount(makeSnapshot(makeRepo([makeTask({ id: 'r1', status: 'running' }), makeTask({ id: 'r2', status: 'running' })])))
  expect(screen.getAllByRole('button', { name: /^В работе/ })).toHaveLength(1)
  expect(document.querySelector('.orc-top')?.textContent).not.toContain('В работе')
  expect(document.querySelector('.orc-process')?.textContent).toContain('В работе')
})

it('the stage keeps the list and the lens instead of jumping to the first task', async () => {
  const user = userEvent.setup()
  await mount(makeSnapshot(makeRepo([makeTask({ id: 'r1', status: 'running' }), makeTask({ id: 'r2', status: 'running' })])))
  const stage = screen.getByRole('button', { name: /^В работе 2/ })
  await user.click(stage)
  // The lens is on, the selection is not: nobody was flown to a task yet.
  expect(stage.getAttribute('aria-pressed')).toBe('true')
  expect(localStorage.getItem(`crewboard:lens:${ROOT}`)).toBe('running')
  expect(localStorage.getItem(`crewboard:task:${ROOT}`) ?? '').toBe('')
  const options = screen.getAllByRole('option')
  expect(options.map((row) => row.textContent)).toEqual([expect.stringContaining('r1'), expect.stringContaining('r2')])
  await user.click(options[1]!)
  expect(localStorage.getItem(`crewboard:task:${ROOT}`)).toBe('r2')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(stage.getAttribute('aria-pressed')).toBe('true')
})

it('Escape folds the list, releases the lens and hands focus back to the stage', async () => {
  const user = userEvent.setup()
  await mount(makeSnapshot(makeRepo([makeTask({ id: 'r1', status: 'running' })])))
  const stage = screen.getByRole('button', { name: /^В работе 1/ })
  await user.click(stage)
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(localStorage.getItem(`crewboard:lens:${ROOT}`) ?? '').toBe('')
  expect(document.activeElement).toBe(stage)
})

it('a zero count releases the lens instead of leaving an empty one active', async () => {
  const user = userEvent.setup()
  const repo = makeRepo([makeTask({ id: 'r1', status: 'running' })])
  await mount(makeSnapshot(repo))
  await user.click(screen.getByRole('button', { name: /^В работе 1/ }))
  expect(localStorage.getItem(`crewboard:lens:${ROOT}`)).toBe('running')
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', makeSnapshot(makeRepo([makeTask({ id: 'r1', status: 'ready' })])))
  })
  expect(localStorage.getItem(`crewboard:lens:${ROOT}`) ?? '').toBe('')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /^В работе/ })).toBeNull()
})

it.each(['archived', 'partial'] as const)('keeps the header running chip where the strip hides (%s repo)', async (flag) => {
  const repo = makeRepo([makeTask({ id: 'r1', status: 'running' })], [], { [flag]: true } as Partial<RepoSnapshot>)
  await mount(makeSnapshot(repo))
  expect(document.querySelector('.orc-process')).toBeNull()
  const header = document.querySelector('.orc-top')!
  expect(header.textContent).toContain('В работе · 1')
  const chip = screen.getByRole('button', { name: /В работе · 1/ })
  await userEvent.setup().click(chip)
  expect(screen.getAllByRole('option')).toHaveLength(1)
})

it('breathes only for real work: the running stage moves, a pending check does not', async () => {
  await mount(makeSnapshot(makeRepo([makeTask({ id: 'r1', status: 'running' }), makeTask({ id: 'c1', status: 'in_review', check: 'pending' })])))
  const stage = screen.getByRole('button', { name: /^В работе 1/ })
  const check = screen.getByRole('button', { name: /Ждёт проверки 1/ })
  expect(stage.className).toContain('orc-process__stage--moving')
  expect(check.className).not.toContain('orc-process__stage--moving')
})
