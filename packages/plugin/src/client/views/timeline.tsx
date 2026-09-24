import { useMemo } from 'react'
import type { PlanCost } from '../../shared/types.js'
import { t, useLang } from '../i18n.js'
import { type Segment, agentBadge, durationLabel, planTimeline, usePlanCost, workersWord } from '../insight.js'
import type { TraceTarget } from '../panel/trace.js'
import type { ViewProps } from './types.js'

export type TimelineProps = ViewProps & { onTrace?(target: TraceTarget): void; cost?: PlanCost; now?: Date }

const SEGMENT_TITLE: Record<Segment['kind'], string> = { run: 'timeline.run', review: 'timeline.review', dep: 'timeline.dependency' }

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Five evenly spaced marks plus the now marker: enough to place a bar in time without a ruler. */
function axisTicks(start: number, end: number): Array<{ at: number; label: string }> {
  const step = (end - start) / 5
  return [0, 1, 2, 3, 4].map((i) => ({ at: i * 20, label: hhmm(start + step * i) }))
}

export function TimelineView({ repo, selectedId, onSelect, density, onTrace, cost: given, now = new Date() }: TimelineProps) {
  const lang = useLang()
  const fetched = usePlanCost(repo.root, given ? -1 : repo.rev)
  const cost = given ?? fetched.cost
  // biome-ignore lint/correctness/useExhaustiveDependencies: Locale changes intentionally refresh the translated result.
  const model = useMemo(() => (cost ? planTimeline(repo, cost, now) : null), [repo, cost, now.getTime(), lang])

  if (!cost) return <p className="orc-empty">{fetched.error ? t('timeline.unavailable', { error: fetched.error }) : t('timeline.loading')}</p>
  if (!model || model.rows.length === 0) {
    return <p className="orc-empty">{t('timeline.noRuns')}</p>
  }

  const { start, end, rows, totals, hint } = model
  const span = Math.max(1, end - start)
  const at = (ms: number) => ((ms - start) / span) * 100
  const nowLeft = Math.min(100, Math.max(0, at(now.getTime())))

  return (
    <div className="orc-insight">
      <section className="orc-block" aria-label={t('timeline.title')}>
        <h2 className="orc-block__head">
          <span>{t('timeline.title')}</span>
          <span className="orc-col__count">
            {t('timeline.summary', { plan: durationLabel(totals.planMs), work: durationLabel(totals.workMs) })}
          </span>
        </h2>

        <div className="orc-tl">
          <div className="orc-tl__axis" aria-hidden="true">
            {axisTicks(start, end).map((tick) => (
              <span key={tick.at} style={{ left: `${tick.at}%`, transform: `translateX(-${tick.at}%)` }}>
                {tick.label}
              </span>
            ))}
            <span style={{ left: `${nowLeft}%`, transform: `translateX(-${nowLeft}%)` }}>{t('timeline.now')}</span>
          </div>

          <ul className="orc-tl__rows">
            {rows.map((row) => (
              <li key={row.id} className="orc-tl__row">
                <button
                  type="button"
                  className="orc-tl__name"
                  aria-pressed={selectedId === row.id}
                  onClick={() => onSelect(row.id)}
                  title={`${row.id} · ${row.title}`}
                >
                  {row.agent ? (
                    <span className="orc-wk" aria-hidden="true">
                      {agentBadge(row.agent)}
                    </span>
                  ) : null}
                  <span className="orc-tl__title">{row.title}</span>
                </button>
                <div className="orc-tl__track">
                  {row.segments.map((seg) => {
                    const label = `${row.title}: ${t(SEGMENT_TITLE[seg.kind])}, ${durationLabel(seg.to - seg.from)}`
                    return (
                      <button
                        key={`${seg.kind}-${seg.from}-${seg.runId ?? ''}`}
                        type="button"
                        className={`orc-tl__bar orc-tl__bar--${seg.kind}`}
                        style={{ left: `${at(seg.from)}%`, width: `${Math.max(at(seg.to) - at(seg.from), 0.4)}%` }}
                        aria-label={label}
                        title={label}
                        onClick={() =>
                          seg.runId && seg.agent && onTrace
                            ? onTrace({ taskId: row.id, taskTitle: row.title, run: { runId: seg.runId, agent: seg.agent, startedAt: new Date(seg.from).toISOString(), active: seg.to >= now.getTime() - 1000 } })
                            : onSelect(row.id)
                        }
                      />
                    )
                  })}
                </div>
              </li>
            ))}
          </ul>
          <span
            className="orc-tl__now"
            style={{ left: `calc(var(--orc-tl-name) + (100% - var(--orc-tl-name)) * ${nowLeft / 100})` }}
            aria-hidden="true"
          />
        </div>

        {density === 'detail' ? (
          <div className="orc-legend" aria-hidden="true">
            <span>
              <span className="orc-sw orc-sw--run" />
              {t('timeline.run')}
            </span>
            <span>
              <span className="orc-sw orc-sw--review" />
              {t('timeline.review')}
            </span>
            <span>
              <span className="orc-sw orc-sw--dep" />
              {t('timeline.dependency')}
            </span>
          </div>
        ) : null}

        <p className="orc-answer">
          <b>{t('timeline.speedup')}</b> {hint}
        </p>

        {density === 'detail' ? (
          <dl className="orc-facts">
            <div>
              <dt>{t('timeline.criticalPath')}</dt>
              <dd>{repo.criticalPath.length > 0 ? repo.criticalPath.join(' → ') : t('timeline.undefined')}</dd>
            </div>
            <div>
              <dt>{t('timeline.humanWait')}</dt>
              <dd className={totals.waitMs > 0 ? 'orc-facts__warn' : undefined}>
                {durationLabel(totals.waitMs)}
                {totals.planMs > 0 ? ` · ${Math.round((totals.waitMs / totals.planMs) * 100)} %` : ''}
              </dd>
            </div>
            <div>
              <dt>{t('timeline.parallelism')}</dt>
              <dd>{t('timeline.maxParallel', { workers: workersWord(totals.maxParallel) })}</dd>
            </div>
          </dl>
        ) : null}
      </section>
    </div>
  )
}
