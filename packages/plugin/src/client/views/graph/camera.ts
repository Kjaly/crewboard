import { type Spring, clamp, project, rubber, settled, snap, spring, springStep } from './spring.js'

/**
 * The canvas camera: 1:1 dragging, a flick that coasts to Apple's projected resting point, zoom
 * anchored at the cursor, a soft edge, and a spring focus that can be grabbed mid-flight.
 * No React here — the camera is stepped from one rAF loop and writes a single transform.
 */

export type Box = { minX: number; minY: number; maxX: number; maxY: number }

/** The zoom-out floor for a plan that already fits: any further out is empty canvas. */
const MIN_SCALE = 0.35
/** The floor a huge plan may push the camera down to — below it a card is under a pixel tall. */
const FLOOR_SCALE = 0.05
/** The margin the whole plan keeps from the canvas edge at the zoom-out floor and in Overview. */
export const OVERVIEW_PADDING = 24
/** Screen room Overview keeps left of the plan for the far view's lane names (see lane-labels.ts). */
export const LABEL_GUTTER = 132
/**
 * Below this scale a card's 12 px title renders under ~7 px — not text any more, only grey noise —
 * so the graph switches to its far level of detail: blocks coloured by state, lane names at a
 * constant screen size. The level carries a little hysteresis so a pinch resting on the threshold
 * does not make the cards flicker between the two levels.
 */
export const DETAIL_SCALE = 0.6
const DETAIL_HYSTERESIS = 0.02
/** Fit defends a readable size before everything visible: the node title is 12 px, and
   below this scale it renders under the 11 px readability floor. */
const FIT_MIN_SCALE = 11 / 12
const MAX_SCALE = 1.8
const EDGE_SLACK = 140
const DRAG_RESPONSE = 0.5
const FOCUS_RESPONSE = 0.45
/** Lens moves are deliberate but quick: ~240 ms of ease-out, and any gesture grabs the camera back. */
export const LENS_RESPONSE = 0.24
/** Only pointer movement this close to the release counts as a flick. */
const FLICK_WINDOW_MS = 100

/**
 * The scale at which a box fills the viewport inside `padding`, whatever its readability, with the
 * lane-name gutter kept free on the left.
 */
function wholeScale(box: Box, viewport: { width: number; height: number }, padding: number): number {
  const w = Math.max(1, box.maxX - box.minX)
  const h = Math.max(1, box.maxY - box.minY)
  return Math.min(Math.max(1, viewport.width - padding * 2 - LABEL_GUTTER) / w, Math.max(1, viewport.height - padding * 2) / h)
}

/**
 * How far out the camera may zoom: far enough to see the whole plan with a small margin, never
 * below FLOOR_SCALE, and never above MIN_SCALE — a small plan keeps today's room to zoom out.
 * Derived on every call, so a plan or a window that changed size moves the floor with it.
 */
export function zoomFloor(box: Box, viewport: { width: number; height: number }): number {
  return clamp(wholeScale(box, viewport, OVERVIEW_PADDING), FLOOR_SCALE, MIN_SCALE)
}

/** The level of detail for a scale, given the level on screen now (the hysteresis needs it). */
export function detailLevel(scale: number, current: 'near' | 'far' = 'near'): 'near' | 'far' {
  return scale < DETAIL_SCALE + (current === 'far' ? DETAIL_HYSTERESIS : -DETAIL_HYSTERESIS) ? 'far' : 'near'
}

export type Camera = ReturnType<typeof createCamera>
/** A place the camera can return to: where it was, how close, and whether the reader had placed it. */
export type Pose = { x: number; y: number; scale: number; touched: boolean }

