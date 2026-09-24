import type { RepoSnapshot, TaskSnapshot } from '../shared/types.js'
import { isChecking, waitsForHuman } from '../../../core/src/plan/graph.js'
import { laneOf, laneOrder } from './views/graph/layout.js'

/**
 * The lane tree under the open plan in the sidebar, and the lane order the graph shares with it.
 * On a big plan the live work sits in a handful of lanes at the bottom of a tall column; the tree
 * names those lanes first («Now») and keeps the finished ones in a folded «History». The graph
 * stacks its bands in the same order, so the tree reads as a map of the canvas from top to bottom.
 * Pure — the sidebar renders it, the graph orders by it, the tests drive it without a DOM.
 */

/** A task that can no longer move: accepted, closed with a negative verdict, superseded or dropped. */
export const isFinished = (task: Pick<TaskSnapshot, 'status'>): boolean =>
  task.status === 'accepted' || task.status === 'closed' || task.status === 'superseded' || task.status === 'dropped'

/** ● running · ◐ awaiting the person · ○ ready · · queued or blocked · ✓ accepted. */
export type LaneCounts = { running: number; review: number; ready: number; queued: number; accepted: number }
/** The row's dot: amber when the lane waits for a person, blue while it runs, neutral otherwise. */
export type LaneTone = 'waiting' | 'running' | 'idle'
export type LaneRow = { lane: string; tone: LaneTone; counts: LaneCounts; total: number; finished: boolean }
export type LaneTree = { now: LaneRow[]; history: LaneRow[] }

function countLane(tasks: readonly TaskSnapshot[]): LaneCounts {
  const counts: LaneCounts = { running: 0, review: 0, ready: 0, queued: 0, accepted: 0 }
  for (const task of tasks) {
    if (waitsForHuman(task)) counts.review++
    // Work the orchestrator is still checking, or a decision it still prepares, is its move: live.
    else if (task.status === 'running' || (task.status === 'in_review' && isChecking(task.check)) || task.preparing) counts.running++
    else if (task.status === 'ready') counts.ready++
    else if (task.status === 'blocked' || task.status === 'backlog') counts.queued++
    else if (task.status === 'accepted' || task.status === 'closed') counts.accepted++
  }
  return counts
}

const toneOf = (counts: LaneCounts): LaneTone => (counts.review > 0 ? 'waiting' : counts.running > 0 ? 'running' : 'idle')
const RANK: Record<LaneTone, number> = { waiting: 0, running: 1, idle: 2 }

/**
 * «Now»: every lane with an open task — lanes waiting for a person, then running ones, then the
 * rest, each in plan order. «History»: lanes whose every task finished, in plan order.
 */
export function laneTree(repo: Pick<RepoSnapshot, 'tasks'>): LaneTree {
  const members = new Map<string, TaskSnapshot[]>()
  for (const task of repo.tasks) {
    const lane = laneOf(task)
    members.set(lane, [...(members.get(lane) ?? []), task])
  }
  const now: LaneRow[] = []
  const history: LaneRow[] = []
  for (const lane of laneOrder(repo.tasks)) {
    const tasks = members.get(lane) ?? []
    const counts = countLane(tasks)
    const finished = tasks.every(isFinished)
    const row: LaneRow = { lane, tone: finished ? 'idle' : toneOf(counts), counts, total: tasks.length, finished }
    ;(finished ? history : now).push(row)
  }
  // A stable sort: within one tone the plan order stands.
  now.sort((a, b) => RANK[a.tone] - RANK[b.tone])
  return { now, history }
}

/** The graph's band order: live lanes first, then the rest of the open ones, history last. */
export const liveLaneOrder = (repo: Pick<RepoSnapshot, 'tasks'>): string[] => {
  const tree = laneTree(repo)
  return [...tree.now, ...tree.history].map((row) => row.lane)
}

/**
 * The lane the camera looks at: the band under the middle of the view. In a band that packs several
 * folded lanes, the lane whose chip is closest to the middle horizontally.
 */
export function laneAt(
  bands: ReadonlyArray<{ lane: string; top: number; height: number; lanes?: string[] }>,
  chips: ReadonlyMap<string, { x: number }>,
  view: { minX: number; minY: number; maxX: number; maxY: number },
): string | null {
  const cx = (view.minX + view.maxX) / 2
  const cy = (view.minY + view.maxY) / 2
  let best: (typeof bands)[number] | undefined
  let distance = Number.POSITIVE_INFINITY
  for (const band of bands) {
    const d = cy < band.top ? band.top - cy : cy > band.top + band.height ? cy - band.top - band.height : 0
    if (d < distance) { distance = d; best = band }
  }
  if (!best) return null
  if (!best.lanes || best.lanes.length < 2) return best.lane
  let lane = best.lane
  let dx = Number.POSITIVE_INFINITY
  for (const name of best.lanes) {
    const chip = chips.get(`lane:${name}`)
    if (chip && Math.abs(chip.x - cx) < dx) { dx = Math.abs(chip.x - cx); lane = name }
  }
  return lane
}

/* ------------------------------------------------ group state, per plan and viewer */

export type LaneGroups = { now: boolean; history: boolean }
export const DEFAULT_LANE_GROUPS: LaneGroups = { now: true, history: false }
const groupsKey = (root: string, planId?: string) => `crewboard:lane-tree:${root}:${planId ?? ''}`

/** Anything but a stored yes/no reads as the default: «Now» open, «History» folded. */
export function readLaneGroups(root: string, planId?: string): LaneGroups {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(groupsKey(root, planId)) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...DEFAULT_LANE_GROUPS }
    const value = stored as Partial<Record<keyof LaneGroups, unknown>>
    return {
      now: typeof value.now === 'boolean' ? value.now : DEFAULT_LANE_GROUPS.now,
      history: typeof value.history === 'boolean' ? value.history : DEFAULT_LANE_GROUPS.history,
    }
  } catch { return { ...DEFAULT_LANE_GROUPS } }
}

export function writeLaneGroups(root: string, planId: string | undefined, groups: LaneGroups): void {
  try {
    globalThis.localStorage?.setItem(groupsKey(root, planId), JSON.stringify(groups))
  } catch { /* a blocked storage must not block the control */ }
}
