export type Box = { left: number; top: number; width: number; height: number }
export type Side = 'right' | 'left' | 'bottom' | 'top'
export type Placement = { left: number; top: number; side: Side | 'overlay' }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** True when two boxes share any area; touching edges do not count. */
export function intersects(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height
}

/**
 * Places a popover of `size` next to `target` without covering it: the side with the most free room
 * is tried first, then the others; the popover always stays `margin` inside the viewport. Only when
 * the target leaves no room on any side does it fall back to the viewport corner farthest from the target.
 * `prefer` names sides to try first, for a step whose neighbouring content matters more than the room.
 */
export function placePopover(target: Box, size: { width: number; height: number }, viewport: { width: number; height: number }, prefer: readonly Side[] = [], gap = 12, margin = 14): Placement {
  const maxLeft = Math.max(margin, viewport.width - margin - size.width)
  const maxTop = Math.max(margin, viewport.height - margin - size.height)
  const room: Record<Side, number> = {
    right: viewport.width - margin - (target.left + target.width + gap),
    left: target.left - gap - margin,
    bottom: viewport.height - margin - (target.top + target.height + gap),
    top: target.top - gap - margin,
  }
  const need: Record<Side, number> = { right: size.width, left: size.width, bottom: size.height, top: size.height }
  // Prefer the side with the most room beyond what the popover needs.
  const sides = [...prefer, ...(Object.keys(room) as Side[]).sort((a, b) => (room[b] - need[b]) - (room[a] - need[a]))]
  for (const side of sides) {
    if (room[side] < need[side]) continue
    const horizontal = side === 'right' || side === 'left'
    const left = horizontal
      ? side === 'right' ? target.left + target.width + gap : target.left - gap - size.width
      : clamp(target.left + target.width / 2 - size.width / 2, margin, maxLeft)
    const top = horizontal
      ? clamp(target.top + target.height / 2 - size.height / 2, margin, maxTop)
      : side === 'bottom' ? target.top + target.height + gap : target.top - gap - size.height
    return { left, top, side }
  }
  const centerX = target.left + target.width / 2
  const centerY = target.top + target.height / 2
  return { left: centerX > viewport.width / 2 ? margin : maxLeft, top: centerY > viewport.height / 2 ? margin : maxTop, side: 'overlay' }
}
