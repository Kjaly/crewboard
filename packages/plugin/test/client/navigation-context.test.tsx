// @vitest-environment jsdom
// navigation-context-28: normal navigation must never move the shared CLI `current` pointer. An explicitly
// selected plan is read read-only (`plan-state`), held as a per-root browse snapshot, and every task consumer
// captures that root+plan before it awaits. These tests prove the frontend half of that contract.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { shared, taskVersion } from '../../src/client/api.js'
import { orchestraStore, resetOrchestraStore, shownRepo, useOrchestra } from '../../src/client/store.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonFail, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const plans = [
  { id: 'p1', current: true, rev: 1, goal: 'P1', waitingHuman: 0, running: 0, inReview: 0, ready: 0, accepted: 0, attention: [] },
  { id: 'p2', rev: 1, goal: 'P2', waitingHuman: 0, running: 0, inReview: 0, ready: 0, accepted: 0, attention: [] },
  { id: 'p3', rev: 1, goal: 'P3', waitingHuman: 0, running: 0, inReview: 0, ready: 0, accepted: 0, attention: [] },
] as never
const served = makeRepo([makeTask({ id: 'shared', title: 'P1 task' })], [], { planId: 'p1', plans })
const snapshot = makeSnapshot(served)
const planState = (planId: string, title: string) => ({ ...makeRepo([makeTask({ id: 'shared', title })], [], { planId, plans }) })

function Probe() {
  const { repo, selectedId } = useOrchestra()
  return <div data-testid="probe">{repo?.planId ?? '-'}:{repo?.tasks[0]?.title ?? '-'}:{selectedId ?? '-'}</div>
}
const probe = () => screen.getByTestId('probe').textContent

const planOf = (url: string): string | null => new URL(url, 'http://x').searchParams.get('plan')

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  resetOrchestraStore()
  installEventSource()
})
afterEach(() => { cleanup(); resetOrchestraStore(); window.history.replaceState(null, '', '/') })

it('browsing another plan reads it read-only with explicit coordinates and never calls plan-use', async () => {
  const calls = installFetch((url) => (url.includes('/plan-state') ? jsonOk(planState('p2', 'P2 task')) : jsonOk(snapshot)))
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await act(async () => { orchestraStore.openPlan(ROOT, 'p2') })
  expect(calls.some((call) => call.url.endsWith('/plan-use'))).toBe(false)
  const reads = calls.filter((call) => call.url.includes('/plan-state'))
  expect(reads).toHaveLength(1)
  expect(planOf(reads[0]!.url)).toBe('p2')
  await act(async () => {})
  expect(probe()).toBe('p2:P2 task:-')
  // The browse snapshot's own plan id is what every consumer captures for the task read.
  const repo = shownRepo(orchestraStore.getState())!
  expect(repo.planId).toBe('p2')
  await shared.task(repo.root, 'shared', taskVersion(repo, 'shared', repo.planId), repo.planId)
  const taskReads = calls.filter((call) => call.url.includes('/task?'))
  expect(taskReads.map((call) => planOf(call.url))).toEqual(['p2'])
})

it('shows nothing of the served current plan while the selected plan is still loading', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  installFetch(async (url) => {
    if (url.includes('/plan-state')) { await gate; return jsonOk(planState('p2', 'P2 task')) }
    return jsonOk(snapshot)
  })
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  expect(probe()).toBe('p1:P1 task:-')
  await act(async () => { orchestraStore.openPlan(ROOT, 'p2') })
  // The current plan's task is not shown under the pending selection.
  expect(probe()).toBe('-:-:-')
  expect(orchestraStore.getState().browse).toMatchObject({ root: ROOT, plan: 'p2' })
  await act(async () => { release(); await gate })
  await act(async () => {})
  expect(probe()).toBe('p2:P2 task:-')
})

