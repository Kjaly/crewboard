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
export function isLeadEvent(e: GoalEvent): boolean {
  if (e.type === 'question') return true
  // A split is not a result to close: the worker continues once its parts finish.
  if (e.type === 'reported') return e.split !== true
  if (e.type === 'run_ended') return e.outcome === 'failed'
  if (e.type === 'answered') return e.actor === 'owner'
  if (e.type === 'owner_requested') return true
  if (e.type === 'cancelled') return e.actor === 'owner'
  return false
}

type Delivered = { delivered: Record<string, number> }

/** The lead's inbox across every goal of one repository; delivery is remembered in `.crewboard/inbox.json`. */
export function createInbox(store: EventStore) {
  const path = join(projectDir(store.repo), 'inbox.json')
  const load = async (): Promise<Delivered> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Delivered
    } catch {
      return { delivered: {} }
    }
  }
  let chain: Promise<unknown> = Promise.resolve()
  return {
    async pending(): Promise<GoalEvent[]> {
      const { delivered } = await load()
      const goals = await store.listGoals()
      const lists = await Promise.all(goals.map(async (g) => (await store.read(g.goalId)).filter((e) => e.seq > (delivered[g.goalId] ?? 0) && isLeadEvent(e))))
      return lists.flat()
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
