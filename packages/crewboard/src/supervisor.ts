import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildTree, flatten, isSettled, isTerminal } from './model/project.js'
import { randomBytes } from 'node:crypto'
import { MAX_SPLIT, PROGRESS_EVERY_MS } from './model/thresholds.js'
import type { AssignmentView, EventOf, GoalEvent, NewEvent, ProviderId, ResultKind, SystemText } from './model/types.js'
import type { EventStore } from './store/event-store.js'
import { worktreesDir } from './store/paths.js'
import type { Pool } from './workers/pool.js'
import { parseOutcome, workerPrompt } from './workers/protocol.js'
import { type Agents, AgentsFileError, builtinAgents } from './workers/agents.js'

const run = promisify(execFile)

export type WorktreeFn = (repo: string, assignmentId: string, title: string) => Promise<string>
export type Supervisor = ReturnType<typeof createSupervisor>

const slug = (title: string): string =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'work'

/** A git worktree for work whose result is a branch: `<repo>/.crewboard/worktrees/<id>`, reused when it exists. */
export const gitWorktree: WorktreeFn = async (repo, assignmentId, title) => {
  const path = join(worktreesDir(repo), assignmentId)
  const exists = await access(path).then(() => true, () => false)
  if (!exists) await run('git', ['-C', repo, 'worktree', 'add', '-q', '-b', `crewboard/${assignmentId}-${slug(title)}`, path])
  return path
}

type Live = { goalId: string; node: AssignmentView; own: GoalEvent[] }

const lastOf = <T extends GoalEvent['type']>(own: GoalEvent[], type: T): EventOf<T> | undefined => own.findLast((e): e is EventOf<T> => e.type === type)
/** The node's run is still open: started and not yet ended in the journal. */
const openRun = (own: GoalEvent[]): EventOf<'run_started'> | undefined => {
  const started = lastOf(own, 'run_started')
  const ended = lastOf(own, 'run_ended')
  return started && (!ended || ended.seq < started.seq) ? started : undefined
}

/**
 * One pass over a repository's goals: start queued work whose `after` is done, read every open run and turn what
 * it did into journal events. Run read positions live in memory; after a restart progress is deduplicated by text.
 */
