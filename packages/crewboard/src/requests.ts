import { randomBytes } from 'node:crypto'
import type { ProjectContext } from './app.js'
import { availableActions, flatten, isTerminal } from './model/project.js'
import type { AssignmentView, ProviderId, RequestAction } from './model/types.js'
import { BadRequestError, ConflictError, goalTree } from './owner.js'
import { failureText } from './workers/failure.js'
import { validateEffort } from './workers/agents.js'

const validateHandoff = async (ctx: ProjectContext, provider: ProviderId, model?: string, effort?: string) => {
  const agent = await ctx.agents.get(provider)
  if (!agent) throw new BadRequestError(`unknown provider ${provider}`)
  if (model !== undefined && !model.length) throw new BadRequestError('model must not be empty')
  validateEffort(agent, effort ?? agent.effort, model)
}

const findNode = async (ctx: ProjectContext, goalId: string, assignmentId: string, now: Date): Promise<AssignmentView> => {
  const node = flatten(await goalTree(ctx, goalId, now)).find((n) => n.id === assignmentId)
  if (!node) throw new BadRequestError(`assignment ${assignmentId} not found in goal ${goalId}`)
  return node
}

/** The owner asks the lead for something on a node. The lead hears it through its inbox and decides. */
export function requestAsOwner(ctx: ProjectContext, i: { goalId: string; assignmentId: string; action: RequestAction; text?: string; provider?: ProviderId; model?: string; effort?: string | null }, now: Date): Promise<{ requestId: string }> {
  return ctx.exclusive(async (c) => {
    const node = await findNode(c, i.goalId, i.assignmentId, now)
    const handoff = node.pendingRun ?? node
    if (node.request?.state === 'pending' && i.action !== 'discuss') throw new ConflictError('a request for this assignment already waits for the lead')
    if (!availableActions(node).includes(i.action)) throw new ConflictError(`${i.action} is not available while the assignment is ${node.status}`)
    if ((i.action === 'clarify' || i.action === 'reopen' || i.action === 'revive') && !i.text?.trim()) throw new BadRequestError('text is required')
    if (i.action === 'handoff' && !i.provider) throw new BadRequestError('handoff needs a provider')
    // The same agent is a handover too when its model or effort changes: a stronger model, more effort.
    if (i.action === 'handoff' && i.provider === node.provider && (i.model ?? handoff.model) === handoff.model && (i.effort === undefined ? handoff.effort : i.effort) === handoff.effort) {
      throw new BadRequestError('handoff changes nothing: pick another agent, model or effort')
    }
    if (i.action === 'handoff' && i.provider) await validateHandoff(c, i.provider, i.model ?? (i.provider === node.provider ? handoff.model : undefined), i.effort === null ? undefined : i.effort ?? (i.provider === node.provider ? handoff.effort : undefined))
    const requestId = `r-${randomBytes(3).toString('hex')}`
    await c.store.append(i.goalId, {
      type: 'owner_requested', goalId: i.goalId, assignmentId: i.assignmentId, actor: 'owner', requestId, action: i.action,
      ...(i.text?.trim() ? { text: i.text.trim() } : {}), ...(i.provider ? { provider: i.provider } : {}),
      ...(i.action === 'handoff' && i.model !== undefined ? { model: i.model } : {}),
      ...(i.action === 'handoff' && i.effort !== undefined ? { effort: i.effort } : {}),
    })
    return { requestId }
  })
}

/** The one action without the lead's decision: always allowed on running work, recorded and told to the lead. */
export function emergencyStop(ctx: ProjectContext, i: { goalId: string; assignmentId: string }, now: Date): Promise<void> {
  return ctx.exclusive(async (c) => {
    const node = await findNode(c, i.goalId, i.assignmentId, now)
    if (!availableActions(node).includes('emergency_stop')) throw new ConflictError(`nothing runs on an assignment that is ${node.status}`)
    await c.supervisor.cancelTree(i.goalId, i.assignmentId, 'Emergency stop by the owner', 'owner', 'emergency_stop')
  })
}

/** Withdrawal and decision use the same project lock: only one can win. */
export function withdrawRequest(ctx: ProjectContext, i: { goalId: string; assignmentId: string; requestId: string }, now: Date): Promise<void> {
  return ctx.exclusive(async (c) => {
    await findNode(c, i.goalId, i.assignmentId, now)
    const events = await c.store.read(i.goalId)
    const asked = events.find((e) => e.type === 'owner_requested' && e.requestId === i.requestId && e.assignmentId === i.assignmentId)
    if (!asked) throw new BadRequestError(`request ${i.requestId} not found on assignment ${i.assignmentId}`)
    if (events.some((e) => (e.type === 'request_decided' || e.type === 'request_withdrawn') && e.requestId === i.requestId)) {
      throw new ConflictError(`request ${i.requestId} is already decided or withdrawn`)
    }
    await c.store.append(i.goalId, { type: 'request_withdrawn', goalId: i.goalId, assignmentId: i.assignmentId, actor: 'owner', requestId: i.requestId })
  })
}

