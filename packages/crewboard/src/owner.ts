import { basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reviewOf } from './model/review.js'

const run = promisify(execFile)
import type { ProjectContext } from './app.js'
import { leadLabel } from './lead/clients.js'
import { buildTree, flatten, statusBucket } from './model/project.js'
import { LEAD_OFFLINE_MS } from './model/thresholds.js'
import type { AssignmentView, GoalEvent, Status } from './model/types.js'
import { AgentsFileError } from './workers/agents.js'

/** The request is well formed but the state moved on (already answered): HTTP 409. */
export class ConflictError extends Error {}
/** The request is malformed or names nothing that exists: HTTP 400. */
export class BadRequestError extends Error {}

export type GoalSummary = { goalId: string; title: string; createdAt: string; status: Status; leadOnline: boolean; counts: Record<'waiting_owner' | 'waiting_lead' | 'running' | 'queued' | 'finished', number>; lead?: string; finishedAt?: string }
export type ProjectSummary = { repo: string; name: string; goals: GoalSummary[] }

const FINISHED_ROOT: ReadonlySet<Status> = new Set(['done', 'cancelled', 'abandoned'])

export async function goalTree(ctx: ProjectContext, goalId: string, now: Date): Promise<AssignmentView> {
  const meta = await ctx.store.readMeta(goalId)
  if (!meta) throw new BadRequestError(`goal ${goalId} not found`)
  // The journal stays readable while a registry edit is broken. The agent list still reports the registry error,
  // and the supervisor leaves queued work waiting until the owner fixes it.
  const agents = await ctx.agents.list().catch((error: unknown) => {
    if (error instanceof AgentsFileError) return []
    throw error
  })
  const events = await ctx.store.read(goalId)
  const root = buildTree(events, now, meta.leadLastSeen ? new Date(meta.leadLastSeen) : undefined, agents)
  const nodes = flatten(root)
  for (const work of nodes.filter((n) => n.resultKind === 'branch')) {
    const reviews = nodes.filter((n) => n.reviewOf === work.id)
    if (!reviews.length) continue
    const head = work.cwd ? await run('git', ['rev-parse', 'HEAD'], { cwd: work.cwd }).then((r) => r.stdout.trim(), () => undefined) : undefined
    work.reviews = reviews.map((review) => {
      const started = events.findLast((e) => e.type === 'run_started' && e.assignmentId === review.id)
      const report = events.findLast((e) => e.type === 'reported' && e.assignmentId === review.id && (!started || e.seq > started.seq))
      const result = report?.type === 'reported' ? reviewOf(report) : undefined
      const commit = started?.type === 'run_started' ? started.reviewCommit : undefined
      const base = started?.type === 'run_started' ? started.reviewBase : undefined
      return { id: review.id, ...(commit ? { commit } : {}), ...(base ? { base } : {}), ...(result ?? {}), ...(commit && head ? { stale: commit !== head } : {}) }
    })
  }
  return root
}

/** One project as the screen lists it: its goals with the root status and how many nodes sit in each state. */
export async function summarize(ctx: ProjectContext, now: Date): Promise<ProjectSummary> {
  const goals: GoalSummary[] = []
  for (const meta of await ctx.store.listGoals()) {
    const root = await goalTree(ctx, meta.goalId, now)
    const counts: GoalSummary['counts'] = { waiting_owner: 0, waiting_lead: 0, running: 0, queued: 0, finished: 0 }
    for (const node of flatten(root)) {
      if (node.parentId === null) continue
      const b = statusBucket(node.status)
      if (b) counts[b] += 1
    }
    const leadOnline = meta.leadLastSeen !== undefined && now.getTime() - new Date(meta.leadLastSeen).getTime() <= LEAD_OFFLINE_MS
    const lead = leadLabel(meta.lead?.client)
    // When a finished goal was closed (or cancelled): the root's last closing event.
    const finishedAt = FINISHED_ROOT.has(root.status) ? (await ctx.store.read(meta.goalId)).findLast((e) => e.assignmentId === meta.goalId && (e.type === 'closed' || e.type === 'cancelled'))?.ts : undefined
    goals.push({ goalId: meta.goalId, title: meta.title, createdAt: meta.createdAt, status: root.status, leadOnline, counts, ...(lead ? { lead } : {}), ...(finishedAt ? { finishedAt } : {}) })
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
