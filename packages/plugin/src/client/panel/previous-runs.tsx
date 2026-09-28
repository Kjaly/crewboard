import type { TaskDetail, WorkerInfo } from '../../shared/types.js'
import { t } from '../i18n.js'
import { identityLabel, workerIdentity } from '../provider.js'

type Run = TaskDetail['runs'][number]
/** A run a person sent back (wk1, B29): its 1-based number, the run and the reason the next run read. */
export type ReturnedRun = { number: number; run: Run; reason: string; at: string }

const reasonOf = (note: TaskDetail['notes'][number]): string => (note.event?.kind === 'rejected' ? note.event.reason : note.text)

/**
 * Every run except the last that a person sent back before the next one started: the Send back note falls after
 * the run started and before its successor did. A run nobody sent back (failed, continued) is not listed.
 */
export function returnedRuns(detail: Pick<TaskDetail, 'runs' | 'notes'>): ReturnedRun[] {
  const out: ReturnedRun[] = []
  detail.runs.forEach((run, i) => {
    const next = detail.runs[i + 1]
    if (!next) return
    const from = Date.parse(run.startedAt)
    const to = Date.parse(next.startedAt)
    const sentBack = detail.notes.filter((note) => note.type === 'reject' && Date.parse(note.at) >= from && Date.parse(note.at) <= to).at(-1)
    if (sentBack) out.push({ number: i + 1, run, reason: reasonOf(sentBack), at: sentBack.at })
  })
  return out
}

/**
 * The earlier runs a person returned, folded (wk1, B29): «Run 1 (returned)» with its worker, how it ended and the
 * reason — so the rerun is reviewed with the first attempt in view. Activity opens that run's feed.
 */
export function PreviousRuns({ detail, workers, onOpenRun }: { detail: Pick<TaskDetail, 'runs' | 'notes'>; workers?: readonly WorkerInfo[]; onOpenRun(runId: string): void }) {
  const returned = returnedRuns(detail)
  if (returned.length === 0) return null
  return (
    <section className="orc-overview-section" aria-label={t('panel.task.prevRuns')}>
      {returned.map(({ number, run, reason, at }) => (
        <details key={run.runId} className="orc-prev-run">
          <summary>{t('panel.task.prevRun', { count: number })}</summary>
          <p className="orc-meta">
            {identityLabel(workerIdentity(run.agent, workers))}
            {' · '}
            {run.outcome ? t(`panel.tabs.outcome.${run.outcome}`) : t('panel.tabs.runActive')}
            {' · '}
            <time dateTime={at}>{new Date(at).toLocaleString()}</time>
          </p>
          <p className="orc-prev-run__reason">{t('panel.task.prevRunReason', { reason })}</p>
          <button type="button" className="orc-run__link" onClick={() => onOpenRun(run.runId)}>{t('panel.task.prevRunActivity')}</button>
        </details>
      ))}
    </section>
  )
}
