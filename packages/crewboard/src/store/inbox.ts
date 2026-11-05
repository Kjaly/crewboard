import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GoalEvent } from '../model/types.js'
import { writeJsonAtomic } from './atomic.js'
import type { EventStore } from './event-store.js'
import { projectDir } from './paths.js'

/**
 * What the lead must hear about: a worker's question or result, a run that failed, and the owner's answer to an
 * escalated question. A completed run is already told by its result or question.
 */
export function isLeadEvent(e: GoalEvent, workerParts: ReadonlySet<string> = new Set()): boolean {
  if (e.type === 'progress' && (e.code === 'launch_registry' || e.code === 'goal_idle')) return true
  if (e.type === 'question') return true
  // A split-off part reports to the worker that split it off, not to the lead.
  if (e.type === 'reported' && workerParts.has(e.assignmentId)) return false
  // A split is not a result to close: the worker continues once its parts finish.
  if (e.type === 'reported') return e.split !== true
  if (e.type === 'run_ended') return e.outcome === 'failed'
  if (e.type === 'answered') return e.actor === 'owner'
  if (e.type === 'owner_requested' || e.type === 'request_withdrawn') return true
  if (e.type === 'request_completed') return e.outcome === 'failed'
  if (e.type === 'cancelled') return e.actor === 'owner'
  return false
}

/** A later lead action makes the earlier notification obsolete, even without an inbox acknowledgement. */
function resolved(event: GoalEvent, later: GoalEvent[]): boolean {
  return later.some((next) => {
    if (event.type === 'owner_requested') return (next.type === 'request_decided' || next.type === 'request_withdrawn') && next.requestId === event.requestId
    if (event.type === 'progress' && event.code === 'goal_idle') {
      return (next.assignmentId === event.goalId && (next.type === 'closed' || next.type === 'cancelled')) ||
        (next.actor === 'lead' && ['assigned', 'answered', 'steered', 'returned', 'reassigned', 'reopened', 'unblocked', 'closed', 'cancelled'].includes(next.type))
    }
    if (event.type === 'run_ended' && event.outcome === 'failed' && next.assignmentId === event.goalId && (next.type === 'closed' || next.type === 'cancelled')) return true
    if (next.assignmentId !== event.assignmentId) return false
    if (event.type === 'reported') return ['closed', 'cancelled', 'returned'].includes(next.type)
    if (event.type === 'question') return next.type === 'answered' || next.type === 'escalated'
    if (event.type === 'run_ended' && event.outcome === 'failed') return ['closed', 'cancelled'].includes(next.type) || (next.actor === 'lead' && ['answered', 'steered', 'returned', 'reassigned', 'reopened', 'unblocked'].includes(next.type))
    return false
  })
}

type Delivered = { delivered: Record<string, number> }

/**
 * How long a session's last MCP activity keeps the batch it took from waking `crewboard wait`. A live lead that took
 * a batch and then waits makes no MCP calls meanwhile, so the hold is measured from its last request, not the take;
 * a lead whose client died without closing its session would otherwise hide new events until the idle sweep.
 */
export const INBOX_HOLD_MS = 10 * 60_000

/**
 * The lead's inbox across every goal of one repository; confirmed delivery is remembered in `.crewboard/inbox.json`.
 * Delivery is at least once: what a lead session takes stays unconfirmed until the same session takes again, so a
 * lead that drops out before acting hands its events to the next session. What was handed out lives in memory only:
 * a restarted server hands every unconfirmed event out again.
 */
export function createInbox(store: EventStore, now: () => number = Date.now) {
  const path = join(projectDir(store.repo), 'inbox.json')
  const load = async (): Promise<Delivered> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Delivered
    } catch {
      return { delivered: {} }
    }
  }
  let chain: Promise<unknown> = Promise.resolve()
  const offered = new Map<string, Map<string, number>>()
  // The session's last MCP request (or its take): how long its unconfirmed batch still hides events.
  const activeAt = new Map<string, number>()
  const waiters = new Set<Set<string>>()
  const highest = (events: GoalEvent[]) => {
    const top = new Map<string, number>()
    for (const e of events) top.set(e.goalId, Math.max(top.get(e.goalId) ?? 0, e.seq))
    return top
  }
  return {
    async pending(): Promise<GoalEvent[]> {
      const { delivered } = await load()
      const goals = await store.listGoals()
      const lists = await Promise.all(
        goals.map(async (g) => {
          const events = await store.read(g.goalId)
          const parts = new Set(events.filter((e) => e.type === 'assigned' && e.actor === 'worker').map((e) => e.assignmentId))
          // A part the lead sent back reports to the lead again: its worker has already moved on.
          const sentBack = new Map<string, number>()
          for (const e of events) if (e.type === 'returned' && e.actor === 'lead' && !sentBack.has(e.assignmentId)) sentBack.set(e.assignmentId, e.seq)
          const afterReturn = (e: GoalEvent): boolean => e.type === 'reported' && e.seq > (sentBack.get(e.assignmentId) ?? Number.POSITIVE_INFINITY)
          return events.filter((e, index) => e.seq > (delivered[g.goalId] ?? 0) && (isLeadEvent(e, parts) || afterReturn(e)) && !resolved(e, events.slice(index + 1)))
        }),
      )
      return lists.flat()
    },
    /** Confirms what this session took last time, then hands it every unconfirmed event. */
    async take(session: string): Promise<GoalEvent[]> {
      for (const [goalId, seq] of offered.get(session) ?? []) await this.ack(goalId, seq)
      const events = await this.pending()
      offered.set(session, highest(events))
      activeAt.set(session, now())
      return events
    },
    /** A session's MCP request: its unconfirmed batch keeps hiding events for the hold window from now. */
    touch(session: string): void {
      activeAt.set(session, now())
    },
    /** Keep currently live sessions present for the lifetime of a project wait. */
    waiting(): () => void {
      const sessions = new Set([...offered.keys()].filter((session) => now() - (activeAt.get(session) ?? 0) <= INBOX_HOLD_MS))
      waiters.add(sessions)
      return () => { waiters.delete(sessions) }
    },
    /** Unconfirmed events no live session holds: what should wake a waiting lead. */
    async unseen(): Promise<GoalEvent[]> {
      for (const sessions of waiters) for (const session of sessions) if (offered.has(session)) activeAt.set(session, now())
      const held = new Map<string, number>()
      for (const [session, top] of offered) {
        if (now() - (activeAt.get(session) ?? 0) > INBOX_HOLD_MS) continue
        for (const [goalId, seq] of top) held.set(goalId, Math.max(held.get(goalId) ?? 0, seq))
      }
      return (await this.pending()).filter((e) => e.seq > (held.get(e.goalId) ?? 0))
    },
    /** Forgets what a session held without confirming it: the next session gets those events again. */
    release(session: string): void {
      offered.delete(session)
      activeAt.delete(session)
    },
    ack(goalId: string, seq: number): Promise<void> {
      const next = chain.then(async () => {
        const state = await load()
        state.delivered[goalId] = Math.max(state.delivered[goalId] ?? 0, seq)
        await writeJsonAtomic(path, state)
      })
      chain = next.catch(() => undefined)
      return next
    },
  }
}
