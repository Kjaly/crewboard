import { CaretRight, X } from '../icons.js'
import { type ReactNode, useEffect, useRef } from 'react'
import type { AssignmentView, GoalEvent } from '../../model/types.js'
import { T, providerLabel } from '../text.js'
import { Avatar, StatusBadge } from './badges.js'
import { RequestLine } from './request-line.js'

const time = (iso: string) => new Date(iso).toLocaleTimeString(T.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

const EVENT_TEXT: Partial<Record<GoalEvent['type'], (e: GoalEvent) => string>> = {
  goal_started: () => T.event.goal_started,
  assigned: () => T.event.assigned,
  run_started: () => T.event.run_started,
  progress: (e) => (e.type === 'progress' ? (e.code ? T.system(e.code, e.detail) : e.text) : ''),
  question: (e) => (e.type === 'question' ? T.event.question(e.text) : ''),
  escalated: (e) => (e.type === 'escalated' ? T.event.escalated(e.why) : ''),
  answered: (e) => (e.type === 'answered' ? (e.actor === 'owner' ? T.event.answeredByYou(e.text) : T.event.answeredByLead(e.text)) : ''),
  steered: (e) => (e.type === 'steered' ? T.event.steered(e.text) : ''),
  reported: (e) => (e.type === 'reported' ? T.event.reported(e.code ? T.system(e.code) : e.summary) : ''),
  returned: (e) => (e.type === 'returned' ? T.event.returned(e.note) : ''),
  run_ended: (e) => (e.type === 'run_ended' && e.outcome === 'failed' ? T.event.failed(e.reason ?? '') : ''),
  closed: (e) => (e.type === 'closed' ? T.event.closed(e.code ? T.system(e.code) : e.summary) : ''),
  cancelled: (e) => (e.type === 'cancelled' ? T.event.cancelled(e.code ? T.system(e.code, e.detail) : e.reason) : ''),
  adopted: () => T.event.adopted,
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
  const giver = chain.at(-1)
  const aside = useRef<HTMLElement>(null)
  const hidden = props.sheet && !props.open
  // React 18 has no `inert` prop: a closed sheet is set inert by hand, so its buttons leave the tab order.
  useEffect(() => {
    const el = aside.current
    if (!el) return
    if (hidden) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
    if (props.sheet && props.open) el.querySelector<HTMLElement>('.sheet-close')?.focus()
  }, [hidden, props.sheet, props.open])
  const history = events.map((e) => ({ e, text: EVENT_TEXT[e.type]?.(e) ?? '' })).filter((x) => x.text)
  return (
    <aside ref={aside} className={`ctx ${props.sheet && props.open ? 'on' : ''}`} aria-label={T.context}>
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
          <StatusBadge status={node.status} />
          <span>
            <Avatar provider={node.provider} /> <b>{providerLabel(node.provider)}</b> {node.parentId === null ? (props.lead ?? '') : (node.model ?? '')}
          </span>
        </div>
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
        {props.question}
        <section className="sec">
          <h4>{T.origin}</h4>
          <div className="quote">
            <div className="who">{node.quote ? T.you : giver && chain.length > 1 ? providerLabel(giver.provider) : T.lead}</div>
            <p>{node.quote ?? (chain.length > 1 ? T.originByWorker : '')}</p>
          </div>
          {props.onOpenHistory && (
            <button type="button" className="jump press" onClick={props.onOpenHistory}>
              {T.openInHistory}
            </button>
          )}
        </section>
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
                <StatusBadge status={k.status} />
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
