// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { Tour, TOUR_STEPS } from '../../src/client/tour.js'
import { type Box, intersects, placePopover } from '../../src/client/tour-placement.js'

beforeEach(() => setLang('en'))
afterEach(() => cleanup())

// Deterministic pseudo-random numbers, so a failure is reproducible.
function random(seed: number) { return () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31 } }

describe('placePopover', () => {
  const size = { width: 320, height: 170 }
  it('never covers its target and stays inside the viewport whenever a side has room', () => {
    const next = random(7)
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 760 }, { width: 760, height: 640 }]) {
      for (let i = 0; i < 2000; i++) {
        const width = 20 + next() * (viewport.width * 0.7)
        const height = 20 + next() * (viewport.height * 0.7)
        const target: Box = { left: next() * (viewport.width - width), top: next() * (viewport.height - height), width, height }
        const placed = placePopover(target, size, viewport)
        if (placed.side === 'overlay') {
          // Only allowed when no side can hold the popover.
          expect(target.left + target.width + 12 + size.width > viewport.width - 14 && target.left - 12 - size.width < 14 && target.top + target.height + 12 + size.height > viewport.height - 14 && target.top - 12 - size.height < 14).toBe(true)
          continue
        }
        const popover = { ...placed, ...size }
        expect(intersects(popover, target)).toBe(false)
        expect(placed.left).toBeGreaterThanOrEqual(14)
        expect(placed.top).toBeGreaterThanOrEqual(14)
        expect(placed.left + size.width).toBeLessThanOrEqual(viewport.width - 14 + 1e-9)
        expect(placed.top + size.height).toBeLessThanOrEqual(viewport.height - 14 + 1e-9)
      }
    }
  })

  it('prefers the side with free space and flips at the edges', () => {
    const viewport = { width: 1440, height: 900 }
    expect(placePopover({ left: 40, top: 300, width: 200, height: 80 }, size, viewport).side).toBe('right')
    expect(placePopover({ left: 1180, top: 300, width: 200, height: 80 }, size, viewport).side).toBe('left')
    expect(placePopover({ left: 0, top: 40, width: 1440, height: 200 }, size, viewport).side).toBe('bottom')
    expect(placePopover({ left: 0, top: 620, width: 1440, height: 200 }, size, viewport).side).toBe('top')
    // A preferred side wins when it fits, and is skipped when it does not.
    expect(placePopover({ left: 1090, top: 360, width: 340, height: 150 }, size, viewport, ['bottom']).side).toBe('bottom')
    expect(placePopover({ left: 1090, top: 700, width: 340, height: 150 }, size, viewport, ['bottom', 'top']).side).toBe('top')
  })
})

describe('Tour', () => {
  it('shows compact Back / Next / Skip, and on the last step only Back and Done', () => {
    const onStep = vi.fn()
    const onClose = vi.fn()
    const { rerender } = render(<Tour step={0} onStep={onStep} onClose={onClose} />)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Skip' })).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
    rerender(<Tour step={TOUR_STEPS - 1} onStep={onStep} onClose={onClose} />)
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByText(`${TOUR_STEPS} of ${TOUR_STEPS}`)).toBeTruthy()
  })

  it('reads «Готово» in Russian, closes on Escape and returns focus', () => {
    setLang('ru')
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const onClose = vi.fn()
    const { unmount } = render(<Tour step={TOUR_STEPS - 1} onStep={() => {}} onClose={onClose} />)
    expect(screen.getByRole('button', { name: 'Готово' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Пропустить' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(document.activeElement).toBe(before)
    before.remove()
  })

  it('highlights the target instead of hiding it and places the popover beside it', () => {
    const wrap = document.createElement('div')
    wrap.className = 'orc-graph-wrap'
    const node = document.createElement('div')
    node.dataset.taskId = 'build'
    node.getBoundingClientRect = () => ({ left: 100, top: 200, right: 300, bottom: 280, width: 200, height: 80, x: 100, y: 200, toJSON: () => ({}) })
    wrap.append(node)
    document.body.append(wrap)
    const { unmount } = render(<Tour step={0} onStep={() => {}} onClose={() => {}} />)
    expect(node.hasAttribute('data-tour-target')).toBe(true)
    const dialog = screen.getByRole('dialog')
    const left = Number.parseFloat(dialog.style.left)
    expect(left).toBeGreaterThanOrEqual(300)
    unmount()
    expect(node.hasAttribute('data-tour-target')).toBe(false)
    wrap.remove()
  })
})

it('moves with resize', async () => {
  const wrap = document.createElement('div')
  wrap.className = 'orc-graph-wrap'
  const node = document.createElement('div')
  node.dataset.taskId = 'build'
  let left = 100
  node.getBoundingClientRect = () => ({ left, top: 200, right: left + 200, bottom: 280, width: 200, height: 80, x: left, y: 200, toJSON: () => ({}) })
  wrap.append(node)
  document.body.append(wrap)
  render(<Tour step={0} onStep={() => {}} onClose={() => {}} />)
  const first = screen.getByRole('dialog').style.left
  left = 700
  await act(async () => { window.dispatchEvent(new Event('resize')) })
  expect(screen.getByRole('dialog').style.left).not.toBe(first)
  wrap.remove()
})
