import { LEAD_SILENT_PAUSE_MS, STALE_ABANDON_MS } from './thresholds.js'
import type { AssignmentView, Doing, EventOf, GoalEvent, ProviderId, RequestAction, Status } from './types.js'
import type { AgentEntry } from '../workers/agents.js'

export type StatusContext = { parentStatus: Status | null; isRoot: boolean; now: Date; leadLastSeen?: Date }

const TERMINAL: ReadonlySet<Status> = new Set(['done', 'cancelled', 'abandoned'])
export const isTerminal = (s: Status): boolean => TERMINAL.has(s)
/** Finished from the point of view of whoever waits on it: terminal, or a split-off part that reported to its parent. */
export const isSettled = (s: Status): boolean => TERMINAL.has(s) || s === 'reported'

/** Where a status counts in summaries (the tree's and the sidebar's alike). A reported part is work not yet accepted. */
export type StatusBucket = 'waiting_owner' | 'waiting_lead' | 'running' | 'queued' | 'finished'
export function statusBucket(s: Status): StatusBucket | undefined {
  if (s === 'waiting_owner') return 'waiting_owner'
  if (s === 'waiting_answer') return 'waiting_lead'
  if (s === 'running' || s === 'reported') return 'running'
  if (s === 'queued') return 'queued'
  if (TERMINAL.has(s)) return 'finished'
  return undefined
}

/** A part a worker split off whose latest run ended with its final result (not a further split). */
const reportedPart = (own: GoalEvent[]): boolean => {
  if (!own.some((e) => e.type === 'assigned' && e.actor === 'worker')) return false
  const started = lastOf(own, 'run_started')
  const reported = lastOf(own, 'reported')
  const ended = lastOf(own, 'run_ended')
  if (!started || !reported || reported.split || reported.seq < started.seq) return false
  return !!ended && ended.seq > started.seq && ended.outcome === 'completed' && seqOf(lastOf(own, 'reopened')) < started.seq
}

const lastOf = <T extends GoalEvent['type']>(own: GoalEvent[], type: T): EventOf<T> | undefined => {
  return own.findLast((e): e is EventOf<T> => e.type === type)
}
const seqOf = (e: GoalEvent | undefined): number => e?.seq ?? 0

/** One assignment's status from its own events and its parent's status. Rules in the spec, «Модель». */
export function deriveStatus(own: GoalEvent[], ctx: StatusContext): Status {
  const reopened = lastOf(own, 'reopened')
  const closed = lastOf(own, 'closed')
  const cancelled = lastOf(own, 'cancelled')
  const finishedAt = Math.max(seqOf(closed), seqOf(cancelled))
  if (finishedAt > seqOf(reopened)) {
    if (cancelled && seqOf(cancelled) >= seqOf(closed)) return 'cancelled'
    return 'done'
  }
  // A reported part follows its parent: the lead's close of the parent covers it, a cancelled parent abandons it.
  if (reportedPart(own)) {
    if (ctx.parentStatus === 'done') return 'done'
    if (ctx.parentStatus && TERMINAL.has(ctx.parentStatus)) return 'abandoned'
    return 'reported'
  }
  if (ctx.parentStatus && TERMINAL.has(ctx.parentStatus)) return 'abandoned'
  if (reopened && !ctx.isRoot) {
    // Brought back: until a new run starts the move is the lead's (relaunch), or the work is simply queued again.
    const startedAfter = own.some((e) => e.type === 'run_started' && e.seq > reopened.seq)
    if (!startedAfter) return own.some((e) => e.type === 'run_started') ? 'waiting_answer' : 'queued'
  }

  const question = lastOf(own, 'question')
  const answered = lastOf(own, 'answered')
  // A question raised to the owner waits for them until answered, whether it was the worker's or the lead's own.
  const escalated = lastOf(own, 'escalated')
  if (escalated && seqOf(escalated) > seqOf(answered)) return 'waiting_owner'
  if (question && seqOf(question) > seqOf(answered)) return 'waiting_answer'

  if (ctx.isRoot) {
    if (ctx.leadLastSeen && ctx.now.getTime() - ctx.leadLastSeen.getTime() > LEAD_SILENT_PAUSE_MS) return 'paused'
    return 'running'
  }

  const started = lastOf(own, 'run_started')
  if (!started) return 'queued'
  const ended = lastOf(own, 'run_ended')
  if (ended && seqOf(ended) > seqOf(started)) {
    const reported = lastOf(own, 'reported')
    const quietFor = ctx.now.getTime() - new Date(own.at(-1)?.ts ?? ended.ts).getTime()
    if (seqOf(reported) < seqOf(started) && quietFor > STALE_ABANDON_MS) return 'abandoned'
    // The run is over (a result or a failure) and nothing new started: the move is the lead's — close, return,
    // retry or cancel. Shown as «Ждёт ведущего», never as a live «Идёт».
    return 'waiting_answer'
  }
  return 'running'
}

