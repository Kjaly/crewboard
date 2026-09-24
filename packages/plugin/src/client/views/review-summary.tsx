import type { ReactNode } from 'react'
import type { MeasureCoverage, RepoSnapshot } from '../../shared/types.js'
import { getLang, t } from '../i18n.js'
import { durationLabel } from '../insight.js'
import { PROGRESS_BUCKETS, type Measure, type MoneySummary, type PlanProgress, type QuotaWindow, type TimeSummary } from './review-model.js'

type Task = RepoSnapshot['tasks'][number]
const numeric = (value: number) => new Intl.NumberFormat(getLang()).format(value)
export const usd = (value: number) =>
  `USD ${new Intl.NumberFormat(getLang(), { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value)}`
export const pp = (value: number) =>
  `${value > 0 ? '+' : value < 0 ? '−' : '±'}${new Intl.NumberFormat(getLang(), { maximumFractionDigits: 2 }).format(Math.abs(value))} ${t('review.pp')}`
export const shortDate = (value: string) =>
  new Intl.DateTimeFormat(getLang(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
const BUCKET_COLOR: Record<string, string> = { accepted: 'var(--orc-ok)', running: 'var(--orc-accent-strong)', ready: 'var(--orc-accent)', queued: 'var(--orc-fg3)', attention: 'var(--orc-warn)' }

/**
 * The top band: amber only when a decision waits for this person. Failed work gets its own red
 * count and never turns the band calm-green, because failed is not «nothing to do».
 */
export function NeedsBand({ waiting, failed, running, onOpenTask, onWaiting, onFailed, onRuns }: {
  waiting: Task[]
  failed: Task[]
  running: number
  onOpenTask(id: string): void
  onWaiting(): void
  onFailed(): void
  onRuns(): void
}) {
  const tone = waiting.length ? 'warn' : failed.length ? 'neutral' : 'calm'
  return (
    <section className={`orc-needs orc-needs--${tone}`} aria-labelledby="review-needs">
      <div className="orc-needs__text">
        <p className="orc-eyebrow">{t('review.needs.title')}</p>
        <h2 id="review-needs">{waiting.length ? t('review.needs.waiting', { count: waiting.length }) : t('review.needs.none')}</h2>
        {waiting.length ? (
          <p className="orc-needs__tasks">
            {waiting.slice(0, 2).map((task) => (
              <button key={task.id} type="button" className="orc-needs__task" onClick={() => onOpenTask(task.id)}>
                {task.title} →
              </button>
            ))}
            {waiting.length > 2 ? <span>{t('review.needs.more', { count: waiting.length - 2 })}</span> : null}
          </p>
        ) : (
          <p>{running ? t('review.needs.running', { count: running }) : t('review.needs.idle')}</p>
        )}
        {failed.length ? (
          <p className="orc-needs__failed">
            <b>{t('review.needs.failed', { count: failed.length })}</b>{' '}
            <button type="button" className="orc-review__link" onClick={onFailed}>{t('review.needs.showFailed')}</button>
          </p>
        ) : null}
      </div>
      <div className="orc-needs__act">
        <strong className="orc-needs__count" aria-hidden="true">{numeric(waiting.length)}</strong>
        <button type="button" className="orc-needs__action" onClick={waiting.length ? onWaiting : onRuns}>
          {waiting.length ? t('review.needs.open') : t('review.needs.runs')} →
        </button>
      </div>
    </section>
  )
}

/** One labelled distribution of exclusive buckets, then the line that stops «accepted» reading as «verified». */
export function ProgressPanel({ progress }: { progress: PlanProgress }) {
  const { total, superseded, buckets, verdicts } = progress
  const label = PROGRESS_BUCKETS.map((bucket) => `${t(`review.bucket.${bucket}`)} ${numeric(buckets[bucket])}`).join(', ')
  return (
    <section className="orc-rprogress" aria-labelledby="review-progress">
      <div className="orc-review__head">
        <h2 id="review-progress">{t('review.progressTitle')}</h2>
        <span>{t('review.scopeLine', { total: numeric(total), superseded: numeric(superseded) })}</span>
      </div>
      {total ? (
        <>
          <p className="orc-rprogress__number">
            {numeric(buckets.accepted)} <small>/ {t('review.acceptedOf', { total: numeric(total) })}</small>
          </p>
          <div className="orc-rprogress__bar" role="img" aria-label={label}>
            {PROGRESS_BUCKETS.map((bucket) =>
              buckets[bucket] ? <i key={bucket} style={{ width: `${(buckets[bucket] / total) * 100}%`, background: BUCKET_COLOR[bucket] }} /> : null,
            )}
          </div>
          <ul className="orc-rprogress__key">
            {PROGRESS_BUCKETS.map((bucket) => (
              <li key={bucket}>
                <i aria-hidden="true" style={{ background: BUCKET_COLOR[bucket] }} />
                {t(`review.bucket.${bucket}`)} <b>{numeric(buckets[bucket])}</b>
              </li>
            ))}
          </ul>
          {buckets.accepted ? (
            <p className="orc-rprogress__caveat">
              {t('review.verdicts', { result: numeric(verdicts.result), disputed: numeric(verdicts.disputed), negative: numeric(verdicts.negative), untyped: numeric(verdicts.untyped) })}
            </p>
          ) : null}
        </>
      ) : (
        <p className="orc-review__quiet">{t('review.noTasks')}</p>
      )}
    </section>
  )
}

const measureText = <T,>(value: Measure<T>, render: (value: T) => ReactNode, empty = t('review.notObserved')): ReactNode =>
  value.state === 'measured' ? render(value.value) : value.state === 'pending' ? t('review.pendingUsage') : value.state === 'notApplicable' ? empty : t('review.notObserved')

/** Elapsed, then two independent bars. They are not slices of elapsed time and never add up to it. */
export function TimePanel({ time }: { time: TimeSummary }) {
  const elapsed = time.elapsed.state === 'measured' ? time.elapsed.value : 0
  const line = (key: string, value: Measure<number>, color: string) => (
    <div>
      <span>{t(key)}</span>
      <strong>{measureText(value, durationLabel)}</strong>
      <span className="orc-rtime__line" aria-hidden="true">
        <i style={{ width: value.state === 'measured' && elapsed ? `${Math.min(100, (value.value / elapsed) * 100)}%` : '0', background: color }} />
      </span>
    </div>
  )
  return (
    <section className="orc-rtime" aria-labelledby="review-time">
      <h2 id="review-time" className="orc-eyebrow">{t('review.time.title')}</h2>
      <strong className="orc-rtime__elapsed">{time.elapsed.state === 'measured' ? durationLabel(time.elapsed.value) : t('review.noMeasurements')}</strong>
      {time.inferredEnd ? <small>{t('review.inferredEnd')}</small> : null}
      <div className="orc-rtime__lines">
        {line('review.time.worker', time.worker, 'var(--orc-accent-strong)')}
        {line('review.time.wait', time.wait, 'var(--orc-warn)')}
      </div>
      <p className="orc-review__note">{t('review.overlapNote')}{time.waitPartial ? ` ${t('review.historyIncomplete')}.` : ''}</p>
    </section>
  )
}

/** «Codex», «Codex · week-12», never the internal account:provider:window key. */
export const quotaName = (key: string) => {
  const [account, provider, window] = key.split(':')
  const name = (provider ?? '').replace(/^./, (c) => c.toUpperCase()) || t('review.unavailable')
  return [name, window && window !== 'unknown' ? window : '', account && account !== 'unknown' ? account : ''].filter(Boolean).join(' · ')
}

function Resource({ tone, title, value, note, coverage, children }: { tone: string; title: string; value: ReactNode; note: string; coverage: MeasureCoverage; children?: ReactNode }) {
  return (
    <article className={`orc-resource orc-resource--${tone}`}>
      <h3>{title}</h3>
      <strong>{value}</strong>
      <p>{note}</p>
      <span className="orc-resource__bar" aria-hidden="true">
        <i style={{ width: coverage.eligible ? `${(coverage.known / coverage.eligible) * 100}%` : '0' }} />
      </span>
      <small>
        {coverage.eligible ? t('review.coverageLine', { known: coverage.known, total: coverage.eligible }) : t('review.coverageNone')}
        {coverage.lastRunAt ? ` · ${t('review.lastMeasured', { time: shortDate(coverage.lastRunAt) })}` : ''}
      </small>
      {children}
    </article>
  )
}

/** Quota, estimate and cash: three units side by side, each with its coverage; no combined total. */
export function ResourcesPanel({ money, snapshot, sources }: { money: MoneySummary; snapshot: string; sources?: { quota?: ReactNode; estimate?: ReactNode; cash?: ReactNode } }) {
  const windows = (items: QuotaWindow[]) => (
    <span className="orc-resource__windows">
      {items.slice(0, 2).map((item) => (
        <span key={item.key}>
          {quotaName(item.key)} {pp(item.value)}
        </span>
      ))}
      {items.length > 2 ? <small>{t('review.moreWindows', { count: items.length - 2 })}</small> : null}
    </span>
  )
  const quotaNotes = money.quota.state === 'measured' ? money.quota.value : []
  return (
    <section className="orc-resources" aria-labelledby="review-accounting">
      <div className="orc-review__head">
        <h2 id="review-accounting">{t('review.accounting')}</h2>
        <span>{t('review.unitsNote')} · {t('review.updated', { time: shortDate(snapshot) })}</span>
      </div>
      <div className="orc-resources__grid">
        <Resource
          tone="quota"
          title={t('review.quotaChange')}
          value={measureText(money.quota, windows, t('review.noSubscriptionRuns'))}
          note={[t('review.quotaNote'), quotaNotes.some((item) => item.shared) ? t('review.sharedQuota') : '', quotaNotes.some((item) => item.legacy) ? t('review.legacyQuota') : '', quotaNotes.some((item) => item.reset) ? t('drill.reset') : ''].filter(Boolean).join(' · ')}
          coverage={money.coverage.quota}
        >
          {sources?.quota}
        </Resource>
        <Resource
          tone="estimate"
          title={t('review.equivalent')}
          value={measureText(money.estimate, (value) => `≈ ${usd(value)}`, t('review.noSubscriptionRuns'))}
          note={t('review.notCharged')}
          coverage={money.coverage.apiEquivalent}
        >
          {sources?.estimate}
        </Resource>
        <Resource
          tone="cash"
          title={t('review.cash')}
          value={measureText(money.cash, usd, t('review.noApiRuns'))}
          note={t('review.fixedFees')}
          coverage={money.coverage.cash}
        >
          {sources?.cash}
        </Resource>
      </div>
    </section>
  )
}
