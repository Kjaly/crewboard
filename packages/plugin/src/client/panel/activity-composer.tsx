import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SteerRecord, SteerResult } from '@crewboard/core'
import { t, useLang } from '../i18n.js'

/** A delivery result together with the exact text that produced it, so a newer draft is never mislabelled. */
export type SteerFeedback = { result: SteerResult; text: string }

/**
 * The real composer for the latest live run. It sends once through the existing steer API — plain Enter is a
 * newline, Ctrl/⌘+Enter sends — and shows the API's own queued/delivered/refused/abandoned outcome. The
 * machine id stays in a diagnostic `title`, never the human line. A newer draft is never overwritten or
 * falsely disabled by an older response: feedback is keyed to its own text.
 *
 * When the run has finished the composer stays as a read-only record of what was typed: an unsent draft is
 * preserved (copy it, or take the explicit relaunch path), and a delivered text is never called unsent.
 * «Ask for progress» only prefills and focuses; it never sends and never replaces what the person wrote.
 */
export function ActivityComposer({
  value,
  onChange,
  onSend,
  pending,
  outcome,
  record,
  onRelaunch,
  focusSignal,
  readOnly,
  unconfirmed,
}: {
  value: string
  onChange(text: string): void
  onSend(): void
  pending: boolean
  outcome: SteerFeedback | null
  /** The current steer record from the task detail, when the host already reported it. */
  record?: SteerRecord
  onRelaunch(): void
  focusSignal: number
  readOnly?: boolean
  /** A restored in-flight request that outlived its window: unknown, not failed — the draft is kept. */
  unconfirmed?: boolean
}) {
  useLang()
  const field = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (focusSignal > 0) field.current?.focus()
  }, [focusSignal])
  useLayoutEffect(() => {
    const textarea = field.current
    if (!textarea) return
    textarea.style.height = 'auto'
    if (value && textarea.scrollHeight) textarea.style.height = `${Math.min(textarea.scrollHeight, 168)}px`
  }, [value])

  const draft = value.trim()
  const result = outcome?.result
  const deliveredSame = result?.delivery === 'delivered' && outcome?.text === draft
  // The record advances past the receipt: queued → sent/acknowledged, or abandoned/refused. With no record,
  // the API's first answer is labelled as what it is — the state at request time, not the current one.
  const abandoned = record?.state === 'abandoned' || result?.delivery === 'abandoned'
  const refused = record?.state === 'refused' || result?.delivery === 'refused'
  const failed = result?.delivery === 'failed'
  const state = record?.state ?? (result?.delivery === 'delivered' ? result.state : result?.delivery === 'abandoned' ? 'abandoned' : result?.delivery === 'refused' ? 'refused' : undefined)
  const abandonedReason = record?.reason ?? (result?.delivery === 'abandoned' ? result.reason : undefined) ?? 'run_finished'
  const unsent = !!draft && !deliveredSame

  const askProgress = () => {
    // A prefill, never a send: an existing draft is left exactly as it is.
    if (!value.trim()) onChange(t('panel.activity.askProgressText'))
    field.current?.focus()
  }
  const send = () => { if (draft && !pending && !deliveredSame && !readOnly) onSend() }
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }

  return (
    <section className="orc-composer" aria-label={t('panel.activity.messageLabel')}>
      <div className="orc-composer__surface" aria-busy={pending}>
        <textarea
          ref={field}
          className="orc-composer__field"
          aria-label={t('panel.activity.messageLabel')}
          placeholder={t('panel.activity.messagePlaceholder')}
          value={value}
          rows={2}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="orc-composer__row">
          {readOnly ? (
            draft ? <button type="button" className="orc-composer__copy" onClick={copy}>{copied ? t('panel.activity.copied') : t('panel.activity.copyDraft')}</button> : null
          ) : (
            <>
              <button type="button" className="orc-composer__ask" onClick={askProgress}>{t('panel.activity.askProgress')}</button>
              <button type="button" className="orc-composer__send" aria-label={t('panel.task.send')} title={pending ? t('panel.activity.sending') : t('panel.task.send')} disabled={pending || !draft || deliveredSame} onClick={send}>
                {pending ? <span className="orc-composer__spinner" aria-hidden="true" /> : <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 14V4m0 0L4.75 8.25M9 4l4.25 4.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            </>
          )}
        </div>
      </div>
      {unsent && readOnly ? <p className="orc-hint" role="status">{t('panel.activity.unsent')}</p> : null}
      {failed ? <p role="alert" className="orc-error">{t('panel.task.steerFailed', { reason: result?.delivery === 'failed' ? result.reason : '' })}</p> : null}
      {abandoned ? (
        <div role="status">
          <p className="orc-hint" title={result?.steerId}>{t('panel.activity.steerAbandoned', { reason: t(`panel.task.steerReason.${abandonedReason}`) })}</p>
          <button type="button" className="orc-btn" disabled={pending} onClick={onRelaunch}>{t('panel.task.relaunchWithCorrection')}</button>
        </div>
      ) : null}
      {refused ? (
        <div role="status">
          <p className="orc-hint" title={result?.steerId}>{result?.delivery === 'refused' && result.reason === 'legacy_unverified_policy' ? t('panel.task.steerRefusedPolicy') : t('panel.task.steerRefused', { state: result?.delivery === 'refused' ? result.runState : '' })}</p>
          <button type="button" className="orc-btn" disabled={pending} onClick={onRelaunch}>{t('panel.task.relaunchWithCorrection')}</button>
        </div>
      ) : null}
      {unconfirmed ? <p role="status" className="orc-hint">{t('panel.activity.receiptUnconfirmed')}</p> : null}
      {!failed && !abandoned && !refused && state ? (
        <p role="status" className="orc-hint" title={result?.steerId}>
          {t(`panel.task.steerState.${state}`)}{record ? '' : ` · ${t('panel.activity.receiptInitial')}`}
        </p>
      ) : null}
      {readOnly ? null : <p className="orc-composer__hint" role={pending ? 'status' : undefined}>{pending ? t('panel.activity.sending') : t('panel.activity.sendHint')}</p>}
    </section>
  )
}
