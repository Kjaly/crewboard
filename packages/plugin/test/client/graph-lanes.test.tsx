// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { setLang } from '../../src/client/i18n.js'
import { createCamera } from '../../src/client/views/graph/camera.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

beforeEach(() => { setLang('en'); localStorage.clear(); installMatchMedia(true) })
afterEach(() => cleanup())

const frames = (n: number) => act(() => new Promise<void>((resolve) => {
  let left = n
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
}))

/** 30 tasks: finished lanes of 1 and 6 tasks on top in plan order, live lanes below, decisions all closed. */
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

const laneHeads = (container: HTMLElement) => [...container.querySelectorAll('.orc-glane__head b')].map((el) => el.textContent)
const box = (camera: ReturnType<typeof createCamera>) => camera.viewBox()

it('stacks live lanes first and folds every finished lane, the closed Decisions band included', async () => {
  const { container } = render(<GraphView repo={makeRepo(plan())} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /^Busy 0/ }, { timeout: 10_000 })
  // Waiting for the person, then running, then the rest; the finished lanes fold into chips below.
  expect(laneHeads(container)).toEqual(['Review', 'Busy', 'Quiet'])
  expect(screen.getByRole('button', { name: 'Expand lane Tiny' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Expand lane Old' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Expand lane Decisions' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Old 0/ })).toBeNull()
})

it('flies the camera to a lane picked in the tree and reports the lane in view', async () => {
  const camera = createCamera()
  const onLaneInView = vi.fn()
  const repo = makeRepo(plan())
  const { rerender } = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" camera={camera} lane={{ lane: 'Quiet', seq: 1 }} onLaneInView={onLaneInView} />)
  const quiet = await screen.findByRole('button', { name: /^Quiet 0/ }, { timeout: 10_000 })
  await frames(4)
  const band = (quiet.closest('.orc-gworld') as HTMLElement).querySelectorAll('.orc-glane')[2] as HTMLElement
  const top = Number.parseFloat(band.style.top)
  const bottom = top + Number.parseFloat(band.style.height)
  // The whole band is in view, centred: a short lane sits in the middle, its neighbours around it.
  await waitFor(() => expect(box(camera).minY).toBeLessThan(top))
  expect(box(camera).maxY).toBeGreaterThan(bottom)
  expect(Math.abs((box(camera).minY + box(camera).maxY) / 2 - (top + bottom) / 2)).toBeLessThan(2)
  await waitFor(() => expect(onLaneInView).toHaveBeenLastCalledWith('Quiet'))

  // A second pick flies again, a repeat of the same seq does not.
  rerender(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" camera={camera} lane={{ lane: 'Review', seq: 2 }} onLaneInView={onLaneInView} />)
  await frames(4)
  await waitFor(() => expect(onLaneInView).toHaveBeenLastCalledWith('Review'))
  expect(box(camera).minY).toBeLessThan(top)

  // A folded lane is framed at its chip; the highlight follows the camera, whoever moved it.
  rerender(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" camera={camera} lane={{ lane: 'Tiny', seq: 3 }} onLaneInView={onLaneInView} />)
  await frames(4)
  await waitFor(() => expect(onLaneInView).toHaveBeenLastCalledWith('Tiny'))
  act(() => camera.fit(true))
  await frames(3)
  expect(onLaneInView).not.toHaveBeenLastCalledWith('Tiny')
})

it('opens on the lane from the route instead of the live work', async () => {
  const camera = createCamera()
  render(<GraphView repo={makeRepo(plan())} selectedId={null} onSelect={() => {}} density="overview" camera={camera} lane={{ lane: 'Quiet', seq: 7 }} />)
  const quiet = await screen.findByRole('button', { name: /^Quiet 0/ }, { timeout: 10_000 })
  await frames(6)
  const rect = quiet.parentElement!.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!
  const y = Number(rect[2])
  const view = box(camera)
  expect(y).toBeGreaterThanOrEqual(view.minY)
  expect(y).toBeLessThanOrEqual(view.maxY)
  expect(camera.touched).toBe(true)
})
