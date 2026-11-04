import type { CSSProperties } from 'react'
import type { CostCell, GoalAnalytics } from '../../analytics.js'
import type { ProviderId } from '../../model/types.js'
import { agentOf } from '../agents.js'
import { T, providerLabel } from '../text.js'
import { Avatar } from './badges.js'

const money = (v: number | undefined) => (v === undefined ? T.noData : `$${v.toFixed(2)}`)
const tokens = (v: number | undefined) => (v === undefined ? T.noData : v.toLocaleString(T.locale))
const ms = (iso: string) => new Date(iso).getTime()
const clock = (t: number) => new Date(t).toLocaleTimeString(T.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Provider lanes over the goal's time and what the runs cost; for looking back, not for steering. */
export function AnalyticsView(props: { analytics: GoalAnalytics | undefined; failed?: boolean; onRetry?: () => void }) {
  const a = props.analytics
  if (props.failed) return <div role="alert"><p>{T.loadFailed}</p><button type="button" className="btn press" onClick={props.onRetry}>{T.retry}</button></div>
  if (!a) return <p className="hint">{T.loading}</p>
  const from = ms(a.from)
  const span = Math.max(ms(a.to) - from, 60_000)
  const pct = (t: number) => ((t - from) / span) * 100
  // Four marks from the start; the end mark would hang past the right edge.
  const ticks = Array.from({ length: 4 }, (_, i) => from + (span * i) / 4)
  const costRow = (name: string, cell: CostCell, provider?: ProviderId) => (
    <tr key={name}>
      <th scope="row">
        {provider && <Avatar provider={provider} />} {name}
      </th>
      <td>{cell.runs}</td>
      <td>{cell.usd === undefined && cell.subscriptionRuns > 0 ? T.bySubscription : money(cell.usd)}</td>
      <td>{money(cell.apiUsd)}</td>
      <td>
        {tokens(cell.inputTokens)} / {tokens(cell.outputTokens)}
      </td>
    </tr>
  )
  return (
    <div className="ana">
      <p className="hint">{T.analyticsHint}</p>
      {a.lanes.length === 0 && <p className="hint">{T.analyticsEmpty}</p>}
      {a.lanes.length > 0 && (
        <div className="lanes">
          <div className="axis">
            <div />
            <div className="ticks">
              {ticks.map((t) => (
                <span key={t} style={{ left: `${pct(t)}%` }}>
                  {clock(t)}
                </span>
              ))}
            </div>
          </div>
          {a.lanes.map((lane) => {
            const rows: number[] = []
            const placed = lane.bars.map((b) => {
              const s = ms(b.start)
              const e = b.end ? ms(b.end) : ms(a.to)
              let r = rows.findIndex((end) => end <= s)
              if (r < 0) {
                r = rows.length
                rows.push(0)
              }
              rows[r] = e
              return { b, s, e, r }
            })
            return (
              <section className="lane" key={lane.provider} aria-label={providerLabel(lane.provider)}>
                <div className="lane-h">
                  <Avatar provider={lane.provider} />
                  {providerLabel(lane.provider)}
                </div>
                <div className="track" style={{ height: Math.max(56, 20 + rows.length * 32) }}>
                  {placed.map(({ b, s, e, r }) => (
                    <div
                      key={`${b.assignmentId}-${b.start}`}
                      className={`lb ${b.outcome === 'failed' || b.outcome === 'cancelled' ? 'cancel' : ''}`}
                      data-agent={lane.provider}
                      style={{ left: `${pct(s)}%`, width: `${Math.max(pct(e) - pct(s), 2)}%`, top: 10 + r * 32, ...(agentOf(lane.provider)?.color ? { '--ag': agentOf(lane.provider)?.color } : {}) } as CSSProperties}
                      title={b.title}
                    >
                      {b.title}
                    </div>
                  ))}
                  <div className="nowline" style={{ left: '100%' }} />
                </div>
              </section>
            )
          })}
        </div>
      )}
      <table className="costs">
        <caption>{T.costsByProvider}</caption>
        <thead>
          <tr>
            <th scope="col">{T.costCols.who}</th>
            <th scope="col">{T.costCols.runs}</th>
            <th scope="col">{T.costCols.money}</th>
            <th scope="col">{T.costCols.api}</th>
            <th scope="col">{T.costCols.tokens}</th>
          </tr>
        </thead>
        <tbody>{Object.entries(a.byProvider).map(([p, cell]) => costRow(providerLabel(p) ?? p, cell, p as ProviderId))}</tbody>
      </table>
      <table className="costs">
        <caption>{T.costsByModel}</caption>
        <thead>
          <tr>
            <th scope="col">{T.costCols.model}</th>
            <th scope="col">{T.costCols.runs}</th>
            <th scope="col">{T.costCols.money}</th>
            <th scope="col">{T.costCols.api}</th>
            <th scope="col">{T.costCols.tokens}</th>
          </tr>
        </thead>
        <tbody>{Object.entries(a.byModel).map(([model, cell]) => costRow(model || T.noData, cell))}</tbody>
      </table>
      {a.byAssignment.length > 0 && (
        <table className="costs">
          <caption>{T.costsByAssignment}</caption>
          <thead>
            <tr>
              <th scope="col">{T.costCols.what}</th>
              <th scope="col">{T.costCols.runs}</th>
              <th scope="col">{T.costCols.money}</th>
              <th scope="col">{T.costCols.api}</th>
              <th scope="col">{T.costCols.tokens}</th>
            </tr>
          </thead>
          <tbody>{a.byAssignment.map((row) => costRow(row.title, row, row.provider))}</tbody>
        </table>
      )}
    </div>
  )
}
