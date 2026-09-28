// @vitest-environment jsdom
// navigation-context-28: the session memory must be wired into the real panel, not only the map. A→B→A on the
// same plan restores the exact per-task tab and selected older run, and the Work done filter/expansion return.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { WorkView } from '../../src/client/views/work.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

const at = (n: number) => `2026-09-22T12:${String(n).padStart(2, '0')}:00Z`
const RUN1 = { runId: 'r1', agent: 'dsh', startedAt: at(0) }
const RUN2 = { runId: 'r2', agent: 'dsh', startedAt: at(1) }

beforeEach(() => { setLang('en'); localStorage.clear(); resetOrchestraStore() })
afterEach(() => cleanup())

it('restores the per-task tab after visiting another task and returning (A→B→A)', async () => {
  const user = userEvent.setup()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: url.includes('id=b') ? 'b' : 'a', status: 'running', runs: [RUN1] })) : jsonOk(null)))
  const a = makeTask({ id: 'a', status: 'running', runs: 1, lastRunId: 'r1' })
  const b = makeTask({ id: 'b', status: 'running', runs: 1, lastRunId: 'r1' })
  const repo = makeRepo([a, b])
  const { rerender } = render(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
  await user.click(await screen.findByRole('tab', { name: 'Changes' }))
  expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true')
  // Another task is a different memory; returning restores the explicit choice, not the default.
  rerender(<TaskPanel repo={repo} task={b} attention={[]} onSelect={() => {}} density="overview" />)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача b' })).toBeTruthy())
  rerender(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача a' })).toBeTruthy())
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true'))
})

it('restores the selected older run after visiting another task and returning (A→B→A)', async () => {
  const user = userEvent.setup()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'running', runs: [RUN1, RUN2] })) : jsonOk(null)))
  const a = makeTask({ id: 'a', status: 'running', runs: 2, lastRunId: 'r2' })
  const b = makeTask({ id: 'b', status: 'running', runs: 1, lastRunId: 'r1' })
  const repo = makeRepo([a, b])
  const { rerender, container } = render(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
  await waitFor(() => expect(container.querySelector('#orc-activity-run')).toBeTruthy())
  fireEvent.change(container.querySelector('#orc-activity-run') as HTMLSelectElement, { target: { value: 'r1' } })
  expect((container.querySelector('#orc-activity-run') as HTMLSelectElement).value).toBe('r1')
  rerender(<TaskPanel repo={repo} task={b} attention={[]} onSelect={() => {}} density="overview" />)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача b' })).toBeTruthy())
  rerender(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача a' })).toBeTruthy())
  await waitFor(() => expect((container.querySelector('#orc-activity-run') as HTMLSelectElement).value).toBe('r1'))
})

it('returns the Work done filter and expansion for the same root + plan', () => {
  installFetch(() => jsonOk(null))
  const repo = makeRepo([
    makeTask({ id: 'live', status: 'running' }),
    makeTask({ id: 'd1', status: 'accepted' }),
    makeTask({ id: 'd2', status: 'closed' }),
  ], [], { planId: 'p' })
  const props = { repo, selectedId: null, onSelect: () => {}, density: 'overview' as const, lens: null, setLens: () => {}, walk: null, lane: null, setLane: () => {}, onLaneInView: () => {} }
  const { unmount } = render(<WorkView {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /^Done/ }))
  fireEvent.click(screen.getByRole('button', { name: 'May need follow-up' }))
  expect(screen.getByRole('button', { name: 'May need follow-up' }).getAttribute('aria-pressed')).toBe('true')
  unmount()
  // The same plan returns its filter and expansion; a different plan would start fresh.
  render(<WorkView {...props} />)
  expect(screen.getByRole('button', { name: 'May need follow-up' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: /^Done/ }).getAttribute('aria-expanded')).toBe('true')
})
