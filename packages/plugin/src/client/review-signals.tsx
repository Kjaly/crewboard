import type { ReviewCheck, VerdictBrief } from '@crewboard/core'
import { orchestraStore } from './store.js'
import { t } from './i18n.js'

/**
 * What a person reads before deciding on finished work (vc1, B27): the verdict with its short reason and the
 * orchestrator's check — on the graph card, in Work, in Needs you and in the task panel, in the same words.
 */

/** The reason a verdict carries, shortest first: a declared deviation, why it is negative, what is disputed. */
const reasonOf = (verdict: VerdictBrief): string | undefined => verdict.caution ?? verdict.why ?? verdict.mismatch

/** «Disputed · no files changed». A result with a declared deviation reads as a caution, not as a clean result. */
export function verdictText(verdict: VerdictBrief): string {
  const reason = reasonOf(verdict)
  return `${t(`verdict.${verdict.kind}`)}${reason ? ` · ${t(`verdict.reasonShort.${reason}`)}` : ''}`
}

/** `result`, `caution`, `negative` or `disputed` — the colour of the verdict's mark. */
export const verdictTone = (verdict: VerdictBrief): string => (verdict.kind === 'result' && verdict.caution ? 'caution' : verdict.kind)

export const verdictMark = (verdict: VerdictBrief): string => (verdict.kind === 'result' ? (verdict.caution ? '!' : '✓') : verdict.kind === 'negative' ? '−' : '?')

/** The check state in full: «No orchestrator check — off for this plan (no orchestrator chat)». */
export const checkText = (check: ReviewCheck): string => t(check.state === 'off' ? `check.state.off.${check.source}` : `check.state.${check.state}`)

/** For a line with no room for the reason: the off state names itself briefly, the reason stays in the title. */
export const checkShort = (check: ReviewCheck): string => (check.state === 'off' ? t('check.state.offShort') : checkText(check))

export const checkMark = (check: ReviewCheck): string => (check.state === 'checked' ? '✓' : check.state === 'off' ? '–' : '◌')

/** A compact line of both signals, for a card or a queue row. */
export function ReviewSignals({ verdict, check }: { verdict?: VerdictBrief; check?: ReviewCheck }) {
  if (!verdict && !check) return null
  return (
    <span className="orc-signals">
      {verdict ? <span className={`orc-signal orc-verdict--${verdictTone(verdict)}`} title={verdictText(verdict)}><span className="orc-verdict__mark" aria-hidden="true">{verdictMark(verdict)}</span>{verdictText(verdict)}</span> : null}
      {check ? <span className={`orc-signal orc-signal--check-${check.state}`} title={checkText(check)}><span aria-hidden="true">{checkMark(check)} </span>{checkShort(check)}</span> : null}
    </span>
  )
}

/** The panel's line above Accept / Send back: the full check state, and for «off» where it is changed. */
export function ReviewCheckLine({ check, note }: { check: ReviewCheck; note?: string }) {
  if (check.state === 'checked') {
    if (note) return <details className="orc-vcheck" role="note"><summary className="orc-vcheck__head"><span aria-hidden="true">✓ </span>{checkText(check)}</summary><p className="orc-vcheck__note">{note}</p></details>
    return <p className="orc-vcheck" role="note"><span aria-hidden="true">✓ </span>{checkText(check)}</p>
  }
  if (check.state === 'off') {
    return (
      <p className="orc-vcheck orc-vcheck--off" role="note">
        <span aria-hidden="true">– </span>{checkText(check)}{' '}
        <button type="button" className="orc-run__link" onClick={() => orchestraStore.navigate({ view: 'settings' })}>{t('check.state.settings')}</button>
      </p>
    )
  }
  return <p className="orc-vcheck" role="status"><span aria-hidden="true">◌ </span>{checkText(check)}</p>
}
