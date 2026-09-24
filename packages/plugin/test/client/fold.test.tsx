// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { decideFolds, foldGraph, readManualFolds, writeManualFold } from '../../src/client/fold.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { layoutFoldStack, NODE_H, NODE_W } from '../../src/client/views/graph/layout.js'
import { BoardView } from '../../src/client/views/board.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

const now = new Date('2026-09-22T12:00:00Z')
const old = '2026-09-21T12:00:00Z'
const finished = (lane: string, n: number) => Array.from({ length: n }, (_, i) => makeTask({ id: `${lane}${i + 1}`, lane, status: 'accepted', acceptedAt: old }))
const live = (n: number) => Array.from({ length: n }, (_, i) => makeTask({ id: `k${i + 1}`, lane: 'Работа', status: 'ready' }))
const repo = (tasks: ReturnType<typeof makeTask>[]) => makeRepo(tasks, [], { planId: 'plan-a' })

afterEach(() => { cleanup(); localStorage.clear() })

it('only auto folds a finished lane of at least five in a plan larger than 24', () => {
  expect(decideFolds(repo([...finished('2F', 6), ...live(6)]), {}, now).folded.size).toBe(0)
  expect(decideFolds(repo([...finished('2F', 6), ...live(34)]), {}, now).folded.has('2F')).toBe(true)
  expect(decideFolds(repo([...finished('2F', 3), ...live(37)]), {}, now).folded.size).toBe(0)
})

it('keeps live and freshly accepted lanes open; folds old finished lanes', () => {
  const tasks = [...finished('Идёт', 6), ...finished('Свежая', 6), ...finished('Готова', 6), ...live(22)]
  tasks[0] = { ...tasks[0]!, status: 'running' }
  tasks[6] = { ...tasks[6]!, acceptedAt: '2026-09-22T10:00:00Z' }
  const decision = decideFolds(repo(tasks), {}, now)
  expect(decision.folded.has('Идёт')).toBe(false)
  expect(decision.folded.has('Свежая')).toBe(false)
  expect(decision.folded.has('Готова')).toBe(true)
})

it('keeps a cross-lane guest and transfers its edge to the lane node', () => {
  const tasks = [...finished('2F', 6), ...live(34)]
  tasks[6] = { ...tasks[6]!, id: 'k2', deps: ['2F3'] }
  const source = repo(tasks)
  const decision = decideFolds(source, {}, now)
  const graph = foldGraph(source, decision)
  expect(decision.guests.get('2F')).toContain('2F3')
  expect(graph.nodes.map((n) => n.id)).toContain('2F3')
  expect(graph.nodes.map((n) => n.id)).toContain('lane:2F')
  expect(graph.nodes.map((n) => n.id)).not.toContain('2F1')
  expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'lane:2F', to: 'k2' }))
})

it('coalesces links between folded lanes and leaves wide guest lanes open', () => {
  const tasks = [...finished('Первый', 6), ...finished('Второй', 6), ...live(28)]
  tasks[6] = { ...tasks[6]!, deps: ['Первый1', 'Первый2', 'Первый3'] }
  const source = repo(tasks)
  const decision = decideFolds(source, {}, now)
  expect(decision.folded.has('Первый')).toBe(true)
  expect(decision.folded.has('Второй')).toBe(true)
  expect(foldGraph(source, decision).edges).toContainEqual(expect.objectContaining({ from: 'lane:Первый', to: 'lane:Второй', count: 3 }))
  // Links between two finished lanes are not guests: nobody is waiting on them any more.
  expect(decision.guests.get('Первый') ?? []).toEqual([])
})

it('only a live neighbour pulls a task out of a folded lane, and at most two', () => {
  const tasks = [...finished('Готова', 6), ...live(34)]
  // Three live tasks depend on three tasks of the folded lane — only two stay visible as guests.
  tasks[6] = { ...tasks[6]!, deps: ['Готова1'] }
  tasks[7] = { ...tasks[7]!, deps: ['Готова2'] }
  tasks[8] = { ...tasks[8]!, deps: ['Готова3'] }
  const decision = decideFolds(repo(tasks), {}, now)
  expect(decision.folded.has('Готова')).toBe(true)
  expect(decision.guests.get('Готова')).toEqual(['Готова1', 'Готова2'])
})

