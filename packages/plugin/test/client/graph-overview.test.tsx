// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { DETAIL_SCALE, LABEL_GUTTER, OVERVIEW_PADDING, createCamera, detailLevel, zoomFloor } from '../../src/client/views/graph/camera.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { LABEL_STEP, placeLaneLabels } from '../../src/client/views/graph/lane-labels.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

beforeEach(() => setLang('en'))
afterEach(() => cleanup())

const viewport = { width: 1000, height: 600 }
const run = (c: ReturnType<typeof createCamera>) => {
  for (let i = 0; i < 600 && c.step(1 / 60, false); i += 1) {}
}
const frames = (n: number) => act(() => new Promise<void>((resolve) => {
  let left = n
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
}))

/** ~150 tasks in 30 lanes, five per lane chained left to right — the shape of the owner's plan. */
function bigPlan(): TaskSnapshot[] {
  const statuses = ['accepted', 'running', 'in_review', 'ready', 'backlog'] as const
  return Array.from({ length: 150 }, (_, i) => {
    const lane = Math.floor(i / 5)
    const step = i % 5
    return makeTask({ id: `t${i}`, title: `Task ${i}`, lane: `Lane ${lane}`, status: statuses[step], worker: 'dsh', deps: step > 0 ? [`t${i - 1}`] : [] })
  })
}

describe('zoom-out floor', () => {
  it('lets a large plan zoom out until all of it fits with a margin', () => {
    const box = { minX: 0, minY: 0, maxX: 6000, maxY: 4000 }
    const floor = zoomFloor(box, viewport)
    expect(floor).toBeCloseTo(Math.min((1000 - OVERVIEW_PADDING * 2 - LABEL_GUTTER) / 6000, (600 - OVERVIEW_PADDING * 2) / 4000), 6)
    expect(floor).toBeLessThan(0.35)

    const c = createCamera()
    c.setViewport(viewport.width, viewport.height)
    c.setContent(box)
    for (let i = 0; i < 80; i += 1) c.zoomAt(500, 300, 0.8)
    expect(c.scale).toBeCloseTo(floor, 6)
    const view = c.viewBox()
    expect(view.maxX - view.minX).toBeGreaterThanOrEqual(6000)
    expect(view.maxY - view.minY).toBeGreaterThanOrEqual(4000)
  })

  it('keeps 0.35 as the floor for a small plan and 0.05 for an enormous one', () => {
    expect(zoomFloor({ minX: 0, minY: 0, maxX: 800, maxY: 400 }, viewport)).toBe(0.35)
    expect(zoomFloor({ minX: 0, minY: 0, maxX: 200_000, maxY: 400 }, viewport)).toBe(0.05)
  })

  it('moves the floor with the viewport and the plan', () => {
    const c = createCamera()
    c.setViewport(1000, 600)
    c.setContent({ minX: 0, minY: 0, maxX: 6000, maxY: 1000 })
    const wide = c.minScale
    c.setViewport(2000, 600)
    expect(c.minScale).toBeGreaterThan(wide)
    c.setContent({ minX: 0, minY: 0, maxX: 600, maxY: 300 })
    expect(c.minScale).toBe(0.35)
  })
})

describe('overview', () => {
  it('frames the whole content box whatever the readability', () => {
    const c = createCamera()
    c.setViewport(viewport.width, viewport.height)
    const box = { minX: -40, minY: 0, maxX: 5200, maxY: 3900 }
    c.setContent(box)
    c.overview(false)
    run(c)
    const view = c.viewBox()
    expect(view.minX).toBeLessThanOrEqual(box.minX)
    expect(view.minY).toBeLessThanOrEqual(box.minY)
    expect(view.maxX).toBeGreaterThanOrEqual(box.maxX)
    expect(view.maxY).toBeGreaterThanOrEqual(box.maxY)
    expect(c.scale).toBeLessThan(DETAIL_SCALE)
    expect(c.touched).toBe(false)
  })

  it('does not upscale a plan that already fits', () => {
    const c = createCamera()
    c.setViewport(viewport.width, viewport.height)
    c.setContent({ minX: 0, minY: 0, maxX: 300, maxY: 200 })
    c.overview(true)
    expect(c.scale).toBe(1)
  })

  it('repeats Overview, not Fit, when an untouched camera is re-framed', () => {
    const c = createCamera()
    c.setViewport(viewport.width, viewport.height)
    c.setContent({ minX: 0, minY: 0, maxX: 6000, maxY: 4000 })
    c.overview(true)
    const before = c.scale
    c.setViewport(1400, 800)
    c.refit(true)
    expect(c.scale).toBeGreaterThan(before)
    expect(c.scale).toBeLessThan(DETAIL_SCALE)
  })
})

describe('level of detail', () => {
  it('switches at the threshold with a little hysteresis', () => {
    expect(detailLevel(DETAIL_SCALE + 0.05)).toBe('near')
    expect(detailLevel(DETAIL_SCALE - 0.05)).toBe('far')
    // Resting right on the threshold keeps whichever level is on screen.
    expect(detailLevel(DETAIL_SCALE, 'near')).toBe('near')
    expect(detailLevel(DETAIL_SCALE, 'far')).toBe('far')
  })
})

