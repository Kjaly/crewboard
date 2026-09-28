import { type MutableRefObject, type PointerEvent as ReactPointerEvent, useMemo } from 'react'
import type { Box } from './camera.js'
import { t, useLang } from '../../i18n.js'
import { NODE_H, NODE_W, type NodePos } from './layout.js'

/**
 * The minimap answers one question — «where am I in the plan and what is off screen» — so it draws
 * the whole plan at once, colours the cards by the same status table as the graph, and shows the
 * visible area as a frame you can drag. It is a shortcut, never the only way: Fit (F), the
 * arrows and ⌘K all move the camera without it.
 */

export const MAP_W = 164
export const MAP_H = 108
const MAP_PAD = 7
const DOT_MIN = 3

export type MapProjection = { scale: number; dx: number; dy: number }

/** World → minimap: `x * scale + dx`. Centred inside the padded box, never upscaled past 1:1. */
export function mapProjection(box: Box): MapProjection {
  const w = Math.max(1, box.maxX - box.minX)
  const h = Math.max(1, box.maxY - box.minY)
  const inner = { w: MAP_W - MAP_PAD * 2, h: MAP_H - MAP_PAD * 2 }
  const scale = Math.min(inner.w / w, inner.h / h, 1)
  return {
    scale,
    dx: MAP_PAD + (inner.w - w * scale) / 2 - box.minX * scale,
    dy: MAP_PAD + (inner.h - h * scale) / 2 - box.minY * scale,
  }
}

export type MapNode = { id: string; pos: NodePos; color: string; on: boolean; dim?: boolean }

/**
 * A lane band, world space, for the minimap's own name and dimming — independent of the per-node
 * `dim` a lens sets. `lanes`: the underlying lane names a folded, merged band stands for, so a
 * single name still finds its band (mm1). `label`: null when the lane keeps no name here (History,
 * unless it holds the selected task).
 */
export type MapBand = { lane: string; lanes?: string[]; top: number; height: number; label: string | null; dim: boolean; selected: boolean }

/** Minimum vertical gap between two minimap labels, in minimap pixels — an 8 px line plus a hair of air. */
const MAP_LABEL_STEP = 10
const LABEL_LEFT = 3
type MapLabelPlace = { band: MapBand & { label: string }; y: number; shown: boolean }

/** Top to bottom, whatever order the bands came in: a name is kept only clear of the one above it. */
export function placeMapLabels(bands: readonly MapBand[], projection: MapProjection): MapLabelPlace[] {
  const points = bands
    .filter((band): band is MapBand & { label: string } => band.label !== null)
    .map((band) => ({ band, y: Math.round((band.top + band.height / 2) * projection.scale + projection.dy), shown: false }))
  let last = Number.NEGATIVE_INFINITY
  for (const point of [...points].sort((a, b) => a.y - b.y)) {
    point.shown = point.y - last >= MAP_LABEL_STEP
    if (point.shown) last = point.y
  }
  return points
}

export type MinimapProps = {
  box: Box
  nodes: MapNode[]
  bands?: MapBand[]
  frameRef: MutableRefObject<HTMLSpanElement | null>
  onJump(world: { x: number; y: number }, dragging: boolean): void
  /** A lane label was clicked: the caller scrolls the canvas to it (and unfolds it, if folded). */
  onLaneClick?(lane: string): void
}

export function Minimap({ box, nodes, bands = [], frameRef, onJump, onLaneClick }: MinimapProps) {
  useLang()
  const projection = useMemo(() => mapProjection(box), [box])
  const laneDim = useMemo(() => {
    const dim = new Map<string, boolean>()
    for (const band of bands) for (const name of band.lanes ?? [band.lane]) dim.set(name, band.dim)
    return dim
  }, [bands])
  const labels = useMemo(() => placeMapLabels(bands, projection), [bands, projection])

  const jump = (event: ReactPointerEvent<HTMLDivElement>, dragging: boolean) => {
    const rect = event.currentTarget.getBoundingClientRect()
    onJump(
      {
        x: (event.clientX - rect.left - projection.dx) / projection.scale,
        y: (event.clientY - rect.top - projection.dy) / projection.scale,
      },
      dragging,
    )
  }

  return (
    /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div
      className="orc-gmap"
      role="group"
      aria-label={t('graph.minimap.label')}
      style={{ width: MAP_W, height: MAP_H }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        jump(event, true)
        // Capture keeps the drag alive outside the little box; losing it must not lose the drag.
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        } catch {
          /* no capture — the pointer is still tracked while it stays over the map */
        }
      }}
      onPointerMove={(event) => {
        if (event.buttons !== 1) return
        event.stopPropagation()
        jump(event, true)
      }}
      onPointerUp={(event) => {
        event.stopPropagation()
        try {
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        } catch {
          /* nothing was captured */
        }
      }}
    >
      {nodes.map((node) => {
        const dim = node.dim || (laneDim.get(node.pos.lane) ?? false)
        return (
          <span
            key={node.id}
            className={`orc-gmap__node${node.on ? ' orc-gmap__node--on' : ''}${dim ? ' orc-gmap__node--dim' : ''}`}
            aria-hidden="true"
            style={{
              left: node.pos.x * projection.scale + projection.dx,
              top: node.pos.y * projection.scale + projection.dy,
              width: Math.max(DOT_MIN, NODE_W * projection.scale),
              height: Math.max(DOT_MIN - 1, NODE_H * projection.scale),
              background: node.color,
            }}
          />
        )
      })}
      {labels.map(({ band, y, shown }) =>
        shown ? (
          <button
            key={band.lane}
            type="button"
            className={`orc-gmap__label${band.selected ? ' orc-gmap__label--selected' : ''}`}
            style={{ left: LABEL_LEFT, top: y }}
            title={band.label}
            aria-label={t('graph.minimap.goToLane', { lane: band.label })}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onLaneClick?.(band.lane)
            }}
          >
            {band.label}
          </button>
        ) : null,
      )}
      <span ref={frameRef} className="orc-gmap__frame" aria-hidden="true" />
    </div>
  )
}
