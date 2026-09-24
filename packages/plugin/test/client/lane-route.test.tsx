// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PlanCost } from '../../src/shared/types.js'
import { setLang } from '../../src/client/i18n.js'
import { formatRoute, parseRoute } from '../../src/client/route.js'
import { orchestraStore, resetOrchestraStore, useOrchestra } from '../../src/client/store.js'
import { DECISION_LANE } from '../../src/client/views/graph/layout.js'
import { ReviewView } from '../../src/client/views/review.js'
import { WorkView } from '../../src/client/views/work.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const tasks = [
  makeTask({ id: 'a', title: 'Alpha task', lane: 'Build', status: 'ready' }),
  makeTask({ id: 'b', title: 'Beta task', lane: 'Ship', status: 'ready' }),
  makeTask({ id: 'c', title: 'Gamma task', status: 'running' }),
]
const snapshot = makeSnapshot(makeRepo(tasks, [], { planId: 'p' }))
function Probe() {
  const { lane, view } = useOrchestra()
  return <div data-testid="lane">{lane ? `${lane.lane}#${lane.seq}` : '-'}:{view}</div>
}
async function mount() {
  render(<Probe />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
}

beforeEach(() => {
  setLang('en')
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  resetOrchestraStore()
  installEventSource()
  installFetch(() => jsonOk(snapshot))
})
afterEach(() => { cleanup(); resetOrchestraStore(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks() })

it('parses and formats the lane parameter, the unnamed lane included', () => {
  const hash = formatRoute({ repo: '/r', plan: 'p', view: 'graph', lane: 'Plan 1c' })
  expect(hash).toBe('#orchestra/%2Fr/p/graph?lane=Plan+1c')
  expect(parseRoute(hash)?.lane).toBe('Plan 1c')
  expect(parseRoute('#orchestra/%2Fr/p/graph?lane=')?.lane).toBe('')
  expect(parseRoute('#orchestra/%2Fr/p/graph')?.lane).toBeUndefined()
  expect(parseRoute(formatRoute({ repo: '/r', plan: 'p', view: 'work', lane: DECISION_LANE }))?.lane).toBe(DECISION_LANE)
})

it('opens the plan focused on the lane from the hash', async () => {
  window.history.replaceState(null, '', formatRoute({ repo: ROOT, plan: 'p', view: 'work', lane: 'Ship' }))
  orchestraStore.startRouting()
  await mount()
  expect(screen.getByTestId('lane').textContent).toMatch(/^Ship#\d+:work$/)
})

it('writes a picked lane to the route, bumps the request on a repeat, and clears it', async () => {
  orchestraStore.startRouting()
  await mount()
  act(() => orchestraStore.focusLane('Build'))
  const first = screen.getByTestId('lane').textContent
  expect(first).toMatch(/^Build#\d+:graph$/)
  await act(async () => { await Promise.resolve() })
  expect(parseRoute(window.location.hash)?.lane).toBe('Build')
  act(() => orchestraStore.focusLane('Build'))
  expect(screen.getByTestId('lane').textContent).not.toBe(first)
  act(() => orchestraStore.focusLane(null))
  expect(screen.getByTestId('lane').textContent).toBe('-:graph')
  expect(parseRoute(window.location.hash)?.lane).toBeUndefined()
})

it('copies a lane link that opens the plan on that lane', async () => {
  orchestraStore.startRouting()
  await mount()
  const link = orchestraStore.laneLink('Ship')
  expect(link.startsWith(window.location.origin)).toBe(true)
  expect(parseRoute(link.slice(link.indexOf('#')))).toMatchObject({ repo: ROOT, plan: 'p', lane: 'Ship' })
})

it('Work narrows every column to the picked lane and clears it from the chip', async () => {
  const user = userEvent.setup()
  const setLane = vi.fn()
  render(<WorkView repo={makeRepo(tasks)} selectedId={null} onSelect={() => {}} density="overview" lane={{ lane: 'Build', seq: 1 }} setLane={setLane} />)
  expect(screen.getByText('Alpha task')).toBeTruthy()
  expect(screen.queryByText('Beta task')).toBeNull()
  expect(screen.queryByText('Gamma task')).toBeNull()
  expect(screen.getByText('Lane: Build')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Show all lanes' }))
  expect(setLane).toHaveBeenCalledWith(null)
  cleanup()
  render(<WorkView repo={makeRepo(tasks)} selectedId={null} onSelect={() => {}} density="overview" lane={{ lane: '', seq: 2 }} />)
  expect(screen.getByText('Lane: No lane')).toBeTruthy()
  expect(screen.queryByText('Alpha task')).toBeNull()
})

it('Review sets its Lane filter to the picked lane', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const run = (taskId: string, title: string) => ({ runId: `r-${taskId}`, taskId, taskTitle: title, agent: 'codex', startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T11:00:00Z' })
  const cost = { generatedAt: now.toISOString(), runs: [run('a', 'Alpha task'), run('b', 'Beta task')], totals: {}, accepted: [], tasks: [] } as unknown as PlanCost
  const props = { repo: makeRepo(tasks), cost, now, selectedId: null, onSelect: vi.fn(), density: 'overview' as const }
  const { rerender } = render(<ReviewView {...props} lane={{ lane: 'Ship', seq: 1 }} />)
  expect(screen.queryAllByText('Beta task').length).toBeGreaterThan(0)
  expect(screen.queryAllByText('Alpha task')).toHaveLength(0)
  rerender(<ReviewView {...props} lane={{ lane: 'Build', seq: 2 }} />)
  expect(screen.queryAllByText('Alpha task').length).toBeGreaterThan(0)
  expect(screen.queryAllByText('Beta task')).toHaveLength(0)
})
