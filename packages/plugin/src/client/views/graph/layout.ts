import type { TaskSnapshot } from '../../../shared/types.js'
import { elkEngine } from './elk.js'
import { t } from '../../i18n.js'

/**
 * Layout of the plan graph: ELK «layered» decides the columns (dependency levels, left to right)
 * and the order inside a column; we then fold that order into horizontal lanes — the plan's stages —
 * so both rules of the spec hold at once: depth reads left→right, stage reads top→bottom.
 *
 * Stability is a hard requirement: a node that already has a place keeps it. Only brand new tasks
 * get a position, and they get it next to what they depend on.
 */

// A node is a fixed box — two lines of title, one line of substance — so a long title can never
// grow a card into its neighbour. The stylesheet clamps the text to the same height.
export const NODE_W = 176
export const NODE_H = 64
export const COL_GAP = 78
export const ROW_GAP = 18
export const LANE_GAP = 52
export const DECISION_LANE = '__decision_lane__'
/** Keep the layout lane stable while its visible title follows the active language. */
export const laneTitle = (lane: string): string => lane === DECISION_LANE ? t('graph.decisionLane') : lane

const ROW_STEP = NODE_H + ROW_GAP
const COL_STEP = NODE_W + COL_GAP

export type NodePos = { x: number; y: number; lane: string }
export type LaneBand = { lane: string; top: number; height: number; lanes?: string[]; folded?: boolean }

/** Human decisions always form the first lane, whatever stage the plan filed them under. */
export const laneOf = (task: TaskSnapshot): string => (task.kind === 'decision' ? DECISION_LANE : (task.lane ?? ''))

/**
 * Lane reading order: decisions first, named stages in plan order, the unnamed stage last. An
 * explicit `order` (the graph's live-first order) wins for every lane it names; a lane it does not
 * name keeps the plan order after them.
 */
export function laneOrder(tasks: readonly TaskSnapshot[], order?: readonly string[]): string[] {
  const seen: string[] = []
  for (const task of tasks) {
    const lane = laneOf(task)
    if (!seen.includes(lane)) seen.push(lane)
  }
  const given = (lane: string) => { const at = order?.indexOf(lane) ?? -1; return at < 0 ? Number.MAX_SAFE_INTEGER : at }
  // Decisions first, unnamed stage last, everything else in the order the plan lists it.
  return seen.sort((a, b) => given(a) - given(b) || rank(a) - rank(b) || seen.indexOf(a) - seen.indexOf(b))
}

const rank = (lane: string): number => (lane === DECISION_LANE ? -1 : lane === '' ? 1 : 0)

type Raw = { id: string; x: number; y: number }

/** Longest-path columns: the fallback when ELK is unavailable, and the guarantee behind the «right of» rule. */
function localColumns(tasks: TaskSnapshot[]): Raw[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const depth = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0
    seen.add(id)
    const task = byId.get(id)
    const deps = (task?.deps ?? []).filter((d) => byId.has(d))
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((d) => visit(d, seen))) + 1
    seen.delete(id)
    depth.set(id, value)
    return value
  }
  const rows = new Map<number, number>()
  return tasks.map((task) => {
    const column = visit(task.id, new Set())
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return { id: task.id, x: column * (NODE_W + COL_GAP), y: row * ROW_STEP }
  })
}

/** @returns undefined while the layout engine is still on its way — the caller falls back to levels. */
async function elkColumns(tasks: TaskSnapshot[]): Promise<Raw[] | undefined> {
  const elk = elkEngine()
  if (!elk) return undefined
  const ids = new Set(tasks.map((t) => t.id))
  const result = (await elk.layout({
    id: 'plan',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(COL_GAP),
      'elk.spacing.nodeNode': String(ROW_GAP),
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
    },
    children: tasks.map((t) => ({ id: t.id, width: NODE_W, height: NODE_H })),
    edges: tasks.flatMap((t) => t.deps.filter((d) => ids.has(d)).map((d) => ({ id: `${d}>${t.id}`, sources: [d], targets: [t.id] }))),
  })) as { children?: Array<{ id: string; x?: number; y?: number }> }
  const children = (result.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0 }))
  return children.length === tasks.length ? children : undefined
}

/**
 * Column index per task. ELK is free with x — a task nobody depends on lands wherever its own
 * component fits — and a column that is only «almost» the same x is what made two human decisions
 * draw on top of each other: each kept its own row counter and both got row zero. So x is snapped to
 * a shared grid (values closer than a card width are one column), and a column is then pushed right
 * of every column it depends on, which keeps the «depth reads left→right» rule exact.
 */