/** What a node is doing now, for the line under it. */
export function doingOf(own: GoalEvent[], status: Status, titles: ReadonlyMap<string, string> = new Map()): Doing {
  if (status === 'done') {
    const closed = lastOf(own, 'closed')
    if (closed?.code) return { kind: 'system', code: closed.code }
    return closed?.summary ? { kind: 'text', text: closed.summary } : { kind: 'done' }
  }
  if (status === 'cancelled') {
    const c = lastOf(own, 'cancelled')
    return { kind: 'cancelled', reason: c?.reason ?? '', ...(c?.code ? { code: c.code } : {}), ...(c?.detail !== undefined ? { detail: c.detail } : {}) }
  }
  if (status === 'abandoned') return { kind: 'abandoned' }
  if (status === 'paused') return { kind: 'paused' }
  if (status === 'waiting_owner') return { kind: 'waiting_owner' }
  if (status === 'reported') return { kind: 'reported_to_parent' }
  const reopenedLast = lastOf(own, 'reopened')
  if (reopenedLast && reopenedLast.seq >= seqOf(lastOf(own, 'run_started'))) return { kind: 'returned', note: reopenedLast.note }
  if (status === 'waiting_answer') {
    const question = lastOf(own, 'question')
    if (question && seqOf(question) > seqOf(lastOf(own, 'answered'))) return { kind: 'asking', text: question.text }
  }
  if (status === 'queued') {
    const after = lastOf(own, 'assigned')?.after ?? []
    return after.length ? { kind: 'after', titles: after.map((id) => titles.get(id) ?? id) } : { kind: 'queued' }
  }
  const latest = own[own.length - 1]
  if (own.some((e) => e.type === 'goal_started')) return { kind: 'leading' }
  if (latest?.type === 'run_ended' && latest.outcome === 'failed') return latest.reason || latest.text ? { kind: 'failed', reason: [latest.reason, latest.text].filter(Boolean).join(': ') } : { kind: 'failed' }
  const reported = lastOf(own, 'reported')
  if (reported && seqOf(reported) >= seqOf(lastOf(own, 'run_started'))) return { kind: 'reported' }
  const progress = lastOf(own, 'progress')
  if (progress?.code) return { kind: 'system', code: progress.code, ...(progress.detail !== undefined ? { detail: progress.detail } : {}) }
  return progress?.text ? { kind: 'text', text: progress.text } : { kind: 'working' }
}

