import { randomBytes } from 'node:crypto'
import { buildTree, flatten } from '../model/project.js'
import type { AssignmentView, EventOf, GoalEvent, NewEvent, ProviderId, ResultKind } from '../model/types.js'
import type { ProjectContext } from '../app.js'
import { decideRequest } from '../requests.js'
import { leadCall } from './call.js'
import { type Agents, builtinAgents } from '../workers/agents.js'

const id = (n: number) => randomBytes(n).toString('hex')
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)

type Target = { project: string; goalId: string; assignmentId: string }

/** What a lead can do. The MCP tools call these; each resolves the project and records that the lead is alive. */
export function createLeadCommands(projectOf: (path: string) => Promise<ProjectContext>, now: () => Date, agents: Agents = builtinAgents) {
  // The projects each lead session took inbox events from, so a closed session releases them everywhere.
  const sessionProjects = new Map<string, Set<ProjectContext>>()
  const goalCtx = async (project: string, goalId: string) => {
    const ctx = await projectOf(project)
    const meta = await ctx.store.readMeta(goalId)
    if (!meta) throw new Error(`goal ${goalId} not found in project ${ctx.repo}`)
    await ctx.store.touchLead(goalId, now())
    return ctx
  }
  const tree = async (ctx: ProjectContext, goalId: string): Promise<AssignmentView> => {
    const meta = await ctx.store.readMeta(goalId)
    return buildTree(await ctx.store.read(goalId), now(), meta?.leadLastSeen ? new Date(meta.leadLastSeen) : undefined)
  }
  const node = async (ctx: ProjectContext, t: Target): Promise<AssignmentView> => {
    const found = flatten(await tree(ctx, t.goalId)).find((n) => n.id === t.assignmentId)
    if (!found) throw new Error(`assignment ${t.assignmentId} not found in goal ${t.goalId}`)
    return found
  }
  const record = (ctx: ProjectContext, t: Target, e: DistributiveEvent) => ctx.store.append(t.goalId, { ...e, goalId: t.goalId, assignmentId: t.assignmentId, actor: 'lead' } as NewEvent)
  const lastQuestion = async (ctx: ProjectContext, t: Target) =>
    (await ctx.store.read(t.goalId)).findLast((e): e is EventOf<'question'> => e.type === 'question' && e.assignmentId === t.assignmentId)

  return {
    /** Who the lead can hand work to, with what each can do. */
    async agents() {
      return (await agents.list()).map((a) => ({ id: a.id, label: a.label, run: a.run, model: a.model, readOnly: a.readOnly }))
    },
    async startGoal(i: { project: string; title: string; criteria: string[]; quote?: string }) {
      const ctx = await projectOf(i.project)
      await ctx.register()
      const goalId = `${slug(i.title) || 'goal'}-${id(2)}`
      const lead = leadCall.getStore()
      await ctx.store.writeMeta({ goalId, title: i.title, createdAt: now().toISOString(), leadLastSeen: now().toISOString(), ...(lead ? { lead } : {}) })
      await ctx.store.append(goalId, { type: 'goal_started', goalId, assignmentId: goalId, actor: 'lead', title: i.title, criteria: i.criteria, ...(i.quote ? { quote: i.quote } : {}) })
      return { goalId }
    },
    async assign(i: { project: string; goalId: string; parentId?: string; title: string; criteria: string[]; resultKind: ResultKind; provider: ProviderId; model?: string; quote?: string; after?: string[] }) {
      const list = await agents.list()
      if (!list.some((a) => a.id === i.provider)) throw new Error(`unknown agent ${i.provider}; available: ${list.map((a) => a.id).join(', ')}`)
      return (await goalCtx(i.project, i.goalId)).exclusive(async (ctx) => {
        const parentId = i.parentId ?? i.goalId
        await node(ctx, { project: i.project, goalId: i.goalId, assignmentId: parentId })
        const assignmentId = `a-${id(3)}`
        await ctx.store.append(i.goalId, {
          type: 'assigned', goalId: i.goalId, assignmentId, actor: 'lead', parentId, title: i.title, criteria: i.criteria, resultKind: i.resultKind, provider: i.provider, after: i.after ?? [],
          ...(i.model ? { model: i.model } : {}), ...(i.quote ? { quote: i.quote } : {}),
        })
        await ctx.supervisor.tick()
        return { assignmentId }
      })
    },
    /** Every event this session has not confirmed; calling again confirms the previous batch. */
    async inbox(i: { project: string }, session: string): Promise<GoalEvent[]> {
      const ctx = await projectOf(i.project)
      const events = await ctx.inbox.take(session)
      sessionProjects.set(session, (sessionProjects.get(session) ?? new Set()).add(ctx))
      for (const goalId of new Set(events.map((e) => e.goalId))) await ctx.store.touchLead(goalId, now())
      return events
    },
    /** A lead session ended: what it took without confirming goes to the next session. */
    releaseSession(session: string): void {
      for (const ctx of sessionProjects.get(session) ?? []) ctx.inbox.release(session)
      sessionProjects.delete(session)
    },
    async answer(t: Target & { text: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await node(ctx, t)
        await record(ctx, t, { type: 'answered', text: t.text })
        await ctx.supervisor.deliver(t.goalId, t.assignmentId, `Answer to your question: ${t.text}`)
      })
    },
    async escalate(t: Target & { why: string; text?: string; options?: string[] }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        const q = await lastQuestion(ctx, t)
        const text = t.text ?? q?.text
        if (!text) throw new Error(`assignment ${t.assignmentId} has no question to escalate; pass text`)
        await record(ctx, t, { type: 'escalated', text, options: t.options ?? q?.options ?? [], why: t.why })
      })
    },
    async steer(t: Target & { text: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await node(ctx, t)
        await record(ctx, t, { type: 'steered', text: t.text })
        await ctx.supervisor.deliver(t.goalId, t.assignmentId, `Clarification from the lead: ${t.text}`)
      })
    },
    async returnWork(t: Target & { note: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await node(ctx, t)
        await record(ctx, t, { type: 'returned', note: t.note })
        await ctx.supervisor.deliver(t.goalId, t.assignmentId, `The lead returned the work with a note: ${t.note}`)
      })
    },
    async close(t: Target & { summary: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await node(ctx, t)
        await ctx.supervisor.close(t.goalId, t.assignmentId, t.summary)
      })
    },
    async cancel(t: Target & { reason: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive((ctx) => ctx.supervisor.cancelTree(t.goalId, t.assignmentId, t.reason))
    },
    async decideRequest(t: Target & { requestId: string; decision: 'accepted' | 'declined'; reason?: string }) {
      const ctx = await goalCtx(t.project, t.goalId)
      await decideRequest(ctx, { goalId: t.goalId, assignmentId: t.assignmentId, requestId: t.requestId, decision: t.decision, ...(t.reason ? { reason: t.reason } : {}) }, now())
    },
    async status(i: { project: string; goalId: string }) {
      return tree(await goalCtx(i.project, i.goalId), i.goalId)
    },
    async adopt(i: { project: string; goalId: string }) {
      const ctx = await goalCtx(i.project, i.goalId)
      await ctx.register()
      // A goal's lead changes only by a takeover: other calls mark the lead present without claiming the goal.
      const lead = leadCall.getStore()
      await ctx.store.touchLead(i.goalId, now(), lead)
      await ctx.store.append(i.goalId, { type: 'adopted', goalId: i.goalId, assignmentId: i.goalId, actor: 'lead', ...(lead ? { client: lead.client } : {}) })
    },
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type DistributiveEvent = DistributiveOmit<NewEvent, 'goalId' | 'assignmentId' | 'actor'>
export type LeadCommands = ReturnType<typeof createLeadCommands>