/** Acceptance records the decision first, then the outcome, including a partially applied action that failed. */
export function decideRequest(ctx: ProjectContext, i: { goalId: string; assignmentId: string; requestId: string; decision: 'accepted' | 'declined'; reason?: string }, now: Date): Promise<void> {
  return ctx.exclusive(async (c) => {
    const node = await findNode(c, i.goalId, i.assignmentId, now)
    const events = await c.store.read(i.goalId)
    const asked = events.findLast((e) => e.type === 'owner_requested' && e.requestId === i.requestId)
    if (asked?.type !== 'owner_requested' || asked.assignmentId !== i.assignmentId) throw new BadRequestError(`request ${i.requestId} not found on assignment ${i.assignmentId}`)
    if (events.some((e) => e.type === 'request_withdrawn' && e.requestId === i.requestId)) throw new ConflictError(`request ${i.requestId} was withdrawn by the owner`)
    if (node.request?.id !== i.requestId || node.request.state !== 'pending') {
      if (isTerminal(node.status)) throw new ConflictError(`cannot ${asked.action}: the assignment is ${node.status}`)
      throw new ConflictError(`request ${i.requestId} is already decided`)
    }
    const decided = (extra: { reason?: string } = {}) =>
      c.store.append(i.goalId, { type: 'request_decided', goalId: i.goalId, assignmentId: i.assignmentId, actor: 'lead', requestId: i.requestId, decision: i.decision, ...extra })
    if (i.decision === 'declined') {
      if (!i.reason?.trim()) throw new BadRequestError('a declined request needs a reason the owner will read')
      await decided({ reason: i.reason.trim() })
      return
    }
    if (!availableActions({ ...node, request: undefined }).includes(asked.action)) throw new ConflictError(`cannot ${asked.action}: the assignment is ${node.status}`)
    const handoff = node.pendingRun ?? node
    if (asked.action === 'handoff' && asked.provider) await validateHandoff(c, asked.provider, asked.model ?? (asked.provider === node.provider ? handoff.model : undefined), asked.effort === null ? undefined : asked.effort ?? (asked.provider === node.provider ? handoff.effort : undefined))
    // Never retry a partially applied action as though it still waited for a decision.
    const accepted = await decided()
    const at = { goalId: i.goalId, assignmentId: i.assignmentId }
    try {
      switch (asked.action) {
        case 'clarify':
          await c.store.append(i.goalId, { type: 'steered', ...at, actor: 'owner', text: asked.text ?? '' })
          await c.supervisor.deliver(i.goalId, i.assignmentId, `Clarification from the owner: ${asked.text ?? ''}`)
          break
        case 'stop':
        case 'cancel':
          await c.supervisor.cancelTree(i.goalId, i.assignmentId, "Stopped at the owner's request", 'lead', 'owner_stop')
          break
        case 'handoff':
          if (asked.provider) {
            // Staying with the same agent keeps what the owner did not change: the model when only effort moves, and back.
            const same = asked.provider === node.provider
            const handoff = node.pendingRun ?? node
            await c.supervisor.reassign(i.goalId, i.assignmentId, asked.provider, asked.model ?? (same ? handoff.model : undefined), asked.effort === null ? undefined : asked.effort ?? (same ? handoff.effort : undefined))
          }
          break
        case 'start_now':
          await c.store.append(i.goalId, { type: 'unblocked', ...at, actor: 'lead' })
          setTimeout(() => {
            void (async () => {
              try {
                await c.tickOnce()
                const effects = (await c.store.read(i.goalId)).filter((e) => e.seq > accepted.seq && e.assignmentId === i.assignmentId)
                const started = effects.findLast((e) => e.type === 'run_started')
                const failed = effects.findLast((e) => e.type === 'run_ended' && e.outcome === 'failed' && started?.type === 'run_started' && e.runId === started.runId)
                if (failed?.type === 'run_ended') throw new Error([failed.reason, failed.text].filter(Boolean).join(': ') || 'Worker launch failed')
                await c.store.append(i.goalId, { type: 'request_completed', ...at, actor: 'system', requestId: i.requestId, outcome: 'succeeded' })
              } catch (error) {
                const reason = failureText(error instanceof Error ? error.message : String(error))
                await c.store.append(i.goalId, { type: 'request_completed', ...at, actor: 'system', requestId: i.requestId, outcome: 'failed', reason })
              }
            })().catch((error: unknown) => console.error('[crewboard] start_now:', error))
          }, 0)
          return
        case 'reopen':
        case 'revive':
          await c.store.append(i.goalId, { type: 'reopened', ...at, actor: 'owner', note: asked.text ?? '' })
          await c.supervisor.deliver(i.goalId, i.assignmentId, `The owner brought the work back: ${asked.text ?? ''}`)
          break
        case 'discuss':
          break
      }
      // Launch failures are recorded by the supervisor rather than thrown; surface those too.
      const effects = (await c.store.read(i.goalId)).filter((e) => e.seq > accepted.seq && e.assignmentId === i.assignmentId)
      const started = effects.findLast((e) => e.type === 'run_started')
      const failed = effects.findLast((e) => e.type === 'run_ended' && e.outcome === 'failed' && started?.type === 'run_started' && e.runId === started.runId)
      if (failed?.type === 'run_ended') throw new Error([failed.reason, failed.text].filter(Boolean).join(': ') || 'Worker launch failed')
    } catch (error) {
      const reason = failureText(error instanceof Error ? error.message : String(error))
      await c.store.append(i.goalId, { type: 'request_completed', ...at, actor: 'system', requestId: i.requestId, outcome: 'failed', reason })
      throw error
    }
    await c.store.append(i.goalId, { type: 'request_completed', ...at, actor: 'system', requestId: i.requestId, outcome: 'succeeded' })
  })
}