function requestOf(own: GoalEvent[]): AssignmentView['request'] {
  // A discussion note needs no decision and must not hide a request that still waits.
  const asked = own.findLast((e): e is EventOf<'owner_requested'> => e.type === 'owner_requested' && e.action !== 'discuss')
  if (!asked) return undefined
  const decided = own.findLast((e): e is EventOf<'request_decided'> => e.type === 'request_decided' && e.requestId === asked.requestId)
  if (own.some((e) => e.type === 'request_withdrawn' && e.requestId === asked.requestId)) return undefined
  const completed = own.findLast((e): e is EventOf<'request_completed'> => e.type === 'request_completed' && e.requestId === asked.requestId)
  const base = { id: asked.requestId, ts: asked.ts, action: asked.action, ...(asked.text ? { text: asked.text } : {}), ...(asked.provider ? { provider: asked.provider } : {}), ...(asked.model ? { model: asked.model } : {}), ...(asked.effort !== undefined ? { effort: asked.effort } : {}) }
  if (completed?.outcome === 'failed') return { ...base, state: 'failed', ...(completed.reason ? { reason: completed.reason } : {}) }
  if (!decided) {
    // Work closed or cancelled after the request makes it moot: it no longer pins the node.
    const moot = own.some((e) => e.seq > asked.seq && (e.type === 'closed' || e.type === 'cancelled'))
    return moot ? undefined : { ...base, state: 'pending' }
  }
  if (decided.decision === 'accepted') return undefined
  // A declined request stays visible until the work moves on (a new run, a close or a new request).
  const movedOn = own.some((e) => e.seq > decided.seq && (e.type === 'run_started' || e.type === 'closed' || e.type === 'cancelled' || e.type === 'reopened'))
  return movedOn ? undefined : { ...base, state: 'declined', ...(decided.reason ? { reason: decided.reason } : {}) }
}

function handoffsOf(own: GoalEvent[]): { provider?: ProviderId; model?: string; effort?: string; handoffs: AssignmentView['handoffs'] } {
  const assigned = lastOf(own, 'assigned')
  let provider = assigned?.provider
  let model = assigned?.model
  let effort = assigned?.effort
  const handoffs: AssignmentView['handoffs'] = []
  for (const e of own) {
    if (e.type !== 'reassigned' || !provider) continue
    handoffs.push({ from: provider, to: e.provider })
    provider = e.provider
    model = e.model
    effort = e.effort
  }
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}), handoffs }
}

/** What the owner may ask for on a node. `emergency_stop` is offered on every live node: the owner can always stop work. */
export function availableActions(node: AssignmentView): Array<RequestAction | 'emergency_stop'> {
  if (node.parentId === null) return ['discuss']
  const live = node.status === 'running' || node.status === 'waiting_answer'
  // A waiting request leaves only discussion, but never hides the emergency stop.
  if (node.request?.state === 'pending') return live ? ['discuss', 'emergency_stop'] : ['discuss']
  const byStatus: Partial<Record<Status, RequestAction[]>> = {
    running: ['clarify', 'stop', 'handoff', 'discuss'],
    waiting_answer: ['clarify', 'stop', 'handoff', 'discuss'],
    queued: ['start_now', 'cancel', 'handoff', 'discuss'],
    done: ['reopen', 'discuss'],
    cancelled: ['revive', 'discuss'],
    abandoned: ['revive', 'discuss'],
  }
  const actions: Array<RequestAction | 'emergency_stop'> = (byStatus[node.status] ?? ['discuss']).filter(
    (a) => !(node.underFinished && (a === 'revive' || a === 'reopen')),
  )
  if (live) actions.push('emergency_stop')
  return actions
}