export function createSupervisor(o: { repo: string; store: EventStore; pool: Pool; now: () => Date; worktree: WorktreeFn; agents?: Agents }) {
  const agents = o.agents ?? builtinAgents
  let brokenRegistry: string | undefined
  const cursors = new Map<string, number>()
  const append = (goalId: string, e: NewEvent) => o.store.append(goalId, e)

  const chainOf = (byId: Map<string, AssignmentView>, node: AssignmentView): string[] => {
    const chain: string[] = []
    for (let p = node.parentId ? byId.get(node.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) chain.unshift(p.title)
    return chain
  }

  const launch = async (goalId: string, node: AssignmentView, cwdOf: () => Promise<string>, chain: string[], resumeNote?: string) => {
    // A registry file that cannot be read right now (being edited, a typo) is the owner's to fix, not the work's
    // fault: nothing starts and nothing is recorded, and the work waits in the queue. Said once in the server log.
    const registered = await agents.get(node.provider).catch((error: unknown) => error as Error)
    if (registered instanceof AgentsFileError) {
      if (brokenRegistry !== registered.message) console.error(`crewboard: ${registered.message}; queued work waits until it is fixed`)
      brokenRegistry = registered.message
      return
    }
    brokenRegistry = undefined
    // An agent removed from the registry fails the launch like a refusing backend: recorded once with the reason,
    // told to the lead, not retried.
    const agent = registered && !(registered instanceof Error) ? agents.coreId(registered, node.model) : node.provider
    const prompt = workerPrompt({ title: node.title, criteria: node.criteria, resultKind: node.resultKind as ResultKind, chain, ...(resumeNote ? { resumeNote } : {}) })
    let runId: string
    let cwd = o.repo
    try {
      if (registered instanceof Error) throw registered
      if (!registered) throw new Error(`agent ${node.provider} is not in the registry`)
      cwd = await cwdOf()
      // An answer or a decision changes no files: the backend enforces it where it can, the prompt says it everywhere.
      runId = await o.pool.launch({ agent, cwd, prompt, readOnly: node.resultKind === 'answer' || node.resultKind === 'decision' })
    } catch (error) {
      // A launch the backend refuses (no CLI, no key, policy) is a run that failed at once: recorded, told to the
      // lead through the inbox, and not retried by the next tick. The lead decides: steer to retry, or cancel.
      const failed = `not-started-${Date.now().toString(36)}`
      const reason = error instanceof Error ? error.message : String(error)
      await append(goalId, { type: 'run_started', goalId, assignmentId: node.id, actor: 'system', runId: failed, agent, cwd })
      await append(goalId, { type: 'run_ended', goalId, assignmentId: node.id, actor: 'system', runId: failed, outcome: 'failed', reason })
      return
    }
    await append(goalId, { type: 'run_started', goalId, assignmentId: node.id, actor: 'system', runId, agent, cwd })
  }

  const readRun = async ({ goalId, node, own }: Live, started: EventOf<'run_started'>) => {
    const since = cursors.get(started.runId) ?? 0
    const r = await o.pool.poll(started.agent, started.runId, since, { startedAt: started.ts, cwd: started.cwd })
    cursors.set(started.runId, r.nextIndex)
    const step = r.events.findLast((e) => e.kind === 'action' || e.kind === 'file' || e.kind === 'message')
    // The handback protocol's tags belong to the result, not to the «doing» line or the history.
    const stepText = step?.text.replace(/<\/?crewboard-[a-z]+>/g, '').replace(/\s+/g, ' ').trim()
    const lastProgress = lastOf(own, 'progress')
    const due = !lastProgress || o.now().getTime() - new Date(lastProgress.ts).getTime() >= PROGRESS_EVERY_MS
    if (stepText && stepText !== lastProgress?.text && (due || r.terminal)) {
      await append(goalId, { type: 'progress', goalId, assignmentId: node.id, actor: 'worker', text: stepText })
    }
    if (!r.terminal) return
    cursors.delete(started.runId)
    // Work a worker split off belongs to that worker: its result goes to the worker (the part shows as reported until
    // the lead closes the parent), a failure cancels it with the reason.
    const workerOwned = own.some((e) => e.type === 'assigned' && e.actor === 'worker')
    if (r.failed) {
      await append(goalId, { type: 'run_ended', goalId, assignmentId: node.id, actor: 'system', runId: started.runId, outcome: 'failed', ...(r.reason ? { reason: r.reason } : {}), ...(r.usage ? { usage: r.usage } : {}) })
      if (workerOwned) await append(goalId, { type: 'cancelled', goalId, assignmentId: node.id, actor: 'system', reason: `Run failed: ${r.reason ?? 'unknown reason'}`, code: 'run_failed', detail: r.reason ?? '' })
      return
    }
    // A part may name any registered agent; an unknown name leaves the part with its worker's agent.
    const known = new Set((await agents.list().catch(() => [])).map((a) => a.id))
    const outcome = parseOutcome(r.finalText ?? '', known)
    if (outcome.kind === 'question') await append(goalId, { type: 'question', goalId, assignmentId: node.id, actor: 'worker', text: outcome.text, options: outcome.options })
    else await append(goalId, { type: 'reported', goalId, assignmentId: node.id, actor: 'worker', summary: outcome.summary, ...(outcome.kind === 'split' ? { split: true } : {}), ...(outcome.code ? { code: outcome.code } : {}) })
    if (outcome.kind === 'split') {
      for (const part of outcome.parts.slice(0, MAX_SPLIT)) {
        await append(goalId, {
          type: 'assigned', goalId, assignmentId: `a-${randomBytes(3).toString('hex')}`, actor: 'worker', parentId: node.id, title: part.title, criteria: part.criteria,
          resultKind: node.resultKind === 'goal' ? 'local' : node.resultKind, provider: part.provider ?? (node.provider as ProviderId), after: [],
        })
      }
    }
    await append(goalId, { type: 'run_ended', goalId, assignmentId: node.id, actor: 'system', runId: started.runId, outcome: 'completed', ...(r.usage ? { usage: r.usage } : {}) })
  }

  /** A worker whose split-off children have all finished continues with their results. */
  const resumeAfterSplit = async (goalId: string, node: AssignmentView, own: GoalEvent[], events: GoalEvent[], byId: Map<string, AssignmentView>) => {
    const kids = events.filter((e): e is EventOf<'assigned'> => e.type === 'assigned' && e.actor === 'worker' && e.parentId === node.id)
    if (!kids.length) return
    const lastSplit = Math.max(...kids.map((k) => k.seq))
    if (own.some((e) => e.type === 'run_started' && e.seq > lastSplit)) return
    const views = kids.map((k) => byId.get(k.assignmentId)).filter((v): v is AssignmentView => v !== undefined)
    if (!views.every((v) => isSettled(v.status))) return
    const results = views.map((v) => {
      const kidEvents = events.filter((e) => e.assignmentId === v.id)
      const closed = kidEvents.findLast((e): e is EventOf<'closed'> => e.type === 'closed')
      const cancelled = kidEvents.findLast((e): e is EventOf<'cancelled'> => e.type === 'cancelled')
      const reported = kidEvents.findLast((e): e is EventOf<'reported'> => e.type === 'reported')
      if (v.status === 'reported') return `- ${v.title}: ${reported?.summary ?? 'reported'}`
      return `- ${v.title}: ${v.status === 'done' ? (closed?.summary ?? 'done') : `not done (${cancelled?.reason ?? v.status})`}`
    })
    await this_.deliver(goalId, node.id, `Your assignments have finished:\n${results.join('\n')}\n\nContinue your task with these results in mind.`)
  }

  const cwdFor = (node: AssignmentView) => (node.resultKind === 'branch' ? o.worktree(o.repo, node.id, node.title) : Promise.resolve(o.repo))

  const load = async (goalId: string) => {
    const events = await o.store.read(goalId)
    const meta = await o.store.readMeta(goalId)
    const root = buildTree(events, o.now(), meta?.leadLastSeen ? new Date(meta.leadLastSeen) : undefined)
    const nodes = flatten(root)
    return { events, nodes, byId: new Map(nodes.map((n) => [n.id, n])) }
  }

  const this_ = {
    async tick(): Promise<void> {
      for (const meta of await o.store.listGoals()) {
        const { events, nodes, byId } = await load(meta.goalId)
        for (const node of nodes) {
          if (node.parentId === null || isTerminal(node.status)) continue
          const own = events.filter((e) => e.assignmentId === node.id)
          const live = openRun(own)
          if (live) {
            // A run that cannot be read (its record is gone, the backend throws) ends as failed; the other nodes
            // of the project keep moving and the lead hears about it through the inbox.
            await readRun({ goalId: meta.goalId, node, own }, live).catch((error: unknown) =>
              append(meta.goalId, { type: 'run_ended', goalId: meta.goalId, assignmentId: node.id, actor: 'system', runId: live.runId, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }),
            )
            continue
          }
          const unblocked = own.some((e) => e.type === 'unblocked')
          if (node.status === 'queued' && (unblocked || node.after.every((id) => byId.get(id)?.status === 'done'))) {
            // Parts of branch work run in the worker's own copy, so the worker builds on them.
            const parent = node.parentId ? byId.get(node.parentId) : undefined
            const inheritCwd = own.some((e) => e.type === 'assigned' && e.actor === 'worker') && parent?.resultKind === 'branch' && parent.cwd
            // Clarifications sent while the work waited in the queue were only journaled: its first run starts with them.
            const waited = own.some((e) => e.type === 'run_started') ? [] : own.filter((e): e is EventOf<'steered'> => e.type === 'steered').map((e) => `- ${e.text}`)
            const note = waited.length ? `Clarifications sent while this assignment waited:\n${waited.join('\n')}` : undefined
            await launch(meta.goalId, node, () => (inheritCwd ? Promise.resolve(inheritCwd) : cwdFor(node)), chainOf(byId, node), note)
          }
        }
        // After this pass's results are in, workers whose split-off parts all finished continue.
        const fresh = await load(meta.goalId)
        for (const node of fresh.nodes) {
          if (node.parentId === null || isTerminal(node.status)) continue
          const own = fresh.events.filter((e) => e.assignmentId === node.id)
          if (!openRun(own)) await resumeAfterSplit(meta.goalId, node, own, fresh.events, fresh.byId)
        }
      }
    },

    /**
     * Hands text to a worker: into its live session when the journal says its run is open, else a new run in the same
     * copy with the context. Queued work keeps its place (the text is already in the journal for its prompt), and
     * finished work is refused: a run started there would never be read or stopped.
     */
    async deliver(goalId: string, assignmentId: string, text: string): Promise<'steered' | 'relaunched' | 'recorded'> {
      const { events, byId } = await load(goalId)
      const node = byId.get(assignmentId)
      if (!node) throw new Error(`no assignment ${assignmentId} in goal ${goalId}`)
      if (isTerminal(node.status)) throw new Error(`assignment ${assignmentId} is ${node.status}; assign new work instead`)
      if (node.status === 'queued') return 'recorded'
      // A worker waiting on parts it split off resumes with their results; relaunching now would lose them.
      const splitOff = events.filter((e) => e.type === 'assigned' && e.actor === 'worker' && e.parentId === assignmentId).map((e) => byId.get(e.assignmentId))
      if (splitOff.some((k) => k && !isSettled(k.status))) return 'recorded'
      let own = events.filter((e) => e.assignmentId === assignmentId)
      const last = lastOf(own, 'run_started')
      const open = openRun(own)
      if (open) {
        if ((await o.pool.steer(open.agent, open.runId, text)) === 'delivered') return 'steered'
        // The run ended before a tick read it: take in its result first, or the new run would bury it unread.
        await readRun({ goalId, node, own }, open)
        const fresh = await load(goalId)
        own = fresh.events.filter((e) => e.assignmentId === assignmentId)
        const now = fresh.byId.get(assignmentId)
        if (openRun(own) || !now || isTerminal(now.status)) return 'recorded'
      }
      const question = lastOf(own, 'question')
      const report = lastOf(own, 'reported')
      const before = question && question.seq > (report?.seq ?? 0) ? `You asked: ${question.text}` : report ? `Your previous report: ${report.summary}` : ''
      const note = [before, text].filter(Boolean).join('\n\n')
      await launch(goalId, node, () => (last?.cwd ? Promise.resolve(last.cwd) : cwdFor(node)), chainOf(byId, node), note)
      return 'relaunched'
    },

    /** Gives the work to another provider: the open run stops, and a new run continues in the same copy with the context. */
    async reassign(goalId: string, assignmentId: string, provider: ProviderId, model?: string): Promise<void> {
      const { events, byId } = await load(goalId)
      const node = byId.get(assignmentId)
      if (!node) throw new Error(`no assignment ${assignmentId} in goal ${goalId}`)
      const own = events.filter((e) => e.assignmentId === assignmentId)
      const live = openRun(own)
      if (live) {
        await o.pool.cancel(live.agent, live.runId)
        await append(goalId, { type: 'run_ended', goalId, assignmentId, actor: 'system', runId: live.runId, outcome: 'cancelled', reason: 'handed over to another worker' })
      }
      const from = node.provider
      await append(goalId, { type: 'reassigned', goalId, assignmentId, actor: 'lead', provider, ...(model ? { model } : {}) })
      if (node.status === 'queued') return
      await this_.deliver(goalId, assignmentId, `This work was handed to you from ${from}. Continue where it stopped.`)
    },

    /** Closes work the lead accepts. Runs still open on it or under it stop, so no worker keeps editing for nothing. */
    async close(goalId: string, assignmentId: string, summary: string): Promise<void> {
      const { events, byId } = await load(goalId)
      const top = byId.get(assignmentId)
      if (!top) throw new Error(`no assignment ${assignmentId} in goal ${goalId}`)
      if (isTerminal(top.status)) throw new Error(`assignment ${assignmentId} is ${top.status} already`)
      for (const node of flatten(top)) {
        const live = openRun(events.filter((e) => e.assignmentId === node.id))
        if (!live) continue
        await o.pool.cancel(live.agent, live.runId)
        await append(goalId, { type: 'run_ended', goalId, assignmentId: node.id, actor: 'system', runId: live.runId, outcome: 'cancelled', reason: 'closed by the lead' })
      }
      await append(goalId, { type: 'closed', goalId, assignmentId, actor: 'lead', summary })
    },

    /** Cancels a node and everything under it that is not finished, stopping their open runs. */
    async cancelTree(goalId: string, assignmentId: string, reason: string, actor: 'lead' | 'owner' = 'lead', code?: SystemText): Promise<void> {
      const { events, byId } = await load(goalId)
      const top = byId.get(assignmentId)
      if (!top) throw new Error(`no assignment ${assignmentId} in goal ${goalId}`)
      for (const node of flatten(top)) {
        if (isTerminal(node.status)) continue
        const live = openRun(events.filter((e) => e.assignmentId === node.id))
        if (live) await o.pool.cancel(live.agent, live.runId)
        const own = node.id === assignmentId
        const why = own ? reason : `A branch above was cancelled: ${reason}`
        const coded = own ? (code ? { code } : {}) : { code: 'parent_cancelled' as const, detail: reason }
        await append(goalId, { type: 'cancelled', goalId, assignmentId: node.id, actor, reason: why, ...coded })
      }
    },
  }
  return this_
}
