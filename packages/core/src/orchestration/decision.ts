import { readNoteEvent, type Note, type Task } from '../plan/schema.js'

/**
 * What a person decided about a task (wk1, B23). `answered` — a decision task accepted: the person answered it;
 * `sent_back` — Send back (`reject`), with the reason the next run reads; `merged` and `marked_merged` — the
 * person's Merge or Mark as merged. Automatic records (a merge found on sync, by content) are not decisions.
 */
export const DECISION_VERDICTS = ['accepted', 'answered', 'sent_back', 'dropped', 'superseded', 'merged', 'marked_merged'] as const
export type DecisionVerdict = (typeof DECISION_VERDICTS)[number]
/**
 * The latest human decision on a task: who, when, what, and the reason the person gave, when there is one.
 * `answer` and `basis` (dc1): on a chat-recorded `answered` — what the person answered and where they said it.
 */
export type LastDecision = { by: 'person' | 'orchestrator'; at: string; verdict: DecisionVerdict; reason?: string; answer?: string; basis?: string }

type DecisionTask = Pick<Task, 'kind'> & { notes: ReadonlyArray<Note> }

function decisionOf(task: DecisionTask, note: Note): LastDecision | undefined {
  const event = note.event ? readNoteEvent(note.event) : undefined
  const make = (verdict: DecisionVerdict, reason?: string, by: LastDecision['by'] = 'person'): LastDecision => ({ by, at: note.at, verdict, ...(reason?.trim() ? { reason: reason.trim() } : {}) })
  if (!event) {
    // Notes written before events: the type alone says accept or send back; a send back's text is its reason.
    if (note.type === 'accept') return make(task.kind === 'decision' ? 'answered' : 'accepted')
    if (note.type === 'reject') return make('sent_back', note.text)
    return undefined
  }
  switch (event.kind) {
    case 'accepted': return make(task.kind === 'decision' ? 'answered' : 'accepted', undefined, event.by === 'orchestrator' ? 'orchestrator' : 'person')
    // dc1: the person answered in chat; the orchestrator only recorded it — `by` is honest about that.
    case 'answered': return { ...make('answered', undefined, 'orchestrator'), answer: event.answer, basis: event.basis }
    // dc1: back to preparation at the person's word reads as a send back the chat hears like any other.
    case 'decision_prepare': return make('sent_back', event.reason, 'orchestrator')
    case 'rejected': return make('sent_back', event.reason)
    case 'dropped': return make('dropped', event.reason)
    case 'superseded': return make('superseded', event.by)
    case 'merged': return make('merged')
    case 'marked_merged': return make('marked_merged', event.reason)
    default: return undefined
  }
}

/** The task's latest human decision, read from its feed; undefined — nobody decided anything on it yet. */
export function lastDecisionOf(task: DecisionTask): LastDecision | undefined {
  for (const note of [...task.notes].reverse()) {
    const decision = decisionOf(task, note)
    if (decision) return decision
  }
  return undefined
}

/**
 * The reason of a Send back no run has read yet (wk1, B29): the task's latest decision is a send back made after
 * its last run started. The next run's prompt carries it, whoever starts that run.
 */
export function pendingSendBack(task: DecisionTask & Pick<Task, 'runs'>): string | undefined {
  const decision = lastDecisionOf(task)
  if (decision?.verdict !== 'sent_back' || !decision.reason) return undefined
  const started = task.runs.at(-1)?.startedAt
  if (started && Date.parse(started) >= Date.parse(decision.at)) return undefined
  return decision.reason
}

/** The per-run block the next run's prompt carries after a Send back (tk1 order: after the contract). */
export const sendBackBlock = (reason: string): string =>
  ['<send_back>', 'A person reviewed the previous result and sent it back. Their reason:', reason.trim(), 'Address this in this run and say in your report how you did.', '</send_back>'].join('\n')
