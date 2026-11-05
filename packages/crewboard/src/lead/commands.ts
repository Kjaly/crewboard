import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { flatten, isTerminal } from '../model/project.js'
import type { AssignmentView, EventOf, ExternalSource, GoalEvent, NewEvent, ProviderId, ResultKind } from '../model/types.js'
import type { ProjectContext } from '../app.js'
import { decideRequest } from '../requests.js'
import { goalTree, summarize } from '../owner.js'
import { REVIEW_RESULT_SCHEMA } from '../model/review.js'
import { leadCall } from './call.js'
import { type Agents, agentChoices, builtinAgents, validateEffort } from '../workers/agents.js'
import type { ModelCatalog } from '../workers/catalog.js'
import { compileResultSchema } from '../workers/result-schema.js'

const run = promisify(execFile)

const id = (n: number) => randomBytes(n).toString('hex')
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)

type Target = { project: string; goalId: string; assignmentId: string }
export type ExternalNodeInput = ExternalSource & { title: string; model?: string; parentId?: string }
type ExternalBatchNode = ExternalNodeInput & { key?: string; parentKey?: string }

/** What a lead can do. The MCP tools call these; each resolves the project and records that the lead is alive. */
export function createLeadCommands(projectOf: (path: string) => Promise<ProjectContext>, now: () => Date, agents: Agents = builtinAgents, catalog?: ModelCatalog) {
  // The projects each lead session took inbox events from, so a closed session releases them everywhere.
  const sessionProjects = new Map<string, Set<ProjectContext>>()
  const goalCtx = async (project: string, goalId: string) => {
    const ctx = await projectOf(project)
    const meta = await ctx.store.readMeta(goalId)
    if (!meta) throw new Error(`goal ${goalId} not found in project ${ctx.repo}`)
    await ctx.store.touchLead(goalId, now())
    return ctx
  }
  const tree = (ctx: ProjectContext, goalId: string): Promise<AssignmentView> => goalTree(ctx, goalId, now())
  const node = async (ctx: ProjectContext, t: Target): Promise<AssignmentView> => {
    const found = flatten(await tree(ctx, t.goalId)).find((n) => n.id === t.assignmentId)
    if (!found) throw new Error(`assignment ${t.assignmentId} not found in goal ${t.goalId}`)
    return found
  }
  const record = (ctx: ProjectContext, t: Target, e: DistributiveEvent) => ctx.store.append(t.goalId, { ...e, goalId: t.goalId, assignmentId: t.assignmentId, actor: 'lead' } as NewEvent)
  const managedNode = async (ctx: ProjectContext, t: Target) => {
    const found = await node(ctx, t)
    if (found.external) throw new Error('Crewboard does not control external work; use crewboard_track_update or crewboard_track_finish')
    return found
  }
  const trackBatch = async (i: { project: string; goalId: string; nodes: ExternalBatchNode[] }) =>
    (await goalCtx(i.project, i.goalId)).exclusive(async (ctx) => {
      if (!i.nodes.length || i.nodes.length > 100) throw new Error('track between 1 and 100 external nodes at a time')
      const existing = new Map(flatten(await tree(ctx, i.goalId)).map((n) => [n.id, n]))
      const staged = i.nodes.map((input) => ({ input, assignmentId: `a-${id(3)}`, parentId: input.parentId ?? i.goalId }))
      const keys = new Map<string, (typeof staged)[number]>()
      for (const item of staged) {
        if (!item.input.title.trim()) throw new Error('an external node needs a title')
        if (item.input.key !== undefined) {
          if (!item.input.key || keys.has(item.input.key)) throw new Error(`duplicate or empty key: ${item.input.key}`)
          keys.set(item.input.key, item)
        }
      }
      const ordered: typeof staged = []
      const visited = new Set<string>()
      const visiting = new Set<string>()
      const visit = (item: (typeof staged)[number]) => {
        if (visited.has(item.assignmentId)) return
        if (visiting.has(item.assignmentId)) throw new Error('external node parents contain a cycle')
        visiting.add(item.assignmentId)
        if (item.input.parentKey !== undefined) {
          if (item.input.parentId !== undefined) throw new Error('choose parentId or parentKey')
          const parent = keys.get(item.input.parentKey)
          if (!parent) throw new Error(`unknown parentKey: ${item.input.parentKey}`)
          visit(parent)
          item.parentId = parent.assignmentId
        } else {
          const parentId = item.input.parentId ?? i.goalId
          const parent = existing.get(parentId)
          if (!parent) throw new Error(`assignment ${parentId} not found in goal ${i.goalId}`)
          if (isTerminal(parent.status) || parent.underFinished) throw new Error(`cannot track work under finished assignment ${parentId}`)
        }
        visiting.delete(item.assignmentId)
        visited.add(item.assignmentId)
        ordered.push(item)
      }
      staged.forEach(visit)
      // Validate the whole batch before writing, and write parents first so every published node is reachable.
      for (const { input, assignmentId, parentId } of ordered) {
        await ctx.store.append(i.goalId, {
          type: 'external_tracked', goalId: i.goalId, assignmentId, parentId, actor: 'lead', title: input.title, kind: input.kind,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.phase !== undefined ? { phase: input.phase } : {}),
          ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        })
      }
      return { assignments: staged.map(({ input, assignmentId }) => ({ ...(input.key !== undefined ? { key: input.key } : {}), assignmentId })) }
    })
  const lastQuestion = async (ctx: ProjectContext, t: Target) =>
    (await ctx.store.read(t.goalId)).findLast((e): e is EventOf<'question'> => e.type === 'question' && e.assignmentId === t.assignmentId)

  return {
    /** Who the lead can hand work to, with what each can do. */
    async agents() {
      const list = await Promise.all((await agents.list()).map(async (a) => ({ id: a.id, label: a.label, run: a.run, model: a.model, readOnly: a.readOnly, ...(a.run === 'dsh' ? { readOnlyReason: 'dsh_unprotected' as const } : {}), ...agentChoices(a), catalog: (await catalog?.get(a))?.slice(0, 30) ?? [] })))
      return { agents: list, presets: await agents.presets() }
    },
    async startGoal(i: { project: string; title: string; criteria: string[]; quote?: string }) {
      const ctx = await projectOf(i.project)
      await ctx.register()
      const goalId = `${slug(i.title) || 'goal'}-${id(2)}`
      const lead = leadCall.getStore()
      await ctx.store.writeMeta({ goalId, title: i.title, createdAt: now().toISOString(), leadLastSeen: now().toISOString(), ...(lead ? { lead } : {}) })
      await ctx.store.append(goalId, { type: 'goal_started', goalId, assignmentId: goalId, actor: 'lead', title: i.title, criteria: i.criteria, ...(i.quote ? { quote: i.quote } : {}), ...(lead ? { client: lead.client } : {}) })
      return { goalId }
    },
    async assign(i: { project: string; goalId: string; parentId?: string; title: string; criteria: string[]; resultKind: ResultKind; provider?: ProviderId; preset?: string; model?: string; effort?: string; quote?: string; after?: string[]; branch?: string; reviewOf?: string; writableRoots?: string[]; schema?: Record<string, unknown> }) {
      if (i.schema !== undefined) compileResultSchema(i.schema)
      // A review returns its verdict and findings in a checked shape unless the lead asks for its own.
      const schema = i.schema ?? (i.reviewOf ? (REVIEW_RESULT_SCHEMA as unknown as Record<string, unknown>) : undefined)
      if (i.preset && i.provider) throw new Error('choose either preset or provider')
      const preset = i.preset ? (await agents.presets())[i.preset] : undefined
      if (i.preset && !preset) throw new Error(`unknown or disabled preset ${i.preset}`)
      const provider = preset?.agent ?? i.provider
      if (!provider) throw new Error('provider or preset is required')
      const model = i.model ?? preset?.model
      const effort = i.effort ?? preset?.effort
      const list = await agents.list()
      const agent = list.find((a) => a.id === provider)
      if (!agent) throw new Error(`unknown agent ${provider}; available: ${list.map((a) => a.id).join(', ')}`)
      validateEffort(agent, effort ?? agent.effort, model)
      return (await goalCtx(i.project, i.goalId)).exclusive(async (ctx) => {
        if (i.branch !== undefined) {
          if (i.resultKind !== 'branch') throw new Error('branch requires resultKind branch')
          try { const checked = await run('git', ['check-ref-format', '--branch', i.branch], { cwd: ctx.repo }); if (checked.stdout.trim() !== i.branch) throw new Error('expanded branch') } catch { throw new Error(`invalid branch: ${i.branch}`) }
          const exists = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${i.branch}`], { cwd: ctx.repo }).then(() => true, () => false)
          if (exists) throw new Error(`branch already exists: ${i.branch}`)
        }
        const roots: string[] = []
        if (i.writableRoots?.length) {
          const projects = await Promise.all((await agents.registeredProjects?.() ?? []).map((p) => realpath(p).catch(() => '')))
          for (const root of i.writableRoots) {
            if (!isAbsolute(root)) throw new Error(`writable root must be absolute: ${root}`)
            const resolved = await realpath(root).catch(() => '')
            if (!resolved || !(await stat(resolved)).isDirectory()) throw new Error(`writable root must be an existing directory: ${root}`)
            if (!projects.some((p) => { const rel = relative(p, resolved); return p && (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) })) throw new Error(`writable root is outside registered projects: ${root}`)
            roots.push(resolved)
          }
        }
        const parentId = i.parentId ?? i.goalId
        await node(ctx, { project: i.project, goalId: i.goalId, assignmentId: parentId })
        const existing = new Map(flatten(await tree(ctx, i.goalId)).map((n) => [n.id, n]))
        if (i.reviewOf) {
          const reviewed = existing.get(i.reviewOf)
          if (i.resultKind !== 'answer') throw new Error('reviewOf requires resultKind answer')
          if (!reviewed || reviewed.resultKind !== 'branch') throw new Error('reviewOf must name a branch assignment in this goal')
          const events = await ctx.store.read(i.goalId)
          const report = events.findLast((e) => e.assignmentId === i.reviewOf && e.type === 'reported')
          const started = events.findLast((e) => e.assignmentId === i.reviewOf && e.type === 'run_started')
          if (!report || (started && report.seq < started.seq) || reviewed.runOpen) throw new Error('reviewOf requires a reported branch assignment')
          if (!agent.readOnly) throw new Error('reviewOf requires an agent that supports read-only work')
        }
        for (const dependency of i.after ?? []) {
          const target = existing.get(dependency)
          if (!target) throw new Error(`dependency ${dependency} not found in goal ${i.goalId}`)
          if (target.status === 'cancelled') throw new Error(`dependency ${dependency} is cancelled`)
        }
        const assignmentId = `a-${id(3)}`
        // Only an explicit name is recorded; without one the worktree takes its default `crewboard/<id>-<slug>`.
        const branch = i.resultKind === 'branch' ? i.branch : undefined
        if (branch) {
          for (const meta of await ctx.store.listGoals()) {
            if ((await ctx.store.read(meta.goalId)).some((e) => e.type === 'assigned' && e.branch === branch)) throw new Error(`branch already assigned: ${branch}`)
          }
        }
        await ctx.store.append(i.goalId, {
          type: 'assigned', goalId: i.goalId, assignmentId, actor: 'lead', parentId, title: i.title, criteria: i.criteria, resultKind: i.resultKind, provider, after: i.after ?? [],
          ...(branch ? { branch } : {}), ...(i.reviewOf ? { reviewOf: i.reviewOf } : {}), ...(roots.length ? { writableRoots: roots } : {}), ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(preset?.access ? { access: preset.access } : {}), ...(i.quote ? { quote: i.quote } : {}),
          ...(schema !== undefined ? { schema } : {}),
        })
        setTimeout(() => { void ctx.tickOnce().catch((error: unknown) => console.error('[crewboard] tick:', error)) }, 0)
        return { assignmentId }
      })
    },
    async track(i: ExternalNodeInput & { project: string; goalId: string }) {
      const result = await trackBatch({ project: i.project, goalId: i.goalId, nodes: [i] })
      const first = result.assignments[0]
      if (!first) throw new Error('external node was not recorded')
      return { assignmentId: first.assignmentId }
    },
    trackBatch,
    async trackUpdate(t: Target & { text: string; phase?: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        const found = await node(ctx, t)
        if (!found.external) throw new Error(`assignment ${t.assignmentId} is not external work`)
        if (isTerminal(found.status) || found.underFinished) throw new Error(`assignment ${t.assignmentId} is finished`)
        await record(ctx, t, { type: 'external_progress', text: t.text, ...(t.phase !== undefined ? { phase: t.phase } : {}) })
      })
    },
    async trackFinish(t: Target & { outcome: 'success' | 'failure'; summary: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive((ctx) => ctx.supervisor.finishExternal(t.goalId, t.assignmentId, t.outcome, t.summary))
    },
    /** Every event this session has not confirmed; calling again confirms the previous batch. */
    async inbox(i: { project: string }, session: string): Promise<GoalEvent[]> {
      const ctx = await projectOf(i.project)
      const events = await ctx.inbox.take(session)
      sessionProjects.set(session, (sessionProjects.get(session) ?? new Set()).add(ctx))
      try {
        for (const goalId of new Set(events.map((e) => e.goalId))) await ctx.store.touchLead(goalId, now())
      } catch (error) {
        // The lead gets an error, not the batch: the next call must hand the batch out again, not confirm it.
        ctx.inbox.release(session)
        throw error
      }
      return events
    },
    /** A lead session ended: what it took without confirming goes to the next session. */
    releaseSession(session: string): void {
      for (const ctx of sessionProjects.get(session) ?? []) ctx.inbox.release(session)
      sessionProjects.delete(session)
    },
    /** The session made an MCP request: the batches it took keep hiding events for the hold window from now. */
    touchSession(session: string): void {
      for (const ctx of sessionProjects.get(session) ?? []) ctx.inbox.touch(session)
    },
    async answer(t: Target & { text: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await managedNode(ctx, t)
        await record(ctx, t, { type: 'answered', text: t.text })
        await ctx.supervisor.deliver(t.goalId, t.assignmentId, `Answer to your question: ${t.text}`)
      })
    },
    async escalate(t: Target & { why: string; text?: string; options?: string[] }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await managedNode(ctx, t)
        const q = await lastQuestion(ctx, t)
        const text = t.text ?? q?.text
        if (!text) throw new Error(`assignment ${t.assignmentId} has no question to escalate; pass text`)
        await record(ctx, t, { type: 'escalated', text, options: t.options ?? q?.options ?? [], why: t.why })
      })
    },
    async steer(t: Target & { text: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await managedNode(ctx, t)
        await record(ctx, t, { type: 'steered', text: t.text })
        await ctx.supervisor.deliver(t.goalId, t.assignmentId, `Clarification from the lead: ${t.text}`)
      })
    },
    async returnWork(t: Target & { note?: string; reviewId?: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await managedNode(ctx, t)
        const work = await node(ctx, t)
        const review = t.reviewId ? work.reviews?.find((r) => r.id === t.reviewId) : undefined
        if (t.reviewId && (!review || !review.findings || !review.verdict)) throw new Error('reviewId must name a completed review of this assignment with valid findings')
        const note = [t.note, review ? `Review ${review.id} (${review.verdict}, commit ${review.commit}):\n${JSON.stringify(review.findings, null, 2)}` : undefined].filter(Boolean).join('\n\n')
        if (!note) throw new Error('return requires note or reviewId')
        await record(ctx, t, { type: 'returned', note })
        await ctx.supervisor.deliver(t.goalId, t.assignmentId, `The lead returned the work with a note: ${note}`)
      })
    },
    async close(t: Target & { summary: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        const work = await managedNode(ctx, t)
        const latest = work.reviews?.filter((r) => r.verdict).at(-1)
        const warnings = latest && (latest.stale || latest.verdict === 'changes') ? [`Latest review ${latest.id} ${latest.stale ? 'is stale' : 'requests changes'}`] : []
        await ctx.supervisor.close(t.goalId, t.assignmentId, t.summary)
        return { warnings }
      })
    },
    async cancel(t: Target & { reason: string }) {
      return (await goalCtx(t.project, t.goalId)).exclusive(async (ctx) => {
        await managedNode(ctx, t)
        await ctx.supervisor.cancelTree(t.goalId, t.assignmentId, t.reason)
      })
    },
    async decideRequest(t: Target & { requestId: string; decision: 'accepted' | 'declined'; reason?: string }) {
      const ctx = await goalCtx(t.project, t.goalId)
      await decideRequest(ctx, { goalId: t.goalId, assignmentId: t.assignmentId, requestId: t.requestId, decision: t.decision, ...(t.reason ? { reason: t.reason } : {}) }, now())
    },
    async goals(i: { project: string }) {
      return (await summarize(await projectOf(i.project), now())).goals
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
