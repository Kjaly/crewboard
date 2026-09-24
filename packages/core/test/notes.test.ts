import { describe, expect, it } from 'vitest'
import { eventNote, noteFallbackText } from '../src/plan/notes.js'
import { NoteSchema, TaskSchema } from '../src/plan/schema.js'

const AT = '2026-09-24T10:00:00.000Z'

describe('feed notes as events', () => {
  it('stores the event beside an English line for readers that do not render events', () => {
    expect(eventNote(AT, 'check', { kind: 'checked', by: 'orchestrator', note: 'gates green' })).toEqual({ at: AT, type: 'check', text: 'checked (orchestrator): gates green', event: { kind: 'checked', by: 'orchestrator', note: 'gates green' } })
    expect(eventNote(AT, 'accept', { kind: 'accepted', evidence: 'e.json' }, { verdict: { kind: 'disputed', mismatch: 'no_files' } })).toMatchObject({ text: 'verdict: disputed — no_files; accepted by a person; evidence: e.json', verdict: { kind: 'disputed' } })
  })

  it('keeps the wording older readers match: steer audit prefixes and the outside-preset line', () => {
    expect(noteFallbackText({ kind: 'steer', delivery: 'refused', steerId: 's1', detail: 'completed', message: 'stop' })).toBe('refused [s1] (completed): stop')
    expect(noteFallbackText({ kind: 'launched_outside_preset', worker: 'codex' })).toMatch(/^Launched by hand outside the preset “All workers”: codex$/)
  })

  it('parses older text-only notes unchanged and round-trips an event', () => {
    expect(NoteSchema.parse({ at: AT, type: 'accept', text: 'принято человеком' })).toEqual({ at: AT, type: 'accept', text: 'принято человеком' })
    const note = eventNote(AT, 'comment', { kind: 'superseded', by: 'b' })
    expect(NoteSchema.parse(JSON.parse(JSON.stringify(note)))).toEqual(note)
  })

  it('drops an event kind this build does not know instead of refusing the plan', () => {
    const task = TaskSchema.parse({ id: 'a', title: 'A', kind: 'implement', status: 'ready', notes: [{ at: AT, type: 'comment', text: 'from a newer build', event: { kind: 'from_the_future', x: 1 } }] })
    expect(task.notes).toEqual([{ at: AT, type: 'comment', text: 'from a newer build' }])
    expect(NoteSchema.parse({ at: AT, type: 'check', text: 'x', event: { kind: 'checked', note: 5 } }).event).toBeUndefined()
    expect(NoteSchema.parse({ at: AT, type: 'comment', text: 'x', event: { kind: 'worktree', outcome: 'lost' } }).event).toBeUndefined()
    // A known event keeps fields a newer build added, so writing the plan back does not drop them (pq1).
    expect(NoteSchema.parse({ at: AT, type: 'check', text: 'x', event: { kind: 'checked', note: 'ok', extra: 1 } }).event).toEqual({ kind: 'checked', note: 'ok', extra: 1 })
  })
})