it('folding by hand hides the whole lane — guests included', () => {
  const tasks = [...finished('Готова', 6), ...live(34)]
  tasks[6] = { ...tasks[6]!, deps: ['Готова1'] }
  const source = repo(tasks)
  const decision = decideFolds(source, { Готова: true }, now)
  expect(decision.folded.has('Готова')).toBe(true)
  expect(decision.guests.get('Готова')).toEqual([])
  expect(foldGraph(source, decision).nodes.some((node) => node.task?.id === 'Готова1')).toBe(false)
})

it('retires a manual choice when a new task joins that lane', () => {
  const source = repo([...finished('Готова', 6), ...live(34)])
  writeManualFold(source, 'Готова', false)
  expect(readManualFolds(source).Готова).toBe(false)
  expect(readManualFolds(repo([...source.tasks, makeTask({ id: 'new', lane: 'Готова', status: 'accepted', acceptedAt: old })])).Готова).toBeUndefined()
})

it('shows a folded lane summary and its connected guest on the board', () => {
  setLang('ru')
  const tasks = [...finished('Готова', 6), ...live(34)]
  tasks[6] = { ...tasks[6]!, deps: ['Готова3'] }
  render(<BoardView repo={repo(tasks)} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(screen.getByRole('button', { name: 'Развернуть дорожку Готова' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Задача Готова3/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Задача Готова1/ })).toBeNull()
})

it('retains manual choices across recalculation and remount; manual fold works below thresholds', async () => {
  setLang('ru')
  installMatchMedia(true)
  const user = userEvent.setup()
  const source = repo([...finished('Готова', 6), ...live(34)])
  const view = render(<GraphView repo={source} selectedId={null} onSelect={() => {}} density="overview" />)
  await user.click(await screen.findByRole('button', { name: /Развернуть дорожку Готова/ }))
  expect(screen.queryByRole('button', { name: /Развернуть дорожку Готова/ })).toBeNull()
  view.unmount()
  render(<GraphView repo={source} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(screen.queryByRole('button', { name: /Развернуть дорожку Готова/ })).toBeNull()
  const small = repo([...finished('Малая', 3), ...live(9)])
  cleanup()
  render(<GraphView repo={small} selectedId={null} onSelect={() => {}} density="overview" />)
  await user.click(await screen.findByRole('button', { name: /Свернуть дорожку Малая/ }))
  expect(await screen.findByRole('button', { name: /Развернуть дорожку Малая/ })).toBeTruthy()
})

it('reserves nonintersecting rectangles for three folded lanes, guests, two open lanes and their labels', () => {
  const tasks = [...finished('1A', 6), ...finished('2A', 6), ...finished('3A', 6),
    ...Array.from({ length: 5 }, (_, i) => makeTask({ id: `q${i}`, lane: 'Открыта 1', status: 'ready' })),
    ...Array.from({ length: 5 }, (_, i) => makeTask({ id: `r${i}`, lane: 'Открыта 2', status: 'ready' }))]
  tasks[18] = { ...tasks[18]!, deps: ['1A2', '2A3', '3A4'] }
  const source = repo(tasks)
  const decision = decideFolds(source, { '1A': true, '2A': true, '3A': true }, now)
  const graph = foldGraph(source, decision)
  const graphTasks = graph.nodes.map((node) => node.task ?? makeTask({ id: node.id, lane: node.lane }))
  const { nodes, bands } = layoutFoldStack(graphTasks, decision.folded)
  const rects = graph.nodes.map((node) => {
    const pos = nodes.get(node.id)!
    return { id: node.id, x: pos.x, y: pos.y, w: NODE_W, h: node.task ? NODE_H : 56 }
  })
  const laneLeft = Math.min(...[...nodes.values()].map((pos) => pos.x)) - 12
  for (const band of bands.filter((item) => !item.folded && item.lane)) rects.push({ id: `label:${band.lane}`, x: laneLeft, y: band.top + 4, w: 205, h: 20 })
  for (const [i, a] of rects.entries()) for (const b of rects.slice(i + 1)) {
    expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`).toBe(true)
  }
})