function assignColumns(tasks: TaskSnapshot[], raw: Raw[]): Map<string, number> {
  const rawById = new Map(raw.map((r) => [r.id, r]))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const grid = new Map<number, number>()
  let index = -1
  let previous = Number.NEGATIVE_INFINITY
  for (const x of [...new Set(raw.map((r) => r.x))].sort((a, b) => a - b)) {
    if (x - previous > NODE_W) index += 1
    grid.set(x, Math.max(0, index))
    previous = x
  }

  const out = new Map<string, number>()
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = out.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0
    seen.add(id)
    const deps = (byId.get(id)?.deps ?? []).filter((d) => byId.has(d))
    // A task that waits for nothing starts the plan: it belongs to column 0, wherever ELK's own
    // component placement put it. Depth is a dependency fact, not a drawing accident.
    const own = deps.length === 0 ? 0 : (grid.get(rawById.get(id)?.x ?? 0) ?? 0)
    const value = Math.max(own, ...deps.map((d) => resolve(d, seen) + 1))
    seen.delete(id)
    out.set(id, value)
    return value
  }
  for (const task of tasks) resolve(task.id, new Set())
  return out
}

/** Folds ELK's free placement into lane bands: inside a lane, a column is a vertical stack. */
function foldIntoLanes(tasks: TaskSnapshot[], raw: Raw[], order?: readonly string[]): Map<string, NodePos> {
  const rawById = new Map(raw.map((r) => [r.id, r]))
  const columns = assignColumns(tasks, raw)
  const lanes = laneOrder(tasks, order)
  const out = new Map<string, NodePos>()
  let top = 0
  for (const lane of lanes) {
    const members = tasks
      .filter((t) => laneOf(t) === lane)
      .map((t) => ({ task: t, column: columns.get(t.id) ?? 0, order: rawById.get(t.id)?.y ?? 0 }))
      .sort((a, b) => a.column - b.column || a.order - b.order)
    const rows = new Map<number, number>()
    let deepest = 1
    for (const { task, column } of members) {
      const row = rows.get(column) ?? 0
      rows.set(column, row + 1)
      deepest = Math.max(deepest, row + 1)
      out.set(task.id, { x: column * COL_STEP, y: top + row * ROW_STEP, lane })
    }
    if (members.length > 0) top += deepest * ROW_STEP - ROW_GAP + LANE_GAP
  }
  return out
}

/** A free slot next to the dependencies of a brand new task, so it never lands on top of the plan. */
function placeNear(task: TaskSnapshot, placed: Map<string, NodePos>, fallback: NodePos): NodePos {
  const deps = task.deps.map((d) => placed.get(d)).filter((p): p is NodePos => !!p)
  let spot = deps.length === 0 ? { ...fallback } : { x: Math.max(...deps.map((d) => d.x)) + NODE_W + COL_GAP, y: deps.reduce((s, d) => s + d.y, 0) / deps.length, lane: fallback.lane }
  const hits = (candidate: NodePos) =>
    [...placed.values()].some((p) => Math.abs(p.x - candidate.x) < NODE_W + 24 && Math.abs(p.y - candidate.y) < ROW_STEP)
  for (let guard = 0; guard < 64 && hits(spot); guard += 1) spot = { ...spot, y: spot.y + ROW_STEP }
  return spot
}

/**
 * @param previous positions already on screen — they are returned unchanged, so a new task or a
 *   status change never reshuffles the graph under the reader's hands. A kept position is honoured
 *   only while the task stays in its lane: a task that moved lanes would otherwise carry its old y
 *   into a foreign band and tangle the lane frames.
 */
export async function layoutGraph(tasks: TaskSnapshot[], previous?: Map<string, NodePos>, order?: readonly string[]): Promise<Map<string, NodePos>> {
  if (tasks.length === 0) return new Map()
  const raw = (await elkColumns(tasks).catch(() => undefined)) ?? localColumns(tasks)
  const computed = foldIntoLanes(tasks, raw, order)

  const out = new Map<string, NodePos>()
  const fresh: TaskSnapshot[] = []
  for (const task of tasks) {
    const lane = laneOf(task)
    const prev = previous?.get(task.id)
    if (task.pos) out.set(task.id, { x: task.pos.x, y: task.pos.y, lane })
    else if (prev && prev.lane === lane) out.set(task.id, { x: prev.x, y: prev.y, lane })
    else if (!previous || previous.size === 0) out.set(task.id, computed.get(task.id) ?? { x: 0, y: 0, lane })
    else fresh.push(task)
  }
  // New arrivals are placed after everything that already had a place, in dependency order.
  for (const task of fresh.sort((a, b) => (computed.get(a.id)?.x ?? 0) - (computed.get(b.id)?.x ?? 0))) {
    out.set(task.id, placeNear(task, out, computed.get(task.id) ?? { x: 0, y: 0, lane: laneOf(task) }))
  }
  return out
}