describe('lane names in the far view', () => {
  const bands = Array.from({ length: 6 }, (_, i) => ({ top: i * 100, height: 100 }))

  it('sit in the gutter left of the plan, centred on their lane', () => {
    const places = placeLaneLabels(bands, 0, { x: 300, y: 20, scale: 0.5 })
    expect(places.every((p) => p.shown)).toBe(true)
    expect(places[0]).toMatchObject({ x: 300 - LABEL_GUTTER + 8, y: 20 + 25 })
  })

  it('stay pinned to the canvas edge when the plan is panned past it', () => {
    expect(placeLaneLabels(bands, 0, { x: -900, y: 0, scale: 0.5 })[0].x).toBe(8)
  })

  it('drop a name that would sit on the one above it', () => {
    const places = placeLaneLabels(bands, 0, { x: 300, y: 0, scale: 0.1 })
    const shown = places.filter((p) => p.shown)
    expect(shown.length).toBeLessThan(places.length)
    for (let i = 1; i < shown.length; i += 1) expect(shown[i].y - shown[i - 1].y).toBeGreaterThanOrEqual(LABEL_STEP)
  })
})

describe('graph far view', () => {
  const repo = makeRepo([
    makeTask({ id: 'a', title: 'First task', status: 'accepted', lane: 'Build' }),
    makeTask({ id: 'b', title: 'Second task', status: 'running', worker: 'dsh', deps: ['a'], lane: 'Build' }),
    makeTask({ id: 'c', title: 'Third task', deps: ['b'], lane: 'Ship' }),
  ], [], { criticalPath: ['a', 'b', 'c'] })

  it('turns cards into state-coloured blocks, shows lane names and fades other edges below the threshold', async () => {
    installMatchMedia(true)
    const camera = createCamera()
    const { container } = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" camera={camera} />)
    const card = await screen.findByRole('button', { name: /Second task/ })
    const graph = container.querySelector('.orc-graph') as HTMLElement
    expect(graph.classList.contains('orc-graph--far')).toBe(false)
    expect(card.getAttribute('title')).toBeTruthy()

    act(() => camera.zoomAt(480, 300, 0.01))
    await waitFor(() => expect(graph.classList.contains('orc-graph--far')).toBe(true))
    // Same card, same place: the switch restyles, it never remounts or resizes anything.
    expect(screen.getByRole('button', { name: /Second task/ })).toBe(card)
    expect(card.parentElement?.style.getPropertyValue('--orc-tone')).toBe('var(--orc-accent-strong)')
    // The class flips in the frame; the state behind titles and the hover card follows as a transition.
    await waitFor(() => expect(card.getAttribute('title')).toBeNull())
    const labels = [...container.querySelectorAll('.orc-glabel')].map((el) => el.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Build', 'Ship']))
    await waitFor(() => expect((container.querySelector('.orc-glabel') as HTMLElement).style.transform).toMatch(/^translate\(/))
    expect(container.querySelectorAll('.orc-gedge--crit')).toHaveLength(2)

    act(() => camera.zoomAt(480, 300, 4))
    await waitFor(() => expect(graph.classList.contains('orc-graph--far')).toBe(false))
    await waitFor(() => expect(card.getAttribute('title')).toBeTruthy())
  })

  it('names the hovered block in a tooltip and flies to it on click', async () => {
    installMatchMedia(true)
    const camera = createCamera()
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { container } = render(<GraphView repo={repo} selectedId={null} onSelect={onSelect} density="overview" camera={camera} />)
    const card = await screen.findByRole('button', { name: /Second task/ })
    act(() => camera.zoomAt(480, 300, 0.01))
    await waitFor(() => expect(card.getAttribute('title')).toBeNull())

    fireEvent.pointerEnter(card)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toContain('b')
    expect(tip.textContent).toContain('Second task')
    expect(tip.textContent).toContain('DeepSeek V4 Flash')
    expect(card.getAttribute('aria-describedby')).toBe(tip.id)

    await user.click(card)
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(camera.scale).toBe(1)
    await waitFor(() => expect(container.querySelector('.orc-graph--far')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('frames the whole plan from the Overview button and the O key', async () => {
    installMatchMedia(true)
    const camera = createCamera()
    const user = userEvent.setup()
    render(<GraphView repo={makeRepo(bigPlan())} selectedId={null} onSelect={() => {}} density="overview" camera={camera} />)
    await screen.findByRole('button', { name: /Task 149\b/ })
    await user.click(screen.getByRole('button', { name: 'Overview (O)' }))
    expect(camera.scale).toBeCloseTo(camera.minScale, 6)
    expect(camera.scale).toBeLessThan(DETAIL_SCALE)

    act(() => camera.fit(true))
    expect(camera.scale).toBeGreaterThan(DETAIL_SCALE)
    ;(screen.getByRole('button', { name: /Task 149\b/ })).focus()
    await user.keyboard('o')
    expect(camera.scale).toBeCloseTo(camera.minScale, 6)
  })

  it('writes nothing to the DOM while a ~150-task plan rests at the overview scale', async () => {
    installMatchMedia(true)
    const camera = createCamera()
    const { container } = render(<GraphView repo={makeRepo(bigPlan())} selectedId={null} onSelect={() => {}} density="overview" camera={camera} />)
    await screen.findByRole('button', { name: /Task 149\b/ })
    act(() => camera.overview(true))
    await waitFor(() => expect(container.querySelector('.orc-graph--far')).not.toBeNull())
    await frames(5)

    const writes: MutationRecord[] = []
    const observer = new MutationObserver((records) => writes.push(...records))
    observer.observe(container, { subtree: true, attributes: true, childList: true, characterData: true })
    await frames(20)
    observer.disconnect()
    expect(writes).toHaveLength(0)
  })
})
