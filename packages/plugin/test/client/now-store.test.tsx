// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { formatRoute } from '../../src/client/route.js'
import { orchestraStore, resetOrchestraStore, useOrchestra } from '../../src/client/store.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const snapshot = makeSnapshot(makeRepo([makeTask({ id: 'a' }), makeTask({ id: 'b' })], [], { planId: 'p' }))

function Probe() {
  const { nowOpen, selectedId } = useOrchestra()
  return <div data-testid="probe">{nowOpen ? 'now' : 'plan'}:{selectedId ?? '-'}</div>
}

async function mount() {
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  resetOrchestraStore()
  installEventSource()
  installFetch(() => jsonOk(snapshot))
})
afterEach(() => { cleanup(); resetOrchestraStore(); window.history.replaceState(null, '', '/') })

it('opens Now on its own hash without overwriting the per-plan memory, and closes back to it', async () => {
  orchestraStore.startRouting()
  await mount()
  act(() => orchestraStore.select('a'))
  const rememberedRoute = localStorage.getItem(`crewboard:route:${ROOT}`)
  expect(rememberedRoute).toContain('/a')

  act(() => orchestraStore.openNow())
  expect(orchestraStore.getState().nowOpen).toBe(true)
  expect(window.location.hash).toBe('#orchestra/now')
  // The global screen wrote no per-plan view/task/lane.
  expect(localStorage.getItem(`crewboard:task:${ROOT}:p`)).toBe('a')
  expect(localStorage.getItem(`crewboard:route:${ROOT}`)).toBe(rememberedRoute)

  act(() => orchestraStore.closeNow())
  expect(orchestraStore.getState().nowOpen).toBe(false)
  expect(orchestraStore.getState().selected[`${ROOT}:p`]).toBe('a')
  expect(window.location.hash).toBe(formatRoute({ repo: ROOT, plan: 'p', view: 'graph', task: 'a' }))
})

it('restores the global screen from a reloaded hash and leaves it on a project choice', async () => {
  window.history.replaceState(null, '', '#orchestra/now')
  orchestraStore.startRouting()
  await mount()
  expect(orchestraStore.getState().nowOpen).toBe(true)

  act(() => orchestraStore.openRemembered(ROOT))
  expect(orchestraStore.getState().nowOpen).toBe(false)
  expect(orchestraStore.getState().repoRoot).toBe(ROOT)
})

it('hides the per-plan inspector while Now is open and keeps the selection for the return', async () => {
  orchestraStore.startRouting()
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  act(() => orchestraStore.select('a'))
  expect(document.querySelector('.orc-panel')).toBeTruthy()

  act(() => orchestraStore.openNow())
  expect(document.querySelector('[data-now-screen]')).toBeTruthy()
  // The previous project's task panel and queue do not sit beside the global overview.
  expect(document.querySelector('.orc-panel')).toBeNull()

  act(() => orchestraStore.closeNow())
  expect(document.querySelector('.orc-panel')).toBeTruthy()
  expect(orchestraStore.getState().selected[`${ROOT}:p`]).toBe('a')
})

it('reuses the compact switcher above Now and hides plan-scoped header chrome while global', async () => {
  const two = makeSnapshot(
    makeRepo([makeTask({ id: 'a' })], [], { root: ROOT, planId: 'p', family: { root: ROOT, name: 'app' } } as never),
    makeRepo([makeTask({ id: 'b' })], [], { root: '/other', planId: 'p', family: { root: '/other', name: 'other' } } as never),
  )
  installFetch(() => jsonOk(two))
  orchestraStore.startRouting()
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', two) })
  // A plan screen keeps its view tabs, progress strip and preset picker.
  expect(screen.getByRole('radio', { name: 'Graph' })).toBeTruthy()

  act(() => orchestraStore.openNow())
  expect(document.querySelector('[data-now-screen]')).toBeTruthy()
  // One canonical switcher above the content — also in Now — and the global breadcrumb.
  expect(document.querySelector('[data-project-switcher]')).toBeTruthy()
  expect(screen.getByText('All projects')).toBeTruthy()
  // Plan-scoped chrome is gone while global; the switcher and the rail remain for the return.
  expect(screen.queryByRole('radio', { name: 'Graph' })).toBeNull()
  expect(document.querySelector('.orc-process')).toBeNull()
  expect(document.querySelector('.orc-preset')).toBeNull()

  act(() => orchestraStore.closeNow())
  expect(screen.getByRole('radio', { name: 'Graph' })).toBeTruthy()
})
