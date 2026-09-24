import { useEffect, useState } from 'react'
import { api, type DraftJobDetail, type DraftJobSummary } from './api.js'
import { describeApiError } from './actions.js'
import { t, useLang } from './i18n.js'
import { clockLabel } from './insight.js'

export const jobTitle = (job: DraftJobSummary) => job.spec ?? (job.source === 'chat' ? t('panel.draft.chat') : job.source.name)

/**
 * A draft that is still being made, or whose worker answer was refused. The raw answer is always shown:
 * the person can read it, send it back to a worker with the validator findings, or drop the job.
 */
export function DraftJobView({ repo, job, onDraft, onDiscarded, onClose }: { repo: string; job: DraftJobSummary; onDraft(id: string): void; onDiscarded(id: string): void; onClose(): void }) {
  useLang()
  const [detail, setDetail] = useState<DraftJobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const running = job.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  // The summary comes from the polled job list; the raw answer is read again whenever the job moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updatedAt is the signal that the stored answer changed.
  useEffect(() => {
    let live = true
    void api.planDraftJob(repo, job.id).then((result) => {
      if (!live) return
      if (result.ok) setDetail(result.value)
      else setError(describeApiError(result.error, result.message))
    }).catch(() => { if (live) setError(t('actions.noConnection')) })
    return () => { live = false }
  }, [repo, job.id, job.updatedAt])
  useEffect(() => { if (job.status === 'completed' && job.draftId) onDraft(job.draftId) }, [job.status, job.draftId, onDraft])
  const act = async (kind: 'repair' | 'discard') => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = kind === 'repair' ? await api.planDraftJobRepair(repo, job.id) : await api.planDraftJobDiscard(repo, job.id)
      if (!result.ok) { setError(describeApiError(result.error, result.message)); return }
      if (kind === 'discard') onDiscarded(job.id)
      setConfirmDiscard(false)
    } catch { setError(t('actions.noConnection')) }
    finally { setPending(false) }
  }
  const answer = detail?.answer
  return <article className="orc-draft" aria-label={t('panel.draftJob.title')}>
    <div className="orc-draft__head"><div><span className="orc-draft__eyebrow">{t('panel.draftJob.title')}</span><h1>{jobTitle(job)}</h1><p>{t('panel.draftJob.worker', { worker: job.agent })}{job.attempts > 1 ? ` · ${t('panel.draftJob.attempt', { count: job.attempts })}` : ''}</p></div><button type="button" className="orc-link" onClick={onClose}>{t('panel.draft.close')}</button></div>
    {error ? <p className="orc-error" role="alert">{error}</p> : null}
    <section className="orc-draft__findings" aria-live="polite">
      {running ? <p><i className="orc-sdot orc-sdot--running" aria-hidden="true" /> {t('panel.draftJob.running', { time: clockLabel(now - Date.parse(job.startedAt)) })}</p> : null}
      {job.status === 'needs_repair' ? <>
        <h2>{t('panel.draftJob.needsRepair')}</h2>
        <p>{t('panel.draftJob.needsRepairHelp')}</p>
        <ul>{(job.findings ?? []).map((finding, index) => <li key={`${finding.path}-${index}`} className="orc-draft__finding--block"><code>{finding.path || t('panel.draftJob.wholeAnswer')}</code> {finding.message}</li>)}</ul>
      </> : null}
      {job.status === 'failed' ? <><h2>{t('panel.draftJob.failed')}</h2><p>{t('panel.draftJob.failedHelp', { error: job.error ?? '' })}</p></> : null}
      {job.recoveredFrom ? <p>{t('panel.draftJob.recovered', { run: job.recoveredFrom })}</p> : null}
    </section>
    {answer !== undefined ? <section className="orc-draft__decisions"><details open={job.status === 'needs_repair'}><summary>{t('panel.draftJob.answer')}</summary><pre className="orc-draft__answer">{answer}</pre></details></section> : null}
    <div className="orc-draft__actions">
      {running ? null : <button type="button" className="orc-draft__approve" disabled={pending} onClick={() => void act('repair')}>{job.status === 'failed' && answer === undefined ? t('panel.draftJob.retry') : t('panel.draftJob.repair')}</button>}
      {confirmDiscard ? <span className="orc-draft__confirm">{t('panel.draftJob.discardConfirm')} <button type="button" disabled={pending} onClick={() => void act('discard')}>{t('panel.draftJob.discardYes')}</button><button type="button" onClick={() => setConfirmDiscard(false)}>{t('panel.draft.cancel')}</button></span> : <button type="button" className="orc-link" disabled={pending} onClick={() => setConfirmDiscard(true)}>{t('panel.draft.discard')}</button>}
    </div>
  </article>
}
