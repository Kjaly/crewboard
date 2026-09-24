// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LANE_GROUPS, laneAt, laneTree, liveLaneOrder, readLaneGroups, writeLaneGroups } from '../../src/client/lane-tree.js'
import { DECISION_LANE, laneOrder, layoutFoldStack } from '../../src/client/views/graph/layout.js'
import { makeRepo, makeTask } from './helpers.js'

/** A plan in the shape the owner's plan has: finished history on top, live lanes scattered below. */
const snapshot = () => makeRepo([
  makeTask({ id: 'd1', kind: 'decision', status: 'accepted' }),
  makeTask({ id: 'h1', lane: 'Plan 1c', status: 'accepted' }),
  makeTask({ id: 'h2', lane: 'Plan 1c', status: 'superseded' }),
  makeTask({ id: 'q1', lane: 'Queue', status: 'blocked' }),
  makeTask({ id: 'q2', lane: 'Queue', status: 'ready' }),
  makeTask({ id: 'r1', lane: 'Reliability', status: 'running' }),
  makeTask({ id: 'r2', lane: 'Reliability', status: 'accepted' }),
  makeTask({ id: 'a1', lane: 'Analysis', status: 'in_review' }),
  makeTask({ id: 'a2', lane: 'Analysis', status: 'closed' }),
  makeTask({ id: 'u1', status: 'backlog' }),
  makeTask({ id: 'h3', lane: '2a', status: 'accepted' }),
])

it('splits lanes into Now and History and orders Now: waiting, running, then the rest', () => {
  const tree = laneTree(snapshot())
  expect(tree.now.map((row) => [row.lane, row.tone])).toEqual([
    ['Analysis', 'waiting'],
    ['Reliability', 'running'],
    ['Queue', 'idle'],
    ['', 'idle'],
  ])
  expect(tree.history.map((row) => row.lane)).toEqual([DECISION_LANE, 'Plan 1c', '2a'])
  expect(tree.history.every((row) => row.finished && row.tone === 'idle')).toBe(true)
})

it('counts running, awaiting the person, ready, queued and accepted per lane', () => {
  const rows = new Map([...laneTree(snapshot()).now, ...laneTree(snapshot()).history].map((row) => [row.lane, row.counts]))
  expect(rows.get('Analysis')).toEqual({ running: 0, review: 1, ready: 0, queued: 0, accepted: 1 })
  expect(rows.get('Reliability')).toEqual({ running: 1, review: 0, ready: 0, queued: 0, accepted: 1 })
  expect(rows.get('Queue')).toEqual({ running: 0, review: 0, ready: 1, queued: 1, accepted: 0 })
  expect(rows.get('Plan 1c')).toEqual({ running: 0, review: 0, ready: 0, queued: 0, accepted: 1 })
})

it('an open decision waits for the person; one the orchestrator is still checking runs', () => {
  const tree = laneTree(makeRepo([
    makeTask({ id: 'd', kind: 'decision', status: 'ready' }),
    makeTask({ id: 'c', lane: 'Checked', status: 'in_review', check: 'checking' }),
  ]))
  expect(tree.now.map((row) => [row.lane, row.tone])).toEqual([[DECISION_LANE, 'waiting'], ['Checked', 'running']])
})

it('gives the graph the tree order: live lanes first, history last', () => {
  const order = liveLaneOrder(snapshot())
  expect(order).toEqual(['Analysis', 'Reliability', 'Queue', '', DECISION_LANE, 'Plan 1c', '2a'])
  expect(laneOrder(snapshot().tasks, order)).toEqual(order)
  // Without an order the plan order stands: decisions first, unnamed last.
  expect(laneOrder(snapshot().tasks)).toEqual([DECISION_LANE, 'Plan 1c', 'Queue', 'Reliability', 'Analysis', '2a', ''])
})

it('stacks the folded graph in the live-first order', () => {
  const repo = snapshot()
  const { bands } = layoutFoldStack(repo.tasks, new Set(), liveLaneOrder(repo))
  expect(bands.map((band) => band.lane)).toEqual(liveLaneOrder(repo))
})

it('names the lane under the middle of the view, and the nearest chip in a packed folded band', () => {
  const bands = [
    { lane: 'Live', top: 0, height: 200 },
    { lane: 'Old', lanes: ['Old', 'Older'], folded: true, top: 208, height: 80 },
  ]
  const chips = new Map([['lane:Old', { x: 254 }], ['lane:Older', { x: 508 }]])
  expect(laneAt(bands, chips, { minX: 0, minY: 0, maxX: 800, maxY: 200 })).toBe('Live')
  expect(laneAt(bands, chips, { minX: 200, minY: 150, maxX: 1000, maxY: 350 })).toBe('Older')
  expect(laneAt(bands, chips, { minX: -300, minY: 150, maxX: 500, maxY: 350 })).toBe('Old')
  // Past the last band the nearest one still counts; no bands — no lane.
  expect(laneAt(bands, chips, { minX: -400, minY: 900, maxX: 400, maxY: 1100 })).toBe('Old')
  expect(laneAt([], chips, { minX: 0, minY: 0, maxX: 1, maxY: 1 })).toBeNull()
})

describe('group state', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('opens Now and folds History by default, and remembers a choice per plan', () => {
    expect(readLaneGroups('/r', 'p')).toEqual(DEFAULT_LANE_GROUPS)
    expect(DEFAULT_LANE_GROUPS).toEqual({ now: true, history: false })
    writeLaneGroups('/r', 'p', { now: false, history: true })
    expect(readLaneGroups('/r', 'p')).toEqual({ now: false, history: true })
    expect(readLaneGroups('/r', 'other')).toEqual(DEFAULT_LANE_GROUPS)
  })

  it('reads a broken or blocked storage as the defaults and never throws', () => {
    localStorage.setItem('crewboard:lane-tree:/r:p', '{"now":"yes","history":1}')
    expect(readLaneGroups('/r', 'p')).toEqual(DEFAULT_LANE_GROUPS)
    localStorage.setItem('crewboard:lane-tree:/r:p', 'not json')
    expect(readLaneGroups('/r', 'p')).toEqual(DEFAULT_LANE_GROUPS)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readLaneGroups('/r', 'p')).toEqual(DEFAULT_LANE_GROUPS)
    expect(() => writeLaneGroups('/r', 'p', { now: true, history: true })).not.toThrow()
  })
})