it('a stale selected-plan response cannot overwrite a newer selection', async () => {
  const gates = new Map<string, () => void>()
  installFetch((url) => {
    if (url.includes('/plan-state')) {
      const plan = planOf(url)!
      const pending = new Promise<void>((resolve) => { gates.set(plan, resolve) })
      return pending.then(() => jsonOk(planState(plan, plan === 'p2' ? 'P2 task' : 'P3 task')))
    }
    return jsonOk(snapshot)
  })
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await act(async () => { orchestraStore.openPlan(ROOT, 'p2') })
  await act(async () => { orchestraStore.openPlan(ROOT, 'p3') })
  // The newer selection answers first; the abandoned P2 answer lands afterwards and must be ignored.
  await act(async () => { gates.get('p3')?.(); await Promise.resolve() })
  await act(async () => { gates.get('p2')?.(); await Promise.resolve() })
  expect(probe()).toBe('p3:P3 task:-')
  expect(orchestraStore.getState().browse?.plan).toBe('p3')
})

it('an explicit plan the repository does not list fails closed, not to the current plan', async () => {
  const calls = installFetch(() => jsonOk(snapshot))
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await act(async () => { orchestraStore.applyRoute({ repo: ROOT, plan: 'gone', view: 'work' }) })
  expect(probe()).toBe('-:-:-')
  expect(orchestraStore.getState().browse?.error).toBe('bad_plan')
  expect(calls.some((call) => call.url.includes('/plan-state'))).toBe(false)
  expect(calls.some((call) => call.url.endsWith('/plan-use'))).toBe(false)
})

it('a plan click pushes history and the remembered route keeps the exact coordinates', async () => {
  installFetch((url) => (url.includes('/plan-state') ? jsonOk(planState('p2', 'P2 task')) : jsonOk(snapshot)))
  orchestraStore.startRouting()
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await act(async () => { orchestraStore.openPlan(ROOT, 'p2') })
  await act(async () => {})
  expect(window.location.hash).toContain('/p2/')
  // The remembered route for the physical copy names the selected plan, so a project return comes back to it.
  expect(localStorage.getItem(`crewboard:route:${ROOT}`)).toContain('p2')
  expect(orchestraStore.getState().browse?.plan).toBe('p2')
})

it('keeps navigation chrome while a selected plan loads, and a late answer does not leave Now', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  installFetch(async (url) => {
    if (url.includes('/plan-state')) { await gate; return jsonOk(planState('p2', 'P2 task')) }
    return jsonOk(snapshot)
  })
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await act(async () => { orchestraStore.openPlan(ROOT, 'p2') })
  // The chrome and its Now control survive the pending read; no task action is rendered from the current plan.
  const now = screen.getByRole('button', { name: 'Now' })
  await act(async () => { now.click() })
  expect(orchestraStore.getState().nowOpen).toBe(true)
  // The late P2 answer lands in its own browse, but the global mode is unchanged and no forced switch happens.
  await act(async () => { release(); await gate })
  await act(async () => {})
  expect(orchestraStore.getState().nowOpen).toBe(true)
  expect(orchestraStore.getState().browse?.plan).toBe('p2')
})

it('recovers from a failed selected-plan read with retry and a return to the current plan', async () => {
  const calls = installFetch((url) => (url.includes('/plan-state') ? jsonFail('bad_plan', 400) : jsonOk(snapshot)))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  await act(async () => { orchestraStore.openPlan(ROOT, 'p2') })
  await act(async () => {})
  expect(screen.getByText(/could not be read/)).toBeTruthy()
  // Retry asks the same read again (it failed, so it is not cached), still without plan-use.
  await act(async () => { screen.getByRole('button', { name: 'Try again' }).click() })
  await act(async () => {})
  expect(calls.filter((call) => call.url.includes('/plan-state')).length).toBeGreaterThanOrEqual(2)
  expect(calls.some((call) => call.url.endsWith('/plan-use'))).toBe(false)
  // Returning to the served current plan clears the browse and restores the full screen.
  await act(async () => { screen.getByRole('button', { name: 'Show current plan' }).click() })
  await act(async () => {})
  expect(orchestraStore.getState().browse).toBeNull()
})


