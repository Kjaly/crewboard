import { basename } from 'node:path'
import type { ProjectContext } from './app.js'
import { leadLabel } from './lead/clients.js'
import { buildTree, flatten, statusBucket } from './model/project.js'
import { LEAD_OFFLINE_MS } from './model/thresholds.js'
import type { AssignmentView, GoalEvent, Status } from './model/types.js'

/** The request is well formed but the state moved on (already answered): HTTP 409. */
export class ConflictError extends Error {}
/** The request is malformed or names nothing that exists: HTTP 400. */
export class BadRequestError extends Error {}

export type GoalSummary = { goalId: string; title: string; createdAt: string; status: Status; leadOnline: boolean; counts: Record<'waiting_owner' | 'running' | 'queued' | 'finished', number>; lead?: string }
export type ProjectSummary = { repo: string; name: string; goals: GoalSummary[] }

// The sidebar has no separate «waiting for the lead»: that work is still in progress.
const bucket = (s: Status): keyof GoalSummary['counts'] | undefined => {
  const b = statusBucket(s)
  return b === 'waiting_lead' ? 'running' : b
}

export async function goalTree(ctx: ProjectContext, goalId: string, now: Date): Promise<AssignmentView> {
  const meta = await ctx.store.readMeta(goalId)
  if (!meta) throw new BadRequestError(`goal ${goalId} not found`)
  return buildTree(await ctx.store.read(goalId), now, meta.leadLastSeen ? new Date(meta.leadLastSeen) : undefined)
}

/** One project as the screen lists it: its goals with the root status and how many nodes sit in each state. */
export async function summarize(ctx: ProjectContext, now: Date): Promise<ProjectSummary> {
  const goals: GoalSummary[] = []
  for (const meta of await ctx.store.listGoals()) {
    const root = await goalTree(ctx, meta.goalId, now)
    const counts = { waiting_owner: 0, running: 0, queued: 0, finished: 0 }
    for (const node of flatten(root)) {
      if (node.parentId === null) continue
      const b = bucket(node.status)
      if (b) counts[b] += 1
    }
    const leadOnline = meta.leadLastSeen !== undefined && now.getTime() - new Date(meta.leadLastSeen).getTime() <= LEAD_OFFLINE_MS
    const lead = leadLabel(meta.lead?.client)
    goals.push({ goalId: meta.goalId, title: meta.title, createdAt: meta.createdAt, status: root.status, leadOnline, counts, ...(lead ? { lead } : {}) })
  }
  return { repo: ctx.repo, name: basename(ctx.repo), goals }
}

export async function nodeEvents(ctx: ProjectContext, goalId: string, assignmentId: string): Promise<GoalEvent[]> {
  return (await ctx.store.read(goalId)).filter((e) => e.assignmentId === assignmentId)
}

/** The owner answers a question the lead escalated: recorded, handed to the worker, and told to the lead via its inbox. */
export function answerAsOwner(ctx: ProjectContext, i: { goalId: string; assignmentId: string; text: string }, now: Date): Promise<void> {
  const text = i.text.trim()
  if (!text) throw new BadRequestError('text is required')
  return ctx.exclusive(async (c) => {
    const node = flatten(await goalTree(c, i.goalId, now)).find((n) => n.id === i.assignmentId)
    if (!node) throw new BadRequestError(`assignment ${i.assignmentId} not found in goal ${i.goalId}`)
    if (node.status !== 'waiting_owner') throw new ConflictError(`assignment ${i.assignmentId} is ${node.status}, not waiting for the owner`)
    await c.store.append(i.goalId, { type: 'answered', goalId: i.goalId, assignmentId: i.assignmentId, actor: 'owner', text })
    await c.supervisor.deliver(i.goalId, i.assignmentId, `The owner's answer: ${text}`)
  })
}
