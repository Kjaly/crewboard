import { randomBytes } from 'node:crypto'
import type { ProjectContext } from './app.js'
import { availableActions, flatten, isTerminal } from './model/project.js'
import { LEAD_OFFLINE_MS } from './model/thresholds.js'
import type { AssignmentView, ProviderId, RequestAction } from './model/types.js'
import { BadRequestError, ConflictError, goalTree } from './owner.js'

const leadOnline = async (ctx: ProjectContext, goalId: string, now: Date) => {
  const seen = (await ctx.store.readMeta(goalId))?.leadLastSeen
  return seen !== undefined && now.getTime() - new Date(seen).getTime() <= LEAD_OFFLINE_MS
}

const findNode = async (ctx: ProjectContext, goalId: string, assignmentId: string, now: Date): Promise<AssignmentView> => {
  const node = flatten(await goalTree(ctx, goalId, now)).find((n) => n.id === assignmentId)
  if (!node) throw new BadRequestError(`assignment ${assignmentId} not found in goal ${goalId}`)
  return node
}

/** The owner asks the lead for something on a node. The lead hears it through its inbox and decides. */
export function requestAsOwner(ctx: ProjectContext, i: { goalId: string; assignmentId: string; action: RequestAction; text?: string; provider?: ProviderId }, now: Date): Promise<{ requestId: string }> {
  return ctx.exclusive(async (c) => {
    const node = await findNode(c, i.goalId, i.assignmentId, now)
    if (node.request?.state === 'pending' && i.action !== 'discuss') throw new ConflictError('a request for this assignment already waits for the lead')
    if (!availableActions(node, true).includes(i.action)) throw new ConflictError(`${i.action} is not available while the assignment is ${node.status}`)
    if ((i.action === 'clarify' || i.action === 'reopen' || i.action === 'revive') && !i.text?.trim()) throw new BadRequestError('text is required')
    if (i.action === 'handoff' && (!i.provider || i.provider === node.provider)) throw new BadRequestError('handoff needs another provider')
    const requestId = `r-${randomBytes(3).toString('hex')}`
    await c.store.append(i.goalId, {
      type: 'owner_requested', goalId: i.goalId, assignmentId: i.assignmentId, actor: 'owner', requestId, action: i.action,
      ...(i.text?.trim() ? { text: i.text.trim() } : {}), ...(i.provider ? { provider: i.provider } : {}),
    })
    return { requestId }
  })
}

/** The one action without the lead's decision: allowed only while the lead is away, recorded and told to the lead. */
export function emergencyStop(ctx: ProjectContext, i: { goalId: string; assignmentId: string }, now: Date): Promise<void> {
  return ctx.exclusive(async (c) => {
    const node = await findNode(c, i.goalId, i.assignmentId, now)
    if (await leadOnline(c, i.goalId, now)) throw new ConflictError('the lead is online; ask it to stop the work')
    if (!availableActions(node, false).includes('emergency_stop')) throw new ConflictError(`nothing runs on an assignment that is ${node.status}`)
    await c.supervisor.cancelTree(i.goalId, i.assignmentId, 'Emergency stop by the owner: the lead was offline', 'owner', 'emergency_stop')
  })
}

/** The lead's decision on a request. Accepting carries the action out here, so decision and effect never diverge. */
export function decideRequest(ctx: ProjectContext, i: { goalId: string; assignmentId: string; requestId: string; decision: 'accepted' | 'declined'; reason?: string }, now: Date): Promise<void> {
  return ctx.exclusive(async (c) => {
    const node = await findNode(c, i.goalId, i.assignmentId, now)
    const asked = (await c.store.read(i.goalId)).findLast((e) => e.type === 'owner_requested' && e.requestId === i.requestId)
    if (asked?.type !== 'owner_requested' || asked.assignmentId !== i.assignmentId) throw new BadRequestError(`request ${i.requestId} not found on assignment ${i.assignmentId}`)
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
    if (!availableActions({ ...node, request: undefined }, true).includes(asked.action)) throw new ConflictError(`cannot ${asked.action}: the assignment is ${node.status}`)
    // The decision is recorded before the effect: if the effect fails, the request reads as accepted (the owner can
    // ask again) instead of staying pending with half an effect applied and the node locked.
    await decided()
    const at = { goalId: i.goalId, assignmentId: i.assignmentId }
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
        if (asked.provider) await c.supervisor.reassign(i.goalId, i.assignmentId, asked.provider)
        break
      case 'start_now':
        await c.store.append(i.goalId, { type: 'unblocked', ...at, actor: 'lead' })
        await c.supervisor.tick()
        break
      case 'reopen':
      case 'revive':
        await c.store.append(i.goalId, { type: 'reopened', ...at, actor: 'owner', note: asked.text ?? '' })
        await c.supervisor.deliver(i.goalId, i.assignmentId, `The owner brought the work back: ${asked.text ?? ''}`)
        break
      case 'discuss':
        break
    }
  })
}