it('opens an unvisited project through the actual App switcher without a bound-method assumption', async () => {
  const freshRoot = '/unvisited-project'
  const fresh = { ...makeRepo([makeTask({ id: 'other', title: 'Fresh task' })], [], { root: freshRoot, planId: 'main' }), pinned: true, family: { root: freshRoot, name: 'Fresh family' } }
  const data = makeSnapshot(served, fresh)
  const calls = installFetch(() => jsonOk(data))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', data) })
  await act(async () => { orchestraStore.startRouting() })
  expect(localStorage.getItem('crewboard:route:' + freshRoot)).toBeNull()
  const switcher = screen.getByRole('navigation', { name: 'Projects' })
  fireEvent.click(within(switcher).getByRole('button', { name: 'Fresh family' }))
  await waitFor(() => expect(window.location.hash).toContain(encodeURIComponent(freshRoot)))
  expect(shownRepo(orchestraStore.getState())?.root).toBe(freshRoot)
  expect(calls.some((call) => call.url.endsWith('/plan-use'))).toBe(false)
})


it('returns through repository search to the remembered plan and view, leaving CLI selection alone', async () => {
  const freshRoot = '/unvisited-project'
  const fresh = { ...makeRepo([makeTask({ id: 'other' })], [], { root: freshRoot, planId: 'main' }), pinned: true, family: { root: freshRoot, name: 'Fresh family' } }
  const data = makeSnapshot(served, fresh)
  const calls = installFetch((url) => url.includes('/plan-state') ? jsonOk(planState('p2', 'P2 task')) : url.includes('/api/task?') ? jsonOk(makeDetail({ id: 'shared' })) : jsonOk(data))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', data); orchestraStore.startRouting() })
  await act(async () => { orchestraStore.openPlan(ROOT, 'p2') })
  await act(async () => { orchestraStore.setView('work'); orchestraStore.select('shared') })
  const switcher = screen.getByRole('navigation', { name: 'Projects' })
  fireEvent.click(within(switcher).getByRole('button', { name: 'Fresh family' }))
  await waitFor(() => expect(shownRepo(orchestraStore.getState())?.root).toBe(freshRoot))
  if (!screen.queryByRole('textbox', { name: 'Search across repositories, plans and tasks' })) fireEvent.click(screen.getAllByRole('button', { name: 'Search across repositories, plans and tasks' })[0]!)
  const input = await screen.findByRole('textbox', { name: 'Search across repositories, plans and tasks' })
  fireEvent.change(input, { target: { value: '/repo' } })
  fireEvent.click(await screen.findByRole('option', { name: /\/repo$/ }))
  await waitFor(() => expect(shownRepo(orchestraStore.getState())?.planId).toBe('p2'))
  expect(window.location.hash).toContain('/p2/work/shared')
  expect(orchestraStore.getState().snapshot?.repos.find((repo) => repo.root === ROOT)?.planId).toBe('p1')
  expect(calls.some((call) => call.url.endsWith('/plan-use'))).toBe(false)
})


it('returns from a cold Now route to the saved non-current plan, without selecting the CLI plan', async () => {
  localStorage.setItem('crewboard:repo', ROOT)
  localStorage.setItem('crewboard:route:' + ROOT, '#orchestra/%2Frepo/p2/work/shared/activity')
  window.history.replaceState(null, '', '/#orchestra/now')
  installFetch((url) => url.includes('/plan-state') ? jsonOk(planState('p2', 'P2 task')) : jsonOk(snapshot))
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot); orchestraStore.startRouting() })
  expect(orchestraStore.getState().nowOpen).toBe(true)
  await act(async () => { orchestraStore.closeNow() })
  await waitFor(() => expect(shownRepo(orchestraStore.getState())?.planId).toBe('p2'))
  expect(window.location.hash).toContain('/p2/work/shared/activity')
  expect(orchestraStore.getState().snapshot?.repos[0]?.planId).toBe('p1')
})
