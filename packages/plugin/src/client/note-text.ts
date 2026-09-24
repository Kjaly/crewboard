import type { Note } from '@crewboard/core'
import { t } from './i18n.js'

const by = (who: string | undefined) => (who ? t('feed.note.by', { by: who }) : '')
const preset = (name: string | undefined) => name ?? t('settings.allWorkers')

function verdictText(verdict: NonNullable<Note['verdict']>): string {
  const reason = verdict.why ? t(`verdict.why.${verdict.why}`) : verdict.mismatch ? t(`verdict.mismatch.${verdict.mismatch}`).replace(/\.$/, '') : ''
  return t('feed.note.verdict', { verdict: `${t(`verdict.${verdict.kind}`)}${reason ? ` — ${reason}` : ''}` })
}

/**
 * A feed note in the reader's language. Notes Crewboard wrote carry an event and are rendered from the
 * dictionaries on every render, so the feed follows a live language switch; the free text inside one (a
 * reason, a check note, a correction) and older text-only notes are shown as written.
 */
export function noteText(note: Pick<Note, 'text' | 'event' | 'verdict'>): string {
  const event = note.event
  if (!event) return note.text
  switch (event.kind) {
    case 'check_due': return t('feed.note.checkDue')
    case 'check_taken': return t('feed.note.checkTaken', { by: by(event.by) })
    case 'checked': return t('feed.note.checked', { by: by(event.by), note: event.note })
    case 'check_returned': return t('feed.note.checkReturned', { by: by(event.by), findings: event.findings })
    case 'check_skipped': return t('feed.note.checkSkipped')
    case 'accepted': return [note.verdict ? verdictText(note.verdict) : '', t('feed.note.accepted'), event.evidence ? t('feed.note.evidence', { evidence: event.evidence }) : ''].filter(Boolean).join('; ')
    case 'rejected': return event.reason
    case 'superseded': return t('feed.note.superseded', { by: event.by })
    case 'dropped': return t('feed.note.dropped', { reason: event.reason })
    case 'launched_outside_preset': return t('feed.note.outsidePreset', { preset: preset(event.preset), worker: event.worker })
    case 'preset_fallback': return t('feed.note.presetFallback', { stale: event.stale, preset: preset(event.preset), worker: event.worker })
    case 'steer': return t('feed.note.steer', { state: t(`feed.note.steer.${event.delivery}`), id: event.steerId, detail: event.detail ? ` (${event.detail})` : '', message: event.message })
    case 'worktree': return t(`feed.note.worktree.${event.outcome}`)
    case 'started': return t('feed.note.started', { by: by(event.by) })
  }
}