const BAND_PAD_TOP = 26 // room for the lane's own label inside the frame
const BAND_PAD_BOTTOM = 10
const BAND_SEAM = 8 // bands that would touch still keep a visible seam

/**
 * Lane frames drawn behind the nodes: one pass — each lane's extent, then lanes ordered by where
 * their nodes actually sit, then a partition so no two frames ever share a pixel. A kept or pinned
 * position can leave a node inside a neighbour's span; the band still starts below the previous
 * one, so the rect and its label stay honest about which strip is whose.
 */
export function laneBands(nodes: Map<string, NodePos>): LaneBand[] {
  const extents = new Map<string, { top: number; bottom: number }>()
  for (const { y, lane } of nodes.values()) {
    const e = extents.get(lane)
    extents.set(lane, { top: Math.min(e?.top ?? y, y), bottom: Math.max(e?.bottom ?? y + NODE_H, y + NODE_H) })
  }
  const ordered = [...extents.entries()].sort((a, b) => a[1].top - b[1].top || a[1].bottom - b[1].bottom)
  const out: LaneBand[] = []
  let floor = Number.NEGATIVE_INFINITY
  for (const [lane, e] of ordered) {
    const top = Math.max(e.top - BAND_PAD_TOP, floor)
    const bottom = Math.max(e.bottom + BAND_PAD_BOTTOM, top + NODE_H + BAND_PAD_TOP + BAND_PAD_BOTTOM)
    out.push({ lane, top, height: bottom - top })
    floor = bottom + BAND_SEAM
  }
  return out
}

/** One placement pass for the derived graph. Labels and folded chips own space before nodes move. */
export function layoutFoldStack(tasks: TaskSnapshot[], folded: Set<string>, lanes?: readonly string[]): { nodes: Map<string, NodePos>; bands: LaneBand[] } {
  const order = laneOrder(tasks, lanes)
  const nodes = new Map<string, NodePos>()
  const bands: LaneBand[] = []
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depth = new Map<string, number>()
  const column = (id: string, visiting = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!
    if (visiting.has(id)) return 0
    visiting.add(id)
    const deps = (byId.get(id)?.deps ?? []).filter((dep) => byId.has(dep))
    const value = deps.length ? Math.max(...deps.map((dep) => column(dep, visiting) + 1)) : 0
    visiting.delete(id)
    depth.set(id, value)
    return value
  }
  let top = 0
  for (let i = 0; i < order.length;) {
    const lane = order[i]!
    if (folded.has(lane)) {
      const lanes: string[] = []
      while (i < order.length && folded.has(order[i]!)) lanes.push(order[i++]!)
      const members = lanes.flatMap((name) => tasks.filter((task) => laneOf(task) === name))
      const chips = members.filter((task) => task.id === `lane:${laneOf(task)}`)
      const guests = members.filter((task) => task.id !== `lane:${laneOf(task)}`)
      const row = [...chips, ...guests]
      row.forEach((task, index) => { nodes.set(task.id, { x: (index + 1) * COL_STEP, y: top + 8, lane: laneOf(task) }) })
      const height = 16 + (guests.length ? NODE_H : 56)
      bands.push({ lane: lanes[0]!, lanes, folded: true, top, height })
      top += height + BAND_SEAM
      continue
    }
    const members = tasks.filter((task) => laneOf(task) === lane)
    const rows = new Map<number, number>()
    for (const task of members) {
      const col = column(task.id)
      const row = rows.get(col) ?? 0
      rows.set(col, row + 1)
      nodes.set(task.id, { x: (col + 1) * COL_STEP, y: top + BAND_PAD_TOP + row * ROW_STEP, lane })
    }
    const deepest = Math.max(1, ...rows.values())
    const height = BAND_PAD_TOP + deepest * NODE_H + (deepest - 1) * ROW_GAP + BAND_PAD_BOTTOM
    bands.push({ lane, top, height })
    top += height + BAND_SEAM
    i++
  }
  return { nodes, bands }
}

/** Bounding box of the laid out plan, used by Fit and by the pan limits. */
export function contentBox(nodes: Map<string, NodePos>): { minX: number; minY: number; maxX: number; maxY: number } {
  if (nodes.size === 0) return { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H }
  const xs = [...nodes.values()].map((n) => n.x)
  const ys = [...nodes.values()].map((n) => n.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs) + NODE_W, maxY: Math.max(...ys) + NODE_H }
}
