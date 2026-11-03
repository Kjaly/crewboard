import { z } from 'zod'

/** An agent's id from the registry (src/workers/agents.ts). Journals keep it in the `provider` field. */
export type ProviderId = string
export const RESULT_KINDS = ['local', 'branch', 'answer', 'decision'] as const
export type ResultKind = (typeof RESULT_KINDS)[number]
/** Never stored: always derived from the journal (model/project.ts). `paused` belongs to a goal's root alone. */
export type Status = 'queued' | 'running' | 'waiting_answer' | 'waiting_owner' | 'reported' | 'done' | 'cancelled' | 'abandoned' | 'paused'
export type Actor = 'lead' | 'owner' | 'worker' | 'system'
export const REQUEST_ACTIONS = ['clarify', 'stop', 'handoff', 'start_now', 'cancel', 'reopen', 'revive', 'discuss'] as const
export type RequestAction = (typeof REQUEST_ACTIONS)[number]
/** Texts Crewboard itself writes into a journal. Stored as a code, so the screen words them in the owner's language. */
export const SYSTEM_TEXTS = ['emergency_stop', 'owner_stop', 'run_failed', 'parent_cancelled', 'no_report', 'split', 'split_truncated', 'split_registry'] as const
export type SystemText = (typeof SYSTEM_TEXTS)[number]

const base = {
  seq: z.number().int().positive(),
  ts: z.string(),
  goalId: z.string().min(1),
  assignmentId: z.string().min(1),
  actor: z.enum(['lead', 'owner', 'worker', 'system']),
}
const text = z.string()

export const goalEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('goal_started'), title: text, criteria: z.array(text), quote: text.optional(), client: text.optional() }),
  z.object({
    ...base,
    type: z.literal('assigned'),
    parentId: z.string().min(1),
    title: text,
    criteria: z.array(text),
    resultKind: z.enum(RESULT_KINDS),
    provider: z.string().min(1),
    model: text.optional(),
    effort: text.optional(),
    quote: text.optional(),
    after: z.array(z.string()),
  }),
  z.object({ ...base, type: z.literal('run_started'), runId: text, agent: text, cwd: text }),
  z.object({ ...base, type: z.literal('progress'), text, code: z.enum(SYSTEM_TEXTS).optional(), detail: text.optional() }),
  z.object({ ...base, type: z.literal('question'), text, options: z.array(text) }),
  z.object({ ...base, type: z.literal('escalated'), text, options: z.array(text), why: text }),
  z.object({ ...base, type: z.literal('answered'), text }),
  z.object({ ...base, type: z.literal('steered'), text }),
  z.object({ ...base, type: z.literal('reported'), summary: text, split: z.boolean().optional(), code: z.enum(SYSTEM_TEXTS).optional() }),
  z.object({ ...base, type: z.literal('returned'), note: text }),
  z.object({
    ...base,
    type: z.literal('run_ended'),
    runId: text,
    outcome: z.enum(['completed', 'failed', 'cancelled']),
    reason: text.optional(),
    usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), usd: z.number().optional(), apiUsd: z.number().optional(), billing: z.enum(['subscription', 'api']).optional() }).optional(),
  }),
  z.object({ ...base, type: z.literal('closed'), summary: text, code: z.enum(SYSTEM_TEXTS).optional() }),
  z.object({ ...base, type: z.literal('cancelled'), reason: text, code: z.enum(SYSTEM_TEXTS).optional(), detail: text.optional() }),
  z.object({ ...base, type: z.literal('adopted'), note: text.optional(), client: text.optional() }),
  z.object({ ...base, type: z.literal('owner_requested'), requestId: text, action: z.enum(REQUEST_ACTIONS), text: text.optional(), provider: z.string().min(1).optional(), model: text.optional(), effort: text.optional() }),
  z.object({ ...base, type: z.literal('request_decided'), requestId: text, decision: z.enum(['accepted', 'declined']), reason: text.optional() }),
  z.object({ ...base, type: z.literal('reassigned'), provider: z.string().min(1), model: text.optional(), effort: text.optional() }),
  z.object({ ...base, type: z.literal('unblocked') }),
  z.object({ ...base, type: z.literal('reopened'), note: text }),
])

export type GoalEvent = z.infer<typeof goalEventSchema>
/** What a run cost, as far as its backend knows; an absent field means «no data», never zero. */
export type RunCost = NonNullable<EventOf<'run_ended'>['usage']>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type NewEvent = DistributiveOmit<GoalEvent, 'seq' | 'ts'>
export type EventOf<T extends GoalEvent['type']> = Extract<GoalEvent, { type: T }>

export type AssignmentView = {
  id: string
  parentId: string | null
  title: string
  criteria: string[]
  resultKind: ResultKind | 'goal'
  provider: ProviderId | 'lead'
  /** Next run's choices: the latest assignment or handoff overrides, else the current registry defaults. */
  model?: string
  effort?: string
  quote?: string
  after: string[]
  status: Status
  doing: Doing
  runId?: string
  /** The latest run has not ended yet: what the run feed follows (a node waiting for its parts runs without one). */
  runOpen?: boolean
  agent?: string
  cwd?: string
  /** The owner's latest request while it waits for the lead, or after the lead declined it. */
  request?: { id: string; action: RequestAction; text?: string; provider?: ProviderId; model?: string; effort?: string; state: 'pending' | 'declined'; reason?: string }
  /** Every change of worker, oldest first: the work's continuity across providers. */
  handoffs: Array<{ from: ProviderId; to: ProviderId }>
  /** An ancestor is finished (done, cancelled, abandoned): the work cannot be brought back from here. */
  underFinished?: boolean
  children: AssignmentView[]
}

/** What a node is doing now, as data: the screen words it in the owner's language. */
export type Doing =
  | { kind: 'text'; text: string }
  | { kind: 'done' }
  | { kind: 'cancelled'; reason: string; code?: SystemText; detail?: string }
  | { kind: 'system'; code: SystemText; detail?: string }
  | { kind: 'abandoned' }
  | { kind: 'paused' }
  | { kind: 'waiting_owner' }
  | { kind: 'returned'; note: string }
  | { kind: 'asking'; text: string }
  | { kind: 'after'; titles: string[] }
  | { kind: 'queued' }
  | { kind: 'leading' }
  | { kind: 'failed'; reason?: string }
  | { kind: 'reported' }
  | { kind: 'reported_to_parent' }
  | { kind: 'working' }
  | { kind: 'children'; done: number; total: number }