export function createCamera() {
  const x: Spring = spring(0)
  const y: Spring = spring(0)
  // Scale is a spring too: a lens can both move and re-frame, and a jumpy zoom would read as a glitch.
  const sc: Spring = spring(1)
  let targetX: number | null = null
  let targetY: number | null = null
  let targetS: number | null = null
  let response = FOCUS_RESPONSE
  let viewport = { width: 960, height: 600 }
  let content: Box = { minX: 0, minY: 0, maxX: 960, maxY: 600 }
  let drag: { ox: number; oy: number } | null = null
  let touched = false
  /** The framing an untouched camera repeats when the window or the plan changes size. */
  let framing: 'fit' | 'overview' = 'fit'
  let history: Array<{ x: number; y: number; t: number }> = []

  /**
   * Pan limits keep the plan reachable without letting it drift into empty space. When the plan is
   * smaller than the viewport along an axis the two bounds swap places; they are ordered so the plan
   * can move freely inside the viewport instead of being flung to one bound on the first drag.
   */
  const axis = (lo: number, hi: number) => (lo <= hi ? { lo, hi } : { lo: hi, hi: lo })
  const limits = () => {
    const scale = sc.x
    const h = axis(viewport.width - content.maxX * scale - EDGE_SLACK, EDGE_SLACK - content.minX * scale)
    const v = axis(viewport.height - content.maxY * scale - EDGE_SLACK, EDGE_SLACK - content.minY * scale)
    return { minX: h.lo, maxX: h.hi, minY: v.lo, maxY: v.hi }
  }

  const settle = (nx: number, ny: number) => {
    const l = limits()
    targetX = clamp(nx, l.minX, l.maxX)
    targetY = clamp(ny, l.minY, l.maxY)
  }

  /** A hand on the camera (drag, scroll, pinch) ends any scripted move on the spot. */
  const grab = () => {
    targetX = targetY = targetS = null
    x.v = y.v = sc.v = 0
  }

  /** One fit for whole-plan and «only these nodes»: the box is the only difference. */
  const fitInto = (box: Box, reduced: boolean, padding: number, speed = FOCUS_RESPONSE, whole = false) => {
    const w = Math.max(1, box.maxX - box.minX)
    const h = Math.max(1, box.maxY - box.minY)
    const availW = Math.max(1, viewport.width - padding * 2)
    const availH = Math.max(1, viewport.height - padding * 2)
    const next = whole ? clamp(wholeScale(box, viewport, padding), FLOOR_SCALE, 1) : clamp(availW / w, FIT_MIN_SCALE, 1)
    response = speed
    // The whole-plan frame centres the plan in what is left of the width after the lane-name gutter.
    const gutter = whole ? LABEL_GUTTER : 0
    const nx = w * next <= availW - gutter ? padding + gutter + (availW - gutter - w * next) / 2 - box.minX * next : padding + gutter - box.minX * next
    const ny = h * next <= availH ? (viewport.height - h * next) / 2 - box.minY * next : padding - box.minY * next
    targetX = nx
    targetY = ny
    targetS = next
    if (reduced) {
      snap(x, nx)
      snap(y, ny)
      snap(sc, next)
      targetX = targetY = targetS = null
    }
  }

  return {
    get scale() {
      return sc.x
    },
    /** The current zoom-out floor — see `zoomFloor`. */
    get minScale() {
      return zoomFloor(content, viewport)
    },
    get dragging() {
      return drag !== null
    },
    /** True once the reader has taken the camera into their own hands — after that it stays put. */
    get touched() {
      return touched
    },
    transform(): string {
      return `translate(${Math.round(x.x * 100) / 100}px,${Math.round(y.x * 100) / 100}px) scale(${Math.round(sc.x * 1000) / 1000})`
    },
    /** World point under a viewport point — used by zoom and by node dragging. */
    toWorld(px: number, py: number): { x: number; y: number } {
      return { x: (px - x.x) / sc.x, y: (py - y.x) / sc.x }
    },
    /** Viewport point over a world point — places the far view's hover card. */
    toScreen(wx: number, wy: number): { x: number; y: number } {
      return { x: wx * sc.x + x.x, y: wy * sc.x + y.x }
    },
    setViewport(width: number, height: number): void {
      viewport = { width, height }
    },
    setContent(box: Box): void {
      content = box
    },
    beginDrag(px: number, py: number, now: number): void {
      touched = true
      drag = { ox: px - x.x, oy: py - y.x }
      grab()
      history = [{ x: px, y: py, t: now }]
    },
    drag(px: number, py: number, now: number): void {
      if (!drag) return
      const l = limits()
      x.x = rubber(px - drag.ox, l.minX, l.maxX)
      y.x = rubber(py - drag.oy, l.minY, l.maxY)
      history.push({ x: px, y: py, t: now })
      if (history.length > 6) history.shift()
    },
    /** `now` is the release time: only movement in the last FLICK_WINDOW_MS counts, so a pause before letting go means no coast. */
    endDrag(reduced: boolean, now?: number): void {
      if (!drag) return
      drag = null
      const releasedAt = now ?? history.at(-1)?.t ?? 0
      const recent = history.filter((p) => releasedAt - p.t <= FLICK_WINDOW_MS)
      const first = recent[0]
      const last = recent.at(-1)
      let vx = 0
      let vy = 0
      if (first && last && last.t > first.t) {
        const dt = Math.max(16, last.t - first.t)
        vx = ((last.x - first.x) / dt) * 1000
        vy = ((last.y - first.y) / dt) * 1000
      }
      response = DRAG_RESPONSE
      settle(x.x + (reduced ? 0 : project(vx)), y.x + (reduced ? 0 : project(vy)))
    },
    /** Two-finger trackpad scroll (and a plain mouse wheel): move the canvas, never zoom. */
    panBy(dx: number, dy: number): void {
      touched = true
      grab()
      const l = limits()
      x.x = clamp(x.x + dx, l.minX, l.maxX)
      y.x = clamp(y.x + dy, l.minY, l.maxY)
    },
    zoomAt(px: number, py: number, factor: number): void {
      const next = clamp(sc.x * factor, Math.min(sc.x, zoomFloor(content, viewport)), MAX_SCALE)
      if (next === sc.x) return
      touched = true
      const wx = (px - x.x) / sc.x
      const wy = (py - y.x) / sc.x
      snap(sc, next)
      targetS = null
      // Keep the world point that was under the cursor exactly under the cursor.
      x.x = px - wx * sc.x
      y.x = py - wy * sc.x
      x.v = y.v = 0
      response = FOCUS_RESPONSE
      settle(x.x, y.x)
    },
    /**
     * Fit (F): the plan takes the window's width at a readable scale. A plan taller than the
     * screen keeps that scale and starts at the top — panning down beats shrinking every node to
     * postage-stamp text just so all of it is technically «visible». Whatever fits is centred.
     */
    fit(reduced: boolean, padding = 48): void {
      touched = false
      framing = 'fit'
      fitInto(content, reduced, padding)
    },
    /**
     * Overview (O): the whole plan on screen, however small that makes the cards — the graph
     * switches to blocks below DETAIL_SCALE, so the picture stays legible as a map of the plan.
     */
    overview(reduced: boolean, padding = OVERVIEW_PADDING): void {
      touched = false
      framing = 'overview'
      fitInto(content, reduced, padding, FOCUS_RESPONSE, true)
    },
    /** Repeat the last framing (Fit or Overview) for a camera the reader has not moved since. */
    refit(reduced: boolean): void {
      if (framing === 'overview') this.overview(reduced)
      else this.fit(reduced)
    },
    /** A lens aims the same fit at its matches — and a deliberate move, so `touched`. */
    fitBox(box: Box, reduced: boolean, padding = 48, speed = FOCUS_RESPONSE): void {
      touched = true
      fitInto(box, reduced, padding, speed)
    },
    /** The pose a lens returns to when it is switched off — position, zoom, and the reader's claim. */
    pose(): Pose {
      return { x: x.x, y: y.x, scale: sc.x, touched }
    },
    restore(p: Pose, reduced: boolean, speed = LENS_RESPONSE): void {
      touched = p.touched
      response = speed
      targetS = p.scale
      const l = limits()
      const nx = clamp(p.x, l.minX, l.maxX)
      const ny = clamp(p.y, l.minY, l.maxY)
      if (reduced) {
        snap(x, nx)
        snap(y, ny)
        snap(sc, p.scale)
        targetX = targetY = targetS = null
        return
      }
      targetX = nx
      targetY = ny
    },
    /** The world rectangle currently on screen — the minimap draws it as the «you are here» frame. */
    viewBox(): Box {
      return { minX: -x.x / sc.x, minY: -y.x / sc.x, maxX: (viewport.width - x.x) / sc.x, maxY: (viewport.height - y.x) / sc.x }
    },
    /**
     * Put a world point in the middle of the canvas. Dragging the minimap frame is direct
     * manipulation, so it lands at once (`immediate`); jumping to a search hit springs.
     */
    centerOn(wx: number, wy: number, immediate: boolean, speed = FOCUS_RESPONSE): void {
      touched = true
      response = speed
      const scale = sc.x
      const l = limits()
      const nx = clamp(viewport.width / 2 - wx * scale, l.minX, l.maxX)
      const ny = clamp(viewport.height / 2 - wy * scale, l.minY, l.maxY)
      // Centring keeps the zoom: a pending re-frame's scale would be a surprise here.
      targetS = null
      sc.v = 0
      if (immediate) {
        snap(x, nx)
        snap(y, ny)
        targetX = targetY = null
        return
      }
      targetX = nx
      targetY = ny
    },
    /**
     * A block clicked in the far view: fly to that task at a readable scale, centred. The same
     * spring as every other scripted move, so a gesture can take the camera back mid-flight.
     */
    zoomTo(box: Box, reduced: boolean, scale = 1): void {
      touched = true
      response = FOCUS_RESPONSE
      const next = clamp(scale, FIT_MIN_SCALE, MAX_SCALE)
      const cx = (box.minX + box.maxX) / 2
      const cy = (box.minY + box.maxY) / 2
      const nx = viewport.width / 2 - cx * next
      const ny = viewport.height / 2 - cy * next
      if (reduced) {
        snap(x, nx)
        snap(y, ny)
        snap(sc, next)
        targetX = targetY = targetS = null
        return
      }
      targetX = nx
      targetY = ny
      targetS = next
    },
    /** Double click: bring a task and its neighbours into view without changing the zoom. */
    focus(box: Box, reduced: boolean): void {
      touched = true
      response = FOCUS_RESPONSE
      const cx = (box.minX + box.maxX) / 2
      const cy = (box.minY + box.maxY) / 2
      const nx = viewport.width / 2 - cx * sc.x
      const ny = viewport.height / 2 - cy * sc.x
      if (reduced) {
        snap(x, nx)
        snap(y, ny)
        targetX = targetY = targetS = null
        return
      }
      settle(nx, ny)
    },
    /** @returns true while the camera still has something to move. */
    step(dt: number, reduced: boolean): boolean {
      if (drag) return true
      if (targetS !== null) {
        if (reduced || (Math.abs(sc.x - targetS) < 0.004 && Math.abs(sc.v) < 0.016)) {
          snap(sc, targetS)
          targetS = null
        } else {
          springStep(sc, targetS, dt, response)
        }
      }
      if (targetX !== null && targetY !== null) {
        if (reduced) {
          snap(x, targetX)
          snap(y, targetY)
          targetX = targetY = null
        } else {
          springStep(x, targetX, dt, response)
          springStep(y, targetY, dt, response)
          if (settled(x, targetX) && settled(y, targetY)) {
            snap(x, targetX)
            snap(y, targetY)
            targetX = targetY = null
          }
        }
      }
      return targetX !== null || targetS !== null
    },
    /** Is a world box currently inside the viewport? Drives the «event off screen» marker. */
    sees(box: Box): boolean {
      const scale = sc.x
      const left = box.minX * scale + x.x
      const top = box.minY * scale + y.x
      const right = box.maxX * scale + x.x
      const bottom = box.maxY * scale + y.x
      return right > 0 && left < viewport.width && bottom > 0 && top < viewport.height
    },
    /** Where to pin the off-screen marker along the canvas edge. */
    edgePoint(box: Box): { x: number; y: number } {
      const scale = sc.x
      const cx = ((box.minX + box.maxX) / 2) * scale + x.x
      const cy = ((box.minY + box.maxY) / 2) * scale + y.x
      return { x: clamp(cx, 14, viewport.width - 14), y: clamp(cy, 14, viewport.height - 14) }
    },
  }
}
