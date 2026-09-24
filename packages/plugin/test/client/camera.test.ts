import { describe, expect, it } from 'vitest'
import { createCamera } from '../../src/client/views/graph/camera.js'

const panX = (c: ReturnType<typeof createCamera>) => -c.viewBox().minX * c.scale
const run = (c: ReturnType<typeof createCamera>) => {
  for (let i = 0; i < 600 && c.step(1 / 60, false); i += 1) {}
}

describe('graph camera', () => {
  it('moves a graph narrower than the viewport 1:1 instead of throwing it to an edge', () => {
    // A tall, narrow plan (the real plan on a wide screen): content width 300 in a 1000px viewport.
    const c = createCamera()
    c.setViewport(1000, 600)
    c.setContent({ minX: 0, minY: 0, maxX: 300, maxY: 2000 })
    c.centerOn(150, 300, true)
    const before = panX(c)
    c.beginDrag(500, 300, 0)
    c.drag(510, 300, 16)
    expect(panX(c)).toBeCloseTo(before + 10, 5)
    c.drag(520, 300, 32)
    expect(panX(c)).toBeCloseTo(before + 20, 5)
  })

  it('does not coast when the pointer rested before release', () => {
    const c = createCamera()
    c.setViewport(1000, 600)
    c.setContent({ minX: 0, minY: 0, maxX: 3000, maxY: 3000 })
    c.centerOn(1500, 1500, true)
    c.beginDrag(500, 300, 0)
    for (let t = 16, x = 500; t <= 80; t += 16) {
      x -= 60
      c.drag(x, 300, t)
    }
    const released = panX(c)
    c.endDrag(false, 400)
    run(c)
    expect(panX(c)).toBeCloseTo(released, 0)
  })

  it('still coasts after a real flick', () => {
    const c = createCamera()
    c.setViewport(1000, 600)
    c.setContent({ minX: 0, minY: 0, maxX: 3000, maxY: 3000 })
    c.centerOn(1500, 1500, true)
    c.beginDrag(500, 300, 0)
    for (let t = 16, x = 500; t <= 80; t += 16) {
      x -= 60
      c.drag(x, 300, t)
    }
    const released = panX(c)
    c.endDrag(false, 90)
    run(c)
    expect(panX(c)).toBeLessThan(released - 100)
  })
})

describe('trackpad scrolling', () => {
  it('pans by the scroll delta at the same scale, and stays inside the limits', () => {
    const c = createCamera()
    c.setViewport(1000, 600)
    c.setContent({ minX: 0, minY: 0, maxX: 3000, maxY: 3000 })
    c.centerOn(1500, 1500, true)
    const scale = c.scale
    const x0 = panX(c)
    c.panBy(-40, 0)
    expect(panX(c)).toBeCloseTo(x0 - 40, 5)
    expect(c.scale).toBe(scale)
    for (let i = 0; i < 500; i += 1) c.panBy(-400, 0)
    expect(-c.viewBox().maxX * c.scale).toBeGreaterThan(-3000 * c.scale - 200)
  })
})
