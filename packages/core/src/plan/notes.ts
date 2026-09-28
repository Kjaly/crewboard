import type { Note, NoteEvent, Task } from './schema.js'

const by = (who: string | undefined) => (who ? ` (${who})` : '')
const preset = (name: string | undefined) => name ?? 'Default: workers that pass checks'
const VERDICT_WHY = { blocked: 'work is blocked', negative: 'negative result received' } as const

/**
 * The English line stored beside an event for readers that do not render events. Its wording is kept
 * from the text notes it replaces: the steer audit prefix (`delivered [id]`) and the «Launched by hand
 * outside the preset» line are still matched by older readers.
 */
export function noteFallbackText(event: NoteEvent, verdict?: Note['verdict']): string {
  switch (event.kind) {
    case 'check_due': return 'check due: the orchestrator checks the work before it waits for you'
    case 'check_taken': return `checking${by(event.by)}`
    case 'checked': return `checked${by(event.by)}: ${event.note}`
    case 'result_attested': return `independent ${event.verdict} attestation${by(event.by)} for ${event.runId} at ${event.head}; proof: ${event.report} (${event.proofHash})`
    case 'check_returned': return `returned${by(event.by)}: ${event.findings}`
    case 'check_skipped': return 'check skipped: the orchestrator check was turned off'
    case 'accepted': {
      const reason = verdict?.why ? ` — ${VERDICT_WHY[verdict.why]}` : verdict?.mismatch ? ` — ${verdict.mismatch}` : ''
      return `${verdict ? `verdict: ${verdict.kind}${reason}; ` : ''}accepted by ${event.by === 'orchestrator' ? 'the orchestrator' : 'a person'}${event.evidence ? `; evidence: ${event.evidence}` : ''}`
    }
    case 'answered': return `answered by the person via the orchestrator: “${event.answer}” — basis: ${event.basis}`
    case 'decision_prepare': return `back to preparation${by(event.by)}: ${event.reason}${event.report ? ` — earlier report kept at ${event.report}` : ''}`
    case 'rejected': return event.reason
    case 'superseded': return `superseded by task ${event.by}`
    case 'dropped': return `closed as not needed: ${event.reason}`
    case 'launched_outside_preset': return `Launched by hand outside the preset “${preset(event.preset)}”: ${event.worker}`
    case 'worker_skipped': return `${event.skipped} skipped: ${event.reason} → ${event.worker}`
    case 'preset_fallback': return `Worker ${event.stale}, chosen by an agent, is no longer in the preset “${preset(event.preset)}” for this class — ran by the preset order instead: ${event.worker}. The assignment was cleared.`
    case 'steer': return `${event.delivery} [${event.steerId}]${event.detail ? ` (${event.detail})` : ''}: ${event.message}`
    case 'started': return `taken in work by the orchestrator${by(event.by)}`
    case 'merged': return `merged into ${event.into}${event.strategy === 'squash' ? ' as one commit (squash)' : ''}: ${event.commit.slice(0, 12)}`
    case 'merged_by_content': return `merged into ${event.into} by content: every file the copy changed without a commit is already there`
    case 'marked_merged': return `marked as merged into ${event.into} by a person: ${event.reason}`
    case 'worktree': return event.outcome === 'removed' ? 'Worktree removed after acceptance.' : event.outcome === 'kept_recent' ? 'Worktree kept: one of the three most recently accepted.' : 'Worktree kept: branch is not merged yet.'
  }
}

/** A feed note Crewboard writes: the event for the screen, the English line for everyone else. */
export function eventNote(at: string, type: Note['type'], event: NoteEvent, extra: Pick<Note, 'verdict' | 'check'> = {}): Note {
  return { at, type, text: noteFallbackText(event, extra.verdict), event, ...extra }
}

/**
 * dc1: the latest step on this decision sent it back into the orchestrator's preparation — `decision
 * prepare` cleared the check, and no newer step (a fresh «checked», an answer, a person's verdict)
 * stands after the record. It marks preparation even for a plan without an orchestrator chat; a
 * decision that never carried the record keeps the older rule and waits for the person.
 */
export function backInPreparation(task: Pick<Task, 'notes'>): boolean {
  for (let i = task.notes.length - 1; i >= 0; i--) {
    const kind = task.notes[i]?.event?.kind
    if (kind === 'decision_prepare') return true
    if (kind === 'checked' || kind === 'answered' || kind === 'accepted' || kind === 'rejected' || kind === 'superseded' || kind === 'dropped') return false
  }
  return false
}