/** The goal's tree with derived statuses and, when supplied, current agent defaults. The root's id is the goal id. */
export function buildTree(events: GoalEvent[], now: Date, leadLastSeen: Date | undefined, agents: readonly Pick<AgentEntry, 'id' | 'model' | 'effort'>[] = []): AssignmentView {
  const defaults = new Map(agents.map((a) => [a.id, a]))
  const byId = new Map<string, GoalEvent[]>()
  for (const e of events) {
    const list = byId.get(e.assignmentId)
    if (list) list.push(e)
    else byId.set(e.assignmentId, [e])
  }
  const start = events.find((e): e is EventOf<'goal_started'> => e.type === 'goal_started')
  if (!start) throw new Error('goal has no goal_started event')
  const titles = new Map<string, string>([[start.assignmentId, start.title]])
  const kids = new Map<string, string[]>()
  for (const e of events) {
    if (e.type !== 'assigned') continue
    titles.set(e.assignmentId, e.title)
    const list = kids.get(e.parentId)
    if (list) list.push(e.assignmentId)
    else kids.set(e.parentId, [e.assignmentId])
  }
  const node = (id: string, parentStatus: Status | null, parentFinished = false): AssignmentView => {
    const own = byId.get(id) ?? []
    const isRoot = id === start.assignmentId
    const status = deriveStatus(own, { parentStatus, isRoot, now, ...(leadLastSeen ? { leadLastSeen } : {}) })
    const a = isRoot ? undefined : lastOf(own, 'assigned')
    const run = lastOf(own, 'run_started')
    const chain = handoffsOf(own)
    const view: AssignmentView = {
      id,
      parentId: isRoot ? null : (a?.parentId ?? null),
      title: titles.get(id) ?? id,
      criteria: isRoot ? start.criteria : (a?.criteria ?? []),
      resultKind: a?.resultKind ?? 'goal',
      provider: chain.provider ?? 'lead',
      handoffs: chain.handoffs,
      ...(parentFinished || (parentStatus !== null && TERMINAL.has(parentStatus)) ? { underFinished: true } : {}),
      after: a?.after ?? [],
      status,
      doing: doingOf(own, status, titles),
      children: [],
    }
    const quote = isRoot ? start.quote : a?.quote
    if (quote) view.quote = quote
    if (a?.branch) view.branch = a.branch
    const agent = isRoot ? undefined : defaults.get(view.provider)
    // A model marks a resolved snapshot: an absent effort there means the run used no explicit effort.
    const snapshot = run?.model !== undefined
    const nextModel = chain.model ?? agent?.model
    const nextEffort = chain.effort ?? agent?.effort
    const model = snapshot ? run.model : nextModel
    const effort = snapshot ? run.effort : nextEffort
    if (model) view.model = model
    if (effort !== undefined) view.effort = effort
    if (snapshot) {
      const origin = own.findLast((e): e is EventOf<'assigned'> | EventOf<'reassigned'> => (e.type === 'assigned' || e.type === 'reassigned') && e.seq < run.seq)
      if (origin) view.runProvider = origin.provider
      if (seqOf(lastOf(own, 'reassigned')) > run.seq) {
        view.pendingRun = { ...(nextModel !== undefined ? { model: nextModel } : {}), ...(nextEffort !== undefined ? { effort: nextEffort } : {}) }
      }
    }
    const request = requestOf(own)
    if (request) view.request = request
    if (run) Object.assign(view, { runId: run.runId, agent: run.agent, cwd: run.cwd, runOpen: !own.some((e) => e.type === 'run_ended' && e.runId === run.runId) })
    view.children = (kids.get(id) ?? []).map((k) => node(k, status, view.underFinished === true))
    // A worker waiting for the parts it split off is still at work, not waiting for the lead.
    const splitOff = view.children.filter((k) => (byId.get(k.id) ?? []).some((e) => e.type === 'assigned' && e.actor === 'worker'))
    if (splitOff.length && view.status === 'waiting_answer' && splitOff.some((k) => !isSettled(k.status))) {
      view.status = 'running'
      view.doing = { kind: 'children', done: splitOff.filter((k) => isSettled(k.status)).length, total: splitOff.length }
    }
    return view
  }
  return node(start.assignmentId, null)
}

/** Every node of a tree, depth first. */
export function flatten(root: AssignmentView): AssignmentView[] {
  const out: AssignmentView[] = []
  const walk = (n: AssignmentView) => {
    out.push(n)
    n.children.forEach(walk)
  }
  walk(root)
  return out
}
