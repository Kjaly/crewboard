// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readManualFolds, writeManualFold } from '../../src/client/fold.js'
import { setLang } from '../../src/client/i18n.js'
import { createCamera } from '../../src/client/views/graph/camera.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

/**
 * mm1: the minimap in the corner names the live lanes, dims History and folded lanes, marks the
 * selected task's lane, and a click on a label scrolls to (and unfolds) it.
 */

beforeEach(() => { setLang('en'); localStorage.clear(); installMatchMedia(true) })
afterEach(() => cleanup())

const frames = (n: number) => act(() => new Promise<void>((resolve) => {
  let left = n
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
}))

const mapLabels = (container: HTMLElement) => [...container.querySelectorAll('.orc-gmap__label')].map((el) => el.textContent)

it('labels the live lanes on the minimap, short and by name', async () => {
  const repo = makeRepo([
    makeTask({ id: 'a', title: 'Alpha', lane: 'Build', status: 'ready' }),
    makeTask({ id: 'b', title: 'Beta', lane: 'Ship', status: 'running' }),
  ])
  const { container } = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /Alpha/ })
  await frames(3)
  expect(mapLabels(container)).toEqual(expect.arrayContaining(['Build', 'Ship']))
})

it('dims a finished lane and drops its label — unless it holds the selected task', async () => {
  const repo = makeRepo([
    makeTask({ id: 'a', title: 'Alpha', lane: 'Build', status: 'ready' }),
    makeTask({ id: 'h', title: 'Old work', lane: 'Old', status: 'accepted' }),
  ])
  const { container, rerender } = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /Alpha/ })
  await frames(3)
  expect(mapLabels(container)).toEqual(['Build'])
  expect(container.querySelector('.orc-gmap__node--dim')).toBeTruthy()

  rerender(<GraphView repo={repo} selectedId="h" onSelect={() => {}} density="overview" />)
  await frames(3)
  expect(mapLabels(container)).toEqual(expect.arrayContaining(['Build', 'Old']))
})

it('a click on a lane label unfolds the lane and scrolls the canvas there', async () => {
  const build = Array.from({ length: 3 }, (_, i) => makeTask({ id: `b${i}`, title: `Build ${i}`, lane: 'Build', status: 'ready', deps: i ? [`b${i - 1}`] : [] }))
  const repo = makeRepo([...build, makeTask({ id: 's0', title: 'Ship 0', lane: 'Ship', status: 'ready' })])
  writeManualFold(repo, 'Build', true)
  const camera = createCamera()
  render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" camera={camera} />)
  await screen.findByRole('button', { name: 'Expand lane Build' })
  await frames(3)

  fireEvent.click(screen.getByRole('button', { name: 'Go to lane Build' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Expand lane Build' })).toBeNull())
  expect(readManualFolds(repo)).toMatchObject({ Build: false })
  const card = await screen.findByRole('button', { name: /Build 0/ })
  await frames(6)
  const [, , y] = card.parentElement!.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!.map(Number)
  const view = camera.viewBox()
  expect(y).toBeGreaterThanOrEqual(view.minY)
  expect(y).toBeLessThanOrEqual(view.maxY)
})

it('keeps a pinned card inside its own lane when a lane above it folds', async () => {
  const above = Array.from({ length: 4 }, (_, i) => makeTask({ id: `a${i}`, title: `Above ${i}`, lane: 'Above', status: 'ready', deps: i ? [`a${i - 1}`] : [] }))
  const pinned = makeTask({ id: 'p', title: 'Pinned card', lane: 'Below', status: 'ready', pos: { x: 0, y: 40 } })
  const repo = makeRepo([...above, pinned])
  render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /Pinned card/ })
  await frames(6)

  fireEvent.click(screen.getByRole('button', { name: 'Collapse lane Above' }))
  await screen.findByRole('button', { name: 'Expand lane Above' })
  await frames(6)

  const foldedBand = [...document.querySelectorAll('.orc-glane')].find((el) => !el.querySelector('.orc-glane__head')) as HTMLElement
  const foldedBottom = Number.parseFloat(foldedBand.style.top) + Number.parseFloat(foldedBand.style.height)
  const card = screen.getByRole('button', { name: /Pinned card/ })
  const [, , y] = card.parentElement!.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!.map(Number)
  expect(y).toBeGreaterThanOrEqual(foldedBottom)
})
