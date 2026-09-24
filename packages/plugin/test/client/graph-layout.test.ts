import ElkBundle from 'elkjs/lib/elk.bundled.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setElkEngine } from '../../src/client/views/graph/elk.js'
import { DECISION_LANE, NODE_H, NODE_W, type NodePos, laneBands, layoutGraph } from '../../src/client/views/graph/layout.js'
import { makeTask } from './helpers.js'

const Elk = ElkBundle as unknown as new () => { layout(graph: unknown): Promise<unknown> }

describe('layoutGraph', () => {
  // In the browser the engine arrives in its own bundle; here it is handed over directly, because
  // the placement bugs worth testing are ELK's free x values, not the level fallback.
  beforeAll(() => setElkEngine(new Elk()))
  afterAll(() => setElkEngine(undefined))

  it('places a dependent task to the right of its dependency', async () => {
    const pos = await layoutGraph([makeTask({ id: 'a' }), makeTask({ id: 'b', deps: ['a'] }), makeTask({ id: 'c', deps: ['b'] })])
    expect(pos.get('b')?.x ?? 0).toBeGreaterThan(pos.get('a')?.x ?? 0)
    expect(pos.get('c')?.x ?? 0).toBeGreaterThan(pos.get('b')?.x ?? 0)
  })

  it('keeps one lane on one band and human decisions on the first band', async () => {
    const pos = await layoutGraph([
      makeTask({ id: 'plan', kind: 'decision', lane: 'i0' }),
      makeTask({ id: 'a', lane: 'i0', deps: ['plan'] }),
      makeTask({ id: 'b', lane: 'i0', deps: ['plan'] }),
      makeTask({ id: 'c', lane: 'i1', deps: ['a'] }),
    ])
    expect(pos.get('plan')?.lane).toBe(DECISION_LANE)
    expect(pos.get('a')?.lane).toBe('i0')
    expect(pos.get('b')?.lane).toBe('i0')
    expect(pos.get('c')?.lane).toBe('i1')

    const bands = laneBands(pos)
    expect(bands.map((l) => l.lane)).toEqual([DECISION_LANE, 'i0', 'i1'])
    expect(bands[0]!.top + bands[0]!.height).toBeLessThanOrEqual(bands[1]!.top)
    expect(bands[1]!.top + bands[1]!.height).toBeLessThanOrEqual(bands[2]!.top)
    for (const id of ['a', 'b']) {
      const y = pos.get(id)?.y ?? Number.NaN
      expect(y).toBeGreaterThanOrEqual(bands[1]!.top)
      expect(y + NODE_H).toBeLessThanOrEqual(bands[1]!.top + bands[1]!.height)
    }
  })

  it('stacks human decisions instead of drawing them on top of each other', async () => {
    // A decision nobody depends on gets an x of its own from ELK; keyed by that raw x, it used to
    // start its own row counter and land on the card already standing there.
    const tasks = [
      makeTask({ id: 'a', lane: 'i2' }),
      makeTask({ id: 'loose', kind: 'decision', lane: 'i0' }),
      makeTask({ id: 'after', kind: 'decision', lane: 'i0', deps: ['a'] }),
      makeTask({ id: 'free', kind: 'decision', lane: 'i1' }),
      makeTask({ id: 'b', lane: 'i1', deps: ['a', 'after'] }),
    ]
    const pos = await layoutGraph(tasks)
    const spots = [...pos.entries()]
    for (const [id, a] of spots) {
      for (const [other, b] of spots) {
        if (other <= id) continue
        expect(Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H, `${id} overlaps ${other}`).toBe(true)
      }
    }
    // Everything on the «Решения» band is one vertical stack per column.
    const decisions = ['loose', 'after', 'free'].map((id) => pos.get(id))
    expect(decisions.every((p) => p?.lane === DECISION_LANE)).toBe(true)
    expect(pos.get('after')?.x ?? 0).toBeGreaterThan(pos.get('a')?.x ?? 0)
  })

  it('lays the plan out by dependency levels while the layout engine is still loading', async () => {
    setElkEngine(undefined)
    const pos = await layoutGraph([makeTask({ id: 'a' }), makeTask({ id: 'b', deps: ['a'] }), makeTask({ id: 'c', deps: ['a'] })])
    expect(pos.get('b')?.x ?? 0).toBeGreaterThan(pos.get('a')?.x ?? 0)
    expect(pos.get('c')?.y).not.toBe(pos.get('b')?.y)
    setElkEngine(new Elk())
  })

  it('takes a pinned position as is', async () => {
    const pos = await layoutGraph([makeTask({ id: 'a' }), makeTask({ id: 'p', deps: ['a'], pos: { x: -40, y: 300 } })])
    expect(pos.get('p')).toMatchObject({ x: -40, y: 300 })
  })

  it('starts every task without dependencies in the first column of its lane', async () => {
    // ELK lays each disconnected component out on its own; a task that waits for nothing used to
    // inherit the column of whatever component it landed in, and read as «deep» in a graph of depth 1.
    const pos = await layoutGraph([
      makeTask({ id: 'a', lane: 'i0' }),
      makeTask({ id: 'b', lane: 'i0', deps: ['a'] }),
      makeTask({ id: 'c', lane: 'i0', deps: ['b'] }),
      makeTask({ id: 'free', lane: 'i0' }),
      makeTask({ id: 'alone', lane: 'i1' }),
    ])
    const first = pos.get('a')?.x ?? Number.NaN
    expect(first).toBe(0)
    for (const id of ['free', 'alone']) expect(pos.get(id)?.x).toBe(first)
    expect(pos.get('b')?.x ?? 0).toBeGreaterThan(first)
  })

  it('a changed node set never gives two lanes the same y nor pushes a label outside its frame', async () => {
    // The bug the owner saw: a task that moved lanes kept its old y and its new band drew over the
    // neighbour's frame and label. Now a kept position survives only inside its own lane.
    const first = await layoutGraph([makeTask({ id: 'a', lane: 'i0' }), makeTask({ id: 'b', lane: 'i1', deps: ['a'] })])
    const next = await layoutGraph([makeTask({ id: 'a', lane: 'i0' }), makeTask({ id: 'b', lane: 'i0', deps: ['a'] })], first)
    expect(next.get('b')?.lane).toBe('i0')

    const bands = laneBands(next)
    expect(bands.map((b) => b.lane)).toEqual(['i0'])
    const band = bands[0]!
    for (const pos of next.values()) {
      expect(pos.y).toBeGreaterThanOrEqual(band.top)
      expect(pos.y + NODE_H).toBeLessThanOrEqual(band.top + band.height)
    }
    // The label lives inside the frame: the padding above the topmost node is structural.
    expect(band.top).toBeLessThan(next.get('a')!.y)
  })

  it('laneBands partitions even when positions interleave', () => {
    // A pinned node can drag its lane's extent across a neighbour's; the frames still tile —
    // each band starts only after the previous one ends, so no two rects or labels share a span.
    const nodes = new Map<string, NodePos>([
      ['a', { x: 0, y: 0, lane: 'i0' }],
      ['b', { x: 0, y: 40, lane: 'i1' }],
      ['c', { x: 0, y: 120, lane: 'i0' }],
    ])
    const bands = laneBands(nodes)
    expect(bands.map((b) => b.lane)).toEqual(['i0', 'i1'])
    expect(bands[0]!.top + bands[0]!.height).toBeLessThanOrEqual(bands[1]!.top)
  })

  it('never moves already placed nodes and puts a new task next to its dependency', async () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b', deps: ['a'] }), makeTask({ id: 'c', deps: ['a'] })]
    const first = await layoutGraph(tasks)
    const next = await layoutGraph([...tasks, makeTask({ id: 'n', deps: ['b'] })], first)
    for (const id of ['a', 'b', 'c']) {
      expect(next.get(id)).toMatchObject({ x: first.get(id)?.x, y: first.get(id)?.y })
    }
    expect(next.get('n')?.x ?? 0).toBeGreaterThan(next.get('b')?.x ?? 0)
  })
})
