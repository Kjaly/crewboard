import type { RepoSnapshot, TaskSnapshot } from '../shared/types.js'
import { t } from './i18n.js'
import { buildEdges, type Edge } from './views/graph/chain.js'
import { laneOf } from './views/graph/layout.js'

export const FOLD_MIN_PLAN = 24
export const FOLD_MIN_LANE = 5
export const FOLD_FRESH_HOURS = 6

export type FoldDecision = { folded: Set<string>; guests: Map<string, string[]> }
export type GraphNode = { id: string; lane: string; task?: TaskSnapshot; guest?: boolean; count?: number; summary?: string }
export type GraphEdge = Edge & { count: number }

export function taskCount(count: number): string {
  return t('graph.fold.taskCount', { count })
}

const membersByLane = (repo: RepoSnapshot) => {
  const lanes = new Map<string, TaskSnapshot[]>()
  for (const task of repo.tasks) {
    const lane = laneOf(task)
    lanes.set(lane, [...(lanes.get(lane) ?? []), task])
  }
  return lanes
}

const recent = (value: string | undefined, now: Date) => {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) && now.getTime() - time < FOLD_FRESH_HOURS * 60 * 60 * 1000
}

/** A live task is one the reader still needs to act on. */
const LIVE = new Set(['running', 'in_review', 'ready', 'blocked'])
/** At most two guests stay out of a folded lane; three makes folding ineffective. */
export const MAX_GUESTS = 2

/**
 * A guest is a task of a folded lane that a LIVE task outside it depends on, or that depends on one.
 * The first rule shipped (any neighbour in another lane) made almost every task a guest in a
 * cross-linked plan, so folding hid nothing — the owner saw the lane's tasks simply move right.
 * Folding by hand hides everything: if the reader folded it, they meant it.
 */
function guestIds(repo: RepoSnapshot, lane: string, manualFold: boolean): string[] {
  if (manualFold) return []
  const byId = new Map(repo.tasks.map((t) => [t.id, t]))
  const live = (id: string): boolean => {
    const task = byId.get(id)
    return !!task && laneOf(task) !== lane && LIVE.has(task.status)
  }
  const out = new Set<string>()
  for (const task of repo.tasks) {
    if (laneOf(task) !== lane) continue
    if (task.deps.some(live)) out.add(task.id)
    if (repo.tasks.some((other) => live(other.id) && other.deps.includes(task.id))) out.add(task.id)
  }
  return [...out].slice(0, MAX_GUESTS)
}

export function decideFolds(repo: RepoSnapshot, manual: Record<string, boolean>, now: Date): FoldDecision {
  const folded = new Set<string>()
  const guests = new Map<string, string[]>()
  for (const [lane, members] of membersByLane(repo)) {
    const override = manual[lane]
    const laneGuests = guestIds(repo, lane, override === true)
    const auto = repo.tasks.length > FOLD_MIN_PLAN && members.length >= FOLD_MIN_LANE
      && members.every((task) => (task.status === 'accepted' || task.status === 'closed' || task.status === 'superseded') && !recent(task.acceptedAt, now) && !recent(task.activeSince, now))
      && laneGuests.length <= members.length / 2
    if (override ?? auto) {
      folded.add(lane)
      guests.set(lane, laneGuests)
    }
  }
  return { folded, guests }
}

function statusSummary(tasks: TaskSnapshot[]): string {
  const accepted = tasks.filter((t) => t.status === 'accepted').length
  const superseded = tasks.filter((t) => t.status === 'superseded').length
  if (accepted === tasks.length) return t('graph.fold.allAccepted')
  if (superseded === tasks.length) return t('graph.fold.allSuperseded')
  const pieces = []
  if (accepted) pieces.push(t('graph.fold.accepted', { count: accepted }))
  if (superseded) pieces.push(t('graph.fold.superseded', { count: superseded }))
  const other = tasks.length - accepted - superseded
  if (other) pieces.push(t('graph.fold.inProgress', { count: other }))
  return pieces.join(' · ')
}

export function foldGraph(repo: RepoSnapshot, decision: FoldDecision): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const lanes = membersByLane(repo)
  const byId = new Map(repo.tasks.map((t) => [t.id, t]))
  const nodes: GraphNode[] = []
  const emitted = new Set<string>()
  for (const task of repo.tasks) {
    const lane = laneOf(task)
    if (!decision.folded.has(lane)) nodes.push({ id: task.id, lane, task })
    else {
      const id = `lane:${lane}`
      if (!emitted.has(id)) {
        const members = lanes.get(lane) ?? []
        nodes.push({ id, lane, count: members.length, summary: statusSummary(members) })
        emitted.add(id)
      }
      if (decision.guests.get(lane)?.includes(task.id)) nodes.push({ id: task.id, lane, task, guest: true })
    }
  }
  const edges = new Map<string, GraphEdge>()
  for (const edge of buildEdges(repo.tasks, repo.attention)) {
    const source = byId.get(edge.from)!
    const target = byId.get(edge.to)!
    const from = decision.folded.has(laneOf(source)) ? `lane:${laneOf(source)}` : edge.from
    const to = decision.folded.has(laneOf(target)) ? `lane:${laneOf(target)}` : edge.to
    if (from === to) continue
    const id = `${from}>${to}`
    const prior = edges.get(id)
    if (prior) {
      prior.count++
      if (edge.state === 'bad' || (edge.state === 'wait' && prior.state === 'ok')) prior.state = edge.state
    } else edges.set(id, { ...edge, id, from, to, count: 1 })
  }
  return { nodes, edges: [...edges.values()] }
}

const storageKey = (repo: RepoSnapshot) => `crewboard:fold:${repo.root}:${repo.planId ?? ''}`
type Stored = Record<string, { folded: boolean; ids: string[] }>

/** A new task in a lane retires only that lane's manual choice. */
export function readManualFolds(repo: RepoSnapshot): Record<string, boolean> {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(storageKey(repo)) ?? '{}') as Stored
    const result: Record<string, boolean> = {}
    for (const [lane, members] of membersByLane(repo)) {
      const choice = stored[lane]
      if (choice && members.every((task) => choice.ids.includes(task.id))) result[lane] = choice.folded
    }
    return result
  } catch { return {} }
}

export function writeManualFold(repo: RepoSnapshot, lane: string, folded: boolean): void {
  try {
    const key = storageKey(repo)
    const stored = JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}') as Stored
    stored[lane] = { folded, ids: (membersByLane(repo).get(lane) ?? []).map((t) => t.id) }
    globalThis.localStorage?.setItem(key, JSON.stringify(stored))
  } catch { /* a blocked storage must not block the control */ }
}
