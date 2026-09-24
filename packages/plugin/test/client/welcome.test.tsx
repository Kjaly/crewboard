// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { setLang } from '../../src/client/i18n.js'
import { snapshotWaiting, reviewWaiting } from '../../src/client/review.js'
import { Tour, TOUR_KEY } from '../../src/client/tour.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import { FakeEventSource, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

beforeEach(() => { setLang('en'); localStorage.clear(); resetOrchestraStore(); installEventSource() })
afterEach(() => cleanup())

function fetches(snap: ReturnType<typeof makeSnapshot>) {
  return installFetch((url) => {
    if (url.includes('/onboarding-workers')) return jsonOk([{ id: 'codex', label: 'Codex', status: 'ready' }, { id: 'claude', label: 'Claude', status: 'sign_in' }])
    if (url.includes('/recipe?')) return jsonOk({ recipe: null, detected: { setup: ['npm ci'], env: { unset: [] }, baseline: 'npm test', timeoutSec: 300 } })
    if (url.includes('/spec-files?')) return jsonOk(['SPEC.md'])
    if (url.includes('/plan-drafts?')) return jsonOk([])
    return jsonOk(snap)
  })
}

it('shows the welcome frame for no plan and empty plan, then leaves it when tasks arrive', async () => {
  const noPlan = makeSnapshot(makeRepo([], [], { hasPlan: false, goal: '', degraded: true, error: 'plan not found: /repo/.orchestration/plan.json (run `orch init`)' }))
  fetches(noPlan)
  render(<App />)
  await act(async () => FakeEventSource.last?.emit('snapshot', noPlan))
  expect(screen.getByRole('heading', { name: 'Break work into tasks and hand them to workers' })).toBeTruthy()
  expect(screen.queryByText(/plan not found:/)).toBeNull()
  expect(screen.queryByText('0 tasks')).toBeNull()
  const empty = makeSnapshot(makeRepo([], [], { hasPlan: true }))
  await act(async () => FakeEventSource.last?.emit('snapshot', empty))
  expect(screen.getByRole('heading', { name: 'How to start' })).toBeTruthy()
  const active = makeSnapshot(makeRepo([makeTask({ id: 'a' })], [], { hasPlan: true }))
  await act(async () => FakeEventSource.last?.emit('snapshot', active))
  expect(screen.queryByRole('heading', { name: 'How to start' })).toBeNull()
})

it('uses worker and recipe data and saves the detected recipe from the form', async () => {
  const withPreset = { ...makeRepo([], [], { hasPlan: false }), effectiveRouting: { preset: { id: 'all-workers', label: 'All workers', builtin: true, routing: { code: [], design: [], review: [], research: [] } }, source: 'builtin', routing: { code: [], design: [], review: [], research: [] }, dropped: [], disabled: {} } }
  const snap = makeSnapshot(withPreset)
  const calls = fetches(snap)
  render(<App />)
  await act(async () => FakeEventSource.last?.emit('snapshot', snap))
  await waitFor(() => expect(screen.getByText(/Codex: ready/)).toBeTruthy())
  expect(screen.getByText(/Claude: sign in/)).toBeTruthy()
  expect(screen.getByText('2 of 3')).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Edit recipe' }))
  expect((screen.getByRole('textbox', { name: 'Setup commands, one per line' }) as HTMLTextAreaElement).value).toBe('npm ci')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save recipe' }))
  expect(calls.find((call) => call.url.endsWith('/recipe-save'))?.body).toMatchObject({ recipe: { setup: ['npm ci'], baseline: 'npm test', timeoutSec: 300 } })
})

it('uses Russian throughout the welcome and sends the active language when creating an example', async () => {
  setLang('ru')
  const repo = { ...makeRepo([], [], { hasPlan: false }), effectiveRouting: { preset: { id: 'all-workers', label: 'All workers', builtin: true, routing: { code: [], design: [], review: [], research: [] } }, source: 'builtin', routing: { code: [], design: [], review: [], research: [] }, dropped: [], disabled: {} } }
  const snap = makeSnapshot(repo)
  const calls = fetches(snap)
  render(<App />)
  await act(async () => FakeEventSource.last?.emit('snapshot', snap))
  expect(screen.getByText('Все воркеры · встроенный')).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: /Посмотреть пример/ }))
  await waitFor(() => expect(calls.find((call) => call.url.endsWith('/example-create'))?.body).toMatchObject({ lang: 'ru' }))
})

it('moves through tour steps and remembers Skip', async () => {
  const steps: number[] = []
  const user = userEvent.setup()
  const { rerender } = render(<Tour step={0} onStep={(n) => steps.push(n)} onClose={() => localStorage.setItem(TOUR_KEY, '1')} />)
  await user.click(screen.getByRole('button', { name: 'Next' }))
  expect(steps).toEqual([1])
  rerender(<Tour step={1} onStep={(n) => steps.push(n)} onClose={() => localStorage.setItem(TOUR_KEY, '1')} />)
  await user.click(screen.getByRole('button', { name: 'Back' }))
  expect(steps).toEqual([1, 0])
  await user.click(screen.getByRole('button', { name: 'Skip' }))
  expect(localStorage.getItem(TOUR_KEY)).toBe('1')
  localStorage.removeItem(TOUR_KEY)
  await user.keyboard('{Escape}')
  expect(localStorage.getItem(TOUR_KEY)).toBe('1')
})

it('keeps example review tasks visible without counting them as real review debt', () => {
  const repo = makeRepo([makeTask({ id: 'review', status: 'in_review' })], [], { example: true, hasPlan: true })
  expect(reviewWaiting(repo)).toBe(0)
  expect(snapshotWaiting(makeSnapshot(repo))).toBe(0)
})

it('starts the example tour once and persists completion on this machine', async () => {
  const snap = makeSnapshot(makeRepo([
    makeTask({ id: 'build', status: 'running' }),
    makeTask({ id: 'review', status: 'in_review' }),
  ], [], { hasPlan: true, example: true, planId: 'orchestra-example' }))
  fetches(snap)
  render(<App />)
  await act(async () => FakeEventSource.last?.emit('snapshot', snap))
  expect(screen.getByRole('dialog', { name: 'Orchestrator' })).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Skip' }))
  expect(localStorage.getItem(TOUR_KEY)).toBe('1')
  expect(screen.queryByRole('dialog', { name: 'Orchestrator' })).toBeNull()
})
