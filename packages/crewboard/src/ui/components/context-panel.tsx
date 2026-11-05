import { CaretRight, X } from '../icons.js'
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import type { AssignmentView, EventOf, GoalEvent } from '../../model/types.js'
import { useModal } from '../use-modal.js'
import { T, providerLabel } from '../text.js'
import { Avatar, StatusBadge } from './badges.js'
import { RequestLine, requestContent } from './request-line.js'

const time = (iso: string) => new Date(iso).toLocaleTimeString(T.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

const EVENT_TEXT: Partial<Record<GoalEvent['type'], (e: GoalEvent) => string>> = {
  goal_started: () => T.event.goal_started,
  assigned: () => T.event.assigned,
  external_tracked: () => T.external.tracked,
  external_progress: (e) => e.type === 'external_progress' ? e.text : '',
  external_finished: (e) => e.type === 'external_finished' ? T.event.reported(e.summary) : '',
  run_started: () => T.event.run_started,
  progress: (e) => (e.type === 'progress' ? (e.code ? T.system(e.code, e.detail) : e.text) : ''),
  question: (e) => (e.type === 'question' ? T.event.question(e.text) : ''),
  escalated: (e) => (e.type === 'escalated' ? T.event.escalated(e.why) : ''),
  answered: (e) => (e.type === 'answered' ? (e.actor === 'owner' ? T.event.answeredByYou(e.text) : T.event.answeredByLead(e.text)) : ''),
  steered: (e) => (e.type === 'steered' ? T.event.steered(e.text) : ''),
  reported: (e) => (e.type === 'reported' ? T.event.reported(e.code ? T.system(e.code) : e.summary) : ''),
  returned: (e) => (e.type === 'returned' ? T.event.returned(e.note) : ''),
  run_ended: (e) => (e.type === 'run_ended' && e.outcome === 'failed' ? T.event.failed([e.reason, e.text].filter(Boolean).join(': ')) : ''),
  closed: (e) => (e.type === 'closed' ? T.event.closed(e.code ? T.system(e.code) : e.summary) : ''),
  cancelled: (e) => (e.type === 'cancelled' ? T.event.cancelled(e.code ? T.system(e.code, e.detail) : e.reason) : ''),
  adopted: () => T.event.adopted,
  owner_requested: (e) => e.type === 'owner_requested' ? T.event.ownerRequested(requestContent(e)) : '',
  request_decided: (e) => e.type === 'request_decided' ? (e.decision === 'accepted' ? T.event.requestAccepted : T.event.requestDeclined(e.reason ?? '')) : '',
  request_completed: (e) => e.type === 'request_completed' ? (e.outcome === 'succeeded' ? T.event.requestSucceeded : T.event.requestFailed(e.reason ?? '')) : '',
  request_withdrawn: () => T.event.requestWithdrawn,
}

export function ContextPanel(props: {
  node: AssignmentView
  chain: AssignmentView[]
  events: GoalEvent[]
  onSelect: (id: string) => void
  question?: ReactNode
  actions?: ReactNode
  onOpenHistory?: () => void
  sheet: boolean
  open: boolean
  onClose: () => void
  /** The client that leads the goal (Claude Code, Codex, …), shown on the root. */
  lead?: string
}) {
  const { node, chain, events, onSelect } = props
  const external = node.external
  const provider = node.runProvider ?? node.provider
  const giver = chain.at(-1)
  const aside = useRef<HTMLElement>(null)
  const hidden = props.sheet && !props.open
  // React 18 has no `inert` prop: a closed sheet is set inert by hand, so its buttons leave the tab order.
  useLayoutEffect(() => {
    const el = aside.current
    if (!el) return
    if (hidden) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [hidden])
  useModal(aside, props.sheet && props.open, props.onClose)
  const modal = props.sheet && props.open ? { role: 'dialog', 'aria-modal': true as const } : {}
  const waiting = node.status === 'waiting_owner'
  const report = events.findLast((e): e is EventOf<'reported'> => e.type === 'reported' && e.assignmentId === node.id)
  const worker = (
    <span>
      <Avatar provider={provider} leadClient={props.lead} /> <b>{providerLabel(provider)}</b> {node.parentId === null ? (props.lead ?? '') : (node.model ?? '')}
      {node.parentId !== null && node.effort && `, ${T.effort[node.effort] ?? node.effort}`}
    </span>
  )
  let from: string | undefined
  const history = events.map((e, index) => {
    if (e.type === 'assigned') from = e.provider
    if (e.type === 'reassigned') {
      // Legacy handoffs may omit a model; use the first run's snapshot before the next handoff.
      const next = events.slice(index + 1).find((event) => event.type === 'run_started' || event.type === 'reassigned')
      const model = e.model ?? e.resolvedModel ?? (next?.type === 'run_started' ? next.model : undefined)
      const text = T.event.reassigned(from ? providerLabel(from) : T.noData, providerLabel(e.provider), model ?? T.noData)
      from = e.provider
      return { e, text }
    }
    return { e, text: EVENT_TEXT[e.type]?.(e) ?? '' }
  }).filter((x) => x.text)
  return (
    <aside ref={aside} {...modal} tabIndex={-1} className={`ctx ${props.sheet && props.open ? 'on' : ''}`} aria-label={T.context}>
      <div className="ctx-in">
        <div className="ctx-h">
          <h2>{node.title}</h2>
          {props.sheet && (
            <button type="button" className="icon-btn sheet-close press" aria-label={T.close} onClick={props.onClose}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="meta">
          <StatusBadge status={node.status} external={external} />
          {external ? node.model && <span>{node.model}</span> : !waiting && worker}
        </div>
        {external && (
          <section className="sec" aria-label={T.external.source}>
            <dl className="external-details">
              <dt>{T.external.source}</dt>
              <dd>{T.external.kind[external.kind]}</dd>
              {external.phase && <><dt>{T.external.phase}</dt><dd>{external.phase}</dd></>}
              {external.externalId && <><dt>{T.external.id}</dt><dd className="mono">{external.externalId}</dd></>}
            </dl>
            <p>{T.doing(node.doing)}</p>
          </section>
        )}
        {waiting && props.question}
        {waiting && !external && <div className="meta">{worker}</div>}
        {chain.length > 0 && (
          <nav className="crumbs" aria-label={T.assignedBy}>
            {chain.map((c, i) => (
              <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <CaretRight size={11} aria-hidden="true" />}
                <button type="button" className="press" onClick={() => onSelect(c.id)}>
                  {c.title}
                </button>
              </span>
            ))}
          </nav>
        )}
        <RequestLine request={node.request} />
        {props.actions}
        {!waiting && props.question}
        {report && (
          <section className="sec report" aria-label={T.result}>
            <h4>{T.result}</h4>
            <p>{report.code ? T.system(report.code) : report.summary}</p>
            {report.detail && <p>{report.detail}</p>}
            {report.schemaError && (
              <div className="report-error">
                <b>{T.schemaError}</b>
                <p>{report.schemaError}</p>
              </div>
            )}
            {report.result !== undefined && (
              <details key={`${node.id}:${report.seq}`} className="report-json">
                <summary>JSON</summary>
                <pre className="mono">{JSON.stringify(report.result, null, 2)}</pre>
              </details>
            )}
          </section>
        )}
        <section className="sec">
          <h4>{T.origin}</h4>
          <div className="quote">
            <div className="who">{node.quote ? T.you : !node.external && giver && chain.length > 1 ? providerLabel(giver.provider) : T.lead}</div>
            <p>{node.quote ?? (node.external ? T.originExternal : chain.length > 1 ? T.originByWorker : '')}</p>
          </div>
          {props.onOpenHistory && (
            <button type="button" className="jump press" onClick={props.onOpenHistory}>
              {T.openInHistory}
            </button>
          )}
        </section>
        {node.reviews && node.reviews.length > 0 && (
          <section className="sec">
            <h4>{T.locale.startsWith('ru') ? 'Ревью' : 'Reviews'}</h4>
            {node.reviews.map((review) => (
              <div key={review.id}>
                <button type="button" className="jump press" onClick={() => onSelect(review.id)}>{review.id}</button>{' '}
                <span className="mono">{review.commit?.slice(0, 12) ?? '…'}</span>{' · '}
                {review.verdict ?? '…'}{' · '}
                {review.stale === undefined ? '…' : review.stale ? (T.locale.startsWith('ru') ? 'устарело' : 'stale') : (T.locale.startsWith('ru') ? 'актуально' : 'current')}
                {review.findings && <span> · {Object.entries(review.findings.reduce<Record<string, number>>((counts, finding) => { counts[finding.severity] = (counts[finding.severity] ?? 0) + 1; return counts }, {})).map(([severity, count]) => `${severity}: ${count}`).join(', ') || '0'}</span>}
              </div>
            ))}
          </section>
        )}
        {node.criteria.length > 0 && (
          <section className="sec">
            <h4>{T.criteria}</h4>
            <ul className="crit">
              {node.criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        )}
        {node.children.length > 0 && (
          <section className="sec">
            <h4>{T.inside}</h4>
            {node.children.map((k) => (
              <button type="button" key={k.id} className={`n press ${k.status}`} onClick={() => onSelect(k.id)}>
                <Avatar provider={k.provider} />
                <span className="t">{k.title}</span>
                <StatusBadge status={k.status} external={k.external} />
              </button>
            ))}
          </section>
        )}
        {history.length > 0 && (
          <section className="sec">
            <h4>{T.history}</h4>
            <ul className="events">
              {history.map(({ e, text }) => (
                <li key={e.seq}>
                  <time className="mono">{time(e.ts)}</time>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {node.cwd && (
          <section className="sec">
            <h4>{T.workdir}</h4>
            <div className="links">
              <code className="mono">{node.cwd}</code>
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}
