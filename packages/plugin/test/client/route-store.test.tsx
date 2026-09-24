// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { formatRoute } from '../../src/client/route.js'
import { orchestraStore, resetOrchestraStore, useOrchestra } from '../../src/client/store.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const snapshot = makeSnapshot(makeRepo([makeTask({ id: 'a' }), makeTask({ id: 'b' })], [], { planId: 'p' }))
function Probe() { const { selectedId, view, routeRequest } = useOrchestra(); return <div data-testid="route">{selectedId ?? '-'}:{view}:{routeRequest?.route.tab ?? '-'}</div> }
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
afterEach(() => { cleanup(); resetOrchestraStore(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks() })

it('restores a task and tab from the hash after the snapshot arrives', async () => {
  window.history.replaceState(null, '', formatRoute({ repo: ROOT, plan: 'p', view: 'work', task: 'b', tab: 'changes' }))
  orchestraStore.startRouting()
  await mount()
  expect(orchestraStore.getState().repoRoot).toBe(ROOT)
  expect(orchestraStore.getState().selected[`${ROOT}:p`]).toBe('b')
  expect(orchestraStore.getState().routeRequest?.route.tab).toBe('changes')
  expect(orchestraStore.viewOf(ROOT, 'p')).toBe('work')
})

it('restores the last route for the repository without a hash', async () => {
  localStorage.setItem(`crewboard:route:${ROOT}`, formatRoute({ repo: ROOT, plan: 'p', view: 'review', task: 'a', tab: 'activity' }))
  resetOrchestraStore()
  orchestraStore.startRouting()
  await mount()
  expect(orchestraStore.getState().selected[`${ROOT}:p`]).toBe('a')
  expect(orchestraStore.viewOf(ROOT, 'p')).toBe('review')
})

it('falls back from a missing repository and plan', async () => {
  window.history.replaceState(null, '', '#orchestra/missing/old/review/gone')
  orchestraStore.startRouting()
  await mount()
  expect(orchestraStore.getState().repoRoot).toBe(ROOT)
  expect(orchestraStore.viewOf(ROOT, 'p')).toBe('graph')
  act(() => orchestraStore.applyRoute({ repo: ROOT, plan: 'old', view: 'work', task: 'a' }))
  expect(orchestraStore.getState().selected[`${ROOT}:p`]).toBe('a')
})

it('pushes task navigation, replaces tab refinement, and applies Back', async () => {
  orchestraStore.startRouting()
  await mount()
  act(() => orchestraStore.select('a'))
  const first = window.location.hash
  act(() => orchestraStore.navigate({ tab: 'changes' }, 'replace'))
  expect(window.location.hash).toContain('/a/changes')
  act(() => orchestraStore.setLens('ready'))
  expect(window.location.hash).toContain('lens=ready')
  act(() => orchestraStore.select('b'))
  expect(window.location.hash).toContain('/b')
  act(() => { window.history.replaceState(null, '', first); window.dispatchEvent(new PopStateEvent('popstate')) })
  expect(orchestraStore.getState().selected[`${ROOT}:p`]).toBe('a')
})

it('routes notification and queue targets, drafts, runs, and task links', async () => {
  orchestraStore.startRouting()
  await mount()
  act(() => orchestraStore.openWaiting({ root: ROOT, planId: 'p', taskId: 'a' }))
  expect(window.location.hash).toContain('/a')
  expect(orchestraStore.taskLink('a')).toContain('/a')
  act(() => orchestraStore.navigate({ task: 'a', run: 'run-1' }))
  expect(window.location.hash).toContain('?run=run-1')
  const runRequest = orchestraStore.getState().routeRequest?.seq
  act(() => orchestraStore.navigate({ step: 'step:1' }, 'replace'))
  expect(window.location.hash).toContain('step=step%3A1')
  expect(orchestraStore.getState().routeRequest?.seq).toBe(runRequest)
  act(() => orchestraStore.navigate({ run: 'run-2' }))
  expect(window.location.hash).not.toContain('step=')
  act(() => orchestraStore.navigate({ task: undefined, run: undefined, draft: 'draft-1' }))
  expect(window.location.hash).toContain('?draft=draft-1')
})

it('degrades unknown task, tab, and view to the current plan', async () => {
  window.history.replaceState(null, '', `#orchestra/${encodeURIComponent(ROOT)}/p/unknown/gone/unknown`)
  orchestraStore.startRouting()
  await mount()
  expect(orchestraStore.viewOf(ROOT, 'p')).toBe('graph')
  expect(orchestraStore.getState().selected[`${ROOT}:p`]).toBe('')
  await act(async () => {})
  expect(window.location.hash).toBe(formatRoute({ repo: ROOT, plan: 'p', view: 'graph' }))
})
