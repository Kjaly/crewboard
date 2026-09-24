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

export type MinimapProps = {
  box: Box
  nodes: MapNode[]
  frameRef: MutableRefObject<HTMLSpanElement | null>
  onJump(world: { x: number; y: number }, dragging: boolean): void
}

export function Minimap({ box, nodes, frameRef, onJump }: MinimapProps) {
  useLang()
  const projection = useMemo(() => mapProjection(box), [box])

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
      {nodes.map((node) => (
        <span
          key={node.id}
          className={`orc-gmap__node${node.on ? ' orc-gmap__node--on' : ''}${node.dim ? ' orc-gmap__node--dim' : ''}`}
          aria-hidden="true"
          style={{
            left: node.pos.x * projection.scale + projection.dx,
            top: node.pos.y * projection.scale + projection.dy,
            width: Math.max(DOT_MIN, NODE_W * projection.scale),
            height: Math.max(DOT_MIN - 1, NODE_H * projection.scale),
            background: node.color,
          }}
        />
      ))}
      <span ref={frameRef} className="orc-gmap__frame" aria-hidden="true" />
    </div>
  )
}
