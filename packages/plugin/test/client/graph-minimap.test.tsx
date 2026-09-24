// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createCamera } from '../../src/client/views/graph/camera.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { MAP_H, MAP_W, mapProjection } from '../../src/client/views/graph/minimap.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())

const repo = makeRepo([
  makeTask({ id: 'a', title: 'Первая задача', status: 'accepted' }),
  makeTask({ id: 'b', title: 'Вторая задача', status: 'running', deps: ['a'] }),
  makeTask({ id: 'c', title: 'Третья задача', deps: ['b'] }),
])

it('maps the whole plan into the minimap box without upscaling it', () => {
  const p = mapProjection({ minX: 0, minY: 0, maxX: 2000, maxY: 1200 })
  expect(p.scale).toBeLessThan(1)
  expect(2000 * p.scale + p.dx).toBeLessThanOrEqual(MAP_W)
  expect(1200 * p.scale + p.dy).toBeLessThanOrEqual(MAP_H)
  expect(mapProjection({ minX: 0, minY: 0, maxX: 10, maxY: 10 }).scale).toBe(1)
})

it('draws a card per task and a frame for the visible area', async () => {
  setLang('ru')
  installMatchMedia(true)
  const { container } = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /Вторая задача/ })

  const map = screen.getByLabelText('Миникарта плана')
  expect(map.querySelectorAll('.orc-gmap__node')).toHaveLength(3)
  const frame = container.querySelector<HTMLElement>('.orc-gmap__frame')
  expect(frame).not.toBeNull()
  await waitFor(() => expect(Number.parseFloat(frame?.style.width ?? '0')).toBeGreaterThan(0))
})

it('moves the camera when the frame is dragged across the map', async () => {
  setLang('ru')
  installMatchMedia(true)
  const { container } = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /Вторая задача/ })

  const world = container.querySelector<HTMLElement>('.orc-gworld')
  const map = screen.getByLabelText('Миникарта плана')
  await waitFor(() => expect(world?.style.transform).toBeTruthy())
  const before = world?.style.transform

  const options = { bubbles: true, clientX: MAP_W - 4, clientY: MAP_H - 4, button: 0, buttons: 1 }
  map.dispatchEvent(new window.PointerEvent('pointerdown', options))
  map.dispatchEvent(new window.PointerEvent('pointermove', options))
  map.dispatchEvent(new window.PointerEvent('pointerup', { ...options, buttons: 0 }))

  await waitFor(() => expect(world?.style.transform).not.toBe(before))
})

it('keeps the camera inside the plan when the minimap is dragged past its edge', () => {
  const camera = createCamera()
  camera.setViewport(900, 500)
  camera.setContent({ minX: 0, minY: 0, maxX: 1200, maxY: 800 })
  camera.centerOn(100_000, 100_000, true)
  const view = camera.viewBox()
  expect(view.minX).toBeLessThan(1200)
  expect(view.minY).toBeLessThan(800)
})
