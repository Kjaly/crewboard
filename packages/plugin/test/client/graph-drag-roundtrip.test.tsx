// @vitest-environment jsdom
// graph-drag-roundtrip-29: the graph camera pose is remembered per physical plan and restored on a return.
// The return must land on a finite transform and the blank canvas must still pan afterwards. The restore
// used a zero spring response, which divided by zero and poisoned the camera: the browser rejects the
// resulting invalid CSS transform, so the world keeps a stale matrix and every later gesture is dropped.
// This test drives the real DOM pointer/wheel path through A -> B -> A and reads `.orc-gworld`.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { resetSessionMemory } from '../../src/client/store.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

beforeEach(() => {
  setLang('en')
  installMatchMedia(false)
  resetSessionMemory()
})
afterEach(() => cleanup())

/** Let the frame loop and the deferred camera work run for `n` real animation frames. */
const frames = (n: number) =>
  act(
    () =>
      new Promise<void>((resolve) => {
        let left = n
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
  )

const plan = (root: string, title: string) =>
  makeRepo(
    [
      makeTask({ id: 'a', title, status: 'running', lane: 'Build' }),
      makeTask({ id: 'b', title: `${title} next`, deps: ['a'], lane: 'Build' }),
    ],
    [],
    { root, planId: 'main' },
  )

const world = (container: HTMLElement): HTMLElement => container.querySelector('.orc-gworld') as HTMLElement
const transform = (container: HTMLElement): string => world(container).style.transform

/** A real left-button drag on the blank canvas, through down/move/up, released without a flick. */
const drag = async (canvas: HTMLElement, fx: number, fy: number, tx: number, ty: number) => {
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: fx, clientY: fy })
  fireEvent.pointerMove(canvas, { pointerId: 7, clientX: tx, clientY: ty })
  // Release well after the last move so no coast is attributed: the pose under test is the one already
  // on screen, not an in-flight projection.
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 130)))
  fireEvent.pointerUp(canvas, { pointerId: 7, clientX: tx, clientY: ty })
}

it('keeps panning after leaving a project and returning to it (A -> B -> A)', async () => {
  const alpha = plan('/repo-a', 'Alpha')
  const beta = plan('/repo-b', 'Beta')

  // A: pan the blank canvas so the camera is touched and the plan remembers a claimed pose.
  const first = render(<GraphView repo={alpha} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /^Alpha ·/ })
  await frames(3)
  const canvasA = first.container.querySelector('.orc-graph') as HTMLElement
  const started = transform(first.container)
  expect(started).not.toBe('')
  await drag(canvasA, 300, 300, 180, 200)
  await frames(60)
  const claimed = transform(first.container)
  // The physical drag really moved the world.
  expect(claimed).not.toBe(started)
  expect(claimed).not.toContain('NaN')
  first.unmount()

  // B: a different physical project. It has no camera memory and must not disturb A's.
  const middle = render(<GraphView repo={beta} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /^Beta ·/ })
  await frames(3)
  middle.unmount()

  // A again: the remembered pose is restored...
  const back = render(<GraphView repo={alpha} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /^Alpha ·/ })
  await frames(60)
  const restored = transform(back.container)
  expect(restored).not.toBe('')
  expect(restored).not.toContain('NaN')
  // ...and it is the pose the reader claimed, not a fresh fit and not a stale matrix.
  expect(restored).toBe(claimed)

  // The blank canvas still pans from the restored pose — pointer and wheel both keep working.
  const canvasBack = back.container.querySelector('.orc-graph') as HTMLElement
  await drag(canvasBack, 400, 300, 460, 360)
  await frames(10)
  const panned = transform(back.container)
  expect(panned).not.toContain('NaN')
  expect(panned).not.toBe(restored)

  fireEvent.wheel(canvasBack, { deltaX: -40, deltaY: -30 })
  await frames(10)
  const wheeled = transform(back.container)
  expect(wheeled).not.toContain('NaN')
  expect(wheeled).not.toBe(panned)
})
