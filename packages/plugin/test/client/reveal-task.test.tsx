// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { App } from '../../src/client/app.js'
import { readManualFolds } from '../../src/client/fold.js'
import { setLang } from '../../src/client/i18n.js'
import { formatRoute } from '../../src/client/route.js'
import { RepoSidebar } from '../../src/client/sidebar.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { createCamera } from '../../src/client/views/graph/camera.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { NODE_H, NODE_W } from '../../src/client/views/graph/layout.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, installMatchMedia, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

beforeEach(() => { setLang('en'); localStorage.clear(); installMatchMedia(true) })
afterEach(() => { cleanup(); resetOrchestraStore(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks() })

const frames = (n: number) => act(() => new Promise<void>((resolve) => {
  let left = n
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
}))

/** 30 tasks: the finished lanes (Decisions, Old, Tiny) fold onto one shelf under the live ones. */
function plan(): TaskSnapshot[] {
  const lane = (name: string, n: number, status: TaskSnapshot['status']) =>
    Array.from({ length: n }, (_, i) => makeTask({ id: `${name}-${i}`, title: `${name} ${i}`, lane: name, status, deps: i ? [`${name}-${i - 1}`] : [] }))
  return [
    makeTask({ id: 'dec', title: 'Choose', kind: 'decision', status: 'accepted' }),
    ...lane('Old', 6, 'accepted'),
    ...lane('Tiny', 1, 'accepted'),
    ...lane('Quiet', 8, 'blocked'),
    ...lane('Busy', 8, 'running'),
    ...lane('Review', 6, 'in_review'),
  ]
}

const nodeAt = (button: HTMLElement) => {
  const [, x, y] = button.parentElement!.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!.map(Number)
  return { x: x + NODE_W / 2, y: y + NODE_H / 2 }
}
const centreOf = (camera: ReturnType<typeof createCamera>) => {
  const box = camera.viewBox()
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
}

it('going to a task in a folded lane unfolds the lane, remembers it, selects and centres the task', async () => {
  const camera = createCamera()
  const repo = makeRepo(plan())
  const props = { repo, onSelect: () => {}, density: 'overview' as const, camera }
  const { rerender } = render(<GraphView {...props} selectedId={null} />)
  await screen.findByRole('button', { name: 'Expand lane Old' }, { timeout: 10_000 })
  expect(screen.queryByRole('button', { name: /^Old 3/ })).toBeNull()

  rerender(<GraphView {...props} selectedId="Old-3" />)
  const node = await screen.findByRole('button', { name: /^Old 3/ }, { timeout: 10_000 })
  expect(node.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Expand lane Old' })).toBeNull()
  expect(readManualFolds(repo)).toMatchObject({ Old: false })
  await frames(6)
  // Centred across; down, the pan limit may hold a bottom lane short of the middle — but in view.
  await waitFor(() => {
    const spot = nodeAt(screen.getByRole('button', { name: /^Old 3/ }))
    const view = camera.viewBox()
    expect(Math.abs(centreOf(camera).x - spot.x)).toBeLessThan(2)
    expect(spot.y - NODE_H / 2).toBeGreaterThanOrEqual(view.minY)
    expect(spot.y + NODE_H / 2).toBeLessThanOrEqual(view.maxY)
  })

  // Folding the lane again by hand keeps the selection and stays folded across later snapshots.
  fireEvent.click(screen.getByRole('button', { name: 'Collapse lane Old' }))
  await screen.findByRole('button', { name: 'Expand lane Old' })
  rerender(<GraphView {...props} repo={makeRepo(plan())} selectedId="Old-3" />)
  await frames(3)
  expect(screen.getByRole('button', { name: 'Expand lane Old' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Old 3/ })).toBeNull()
})

it('a task on the History shelf is brought out of it the same way', async () => {
  const repo = makeRepo(plan())
  // A direct focus request (a row jump) is explicit; a merely restored selection would be adopted instead.
  render(<GraphView repo={repo} selectedId="Tiny-0" focus={{ task: 'Tiny-0', seq: 1 }} onSelect={() => {}} density="overview" />)
  const node = await screen.findByRole('button', { name: /^Tiny 0/ }, { timeout: 10_000 })
  expect(node.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Expand lane Tiny' })).toBeNull()
  // The rest of the shelf stays folded.
  expect(screen.getByRole('button', { name: 'Expand lane Old' })).toBeTruthy()
})

it('a click on a node the reader already sees does not move the camera', async () => {
  const camera = createCamera()
  const onSelect = vi.fn()
  const repo = makeRepo(plan())
  const { rerender } = render(<GraphView repo={repo} selectedId={null} onSelect={onSelect} density="overview" camera={camera} />)
  const node = await screen.findByRole('button', { name: /^Quiet 5/ }, { timeout: 10_000 })
  await frames(10)
  const before = centreOf(camera)
  fireEvent.click(node)
  expect(onSelect).toHaveBeenCalledWith('Quiet-5')
  rerender(<GraphView repo={repo} selectedId="Quiet-5" onSelect={onSelect} density="overview" camera={camera} />)
  await frames(10)
  expect(centreOf(camera)).toEqual(before)
})

it('the sidebar tree opens the History group, tail included, that holds the selected task', () => {
  const tasks = [
    ...Array.from({ length: 14 }, (_, i) => makeTask({ id: `h${i}`, lane: `Past ${String(i).padStart(2, '0')}`, status: 'accepted' })),
    makeTask({ id: 'live', lane: 'Live', status: 'running' }),
  ]
  const repo = makeRepo(tasks, [], { planId: 'main' })
  installFetch(() => jsonOk(null))
  const lanes = { highlight: null, onPick: () => {}, link: (lane: string) => `#${lane}` }
  const { rerender } = render(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={lanes} />)
  const history = () => screen.getByRole('treeitem', { name: /^History/ })
  expect(history().getAttribute('aria-expanded')).toBe('false')
  rerender(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={{ ...lanes, selected: 'h13' }} />)
  expect(history().getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('treeitem', { name: /^Past 13/ })).toBeTruthy()
  // Folding it again by hand keeps it folded while the selection stands.
  fireEvent.click(history())
  rerender(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={{ ...lanes, selected: 'h13' }} />)
  expect(history().getAttribute('aria-expanded')).toBe('false')
})

it('a link to a task in a folded lane opens with the lane unfolded and the task selected', async () => {
  const snapshot = makeSnapshot(makeRepo(plan()))
  window.history.replaceState(null, '', formatRoute({ repo: ROOT, plan: '_', view: 'graph', task: 'Old-2' }))
  orchestraStore.startRouting()
  installEventSource()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'Old-2' })) : jsonOk(snapshot)))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  const node = await screen.findByRole('button', { name: /^Old 2/ }, { timeout: 10_000 })
  expect(node.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Expand lane Old' })).toBeNull()
  expect(screen.getByRole('treeitem', { name: /^History/ }).getAttribute('aria-expanded')).toBe('true')
})
