import { LABEL_GUTTER } from './camera.js'

/**
 * Lane names in the far view live in screen space, over the canvas: a constant size at any zoom,
 * in the gutter Overview keeps left of the plan, and pinned to the canvas edge once the plan is
 * panned past it. A name is dropped when it would sit on the one above it — at the overview scale
 * a plan with dozens of thin lanes has more names than lines, and overlapping text reads as none.
 */

/** One label line in screen pixels (11 px type on a 12 px line) plus a pixel of air. */
export const LABEL_STEP = 13
const EDGE = 8

export type LabelPlace = { x: number; y: number; shown: boolean }

export function placeLaneLabels(
  bands: ReadonlyArray<{ top: number; height: number }>,
  laneLeft: number,
  pose: { x: number; y: number; scale: number },
): LabelPlace[] {
  const x = Math.max(EDGE, laneLeft * pose.scale + pose.x - LABEL_GUTTER + EDGE)
  const places = bands.map((band) => ({ x: Math.round(x), y: Math.round((band.top + band.height / 2) * pose.scale + pose.y), shown: false }))
  // Top to bottom, whatever order the bands came in: a name is kept when the last kept one is a line above.
  let last = Number.NEGATIVE_INFINITY
  for (const place of [...places].sort((a, b) => a.y - b.y)) {
    place.shown = place.y - last >= LABEL_STEP
    if (place.shown) last = place.y
  }
  return places
}
