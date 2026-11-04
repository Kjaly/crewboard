import { useEffect, useRef } from 'react'
import type { GoalHistory, HistoryItem } from '../../history/sessions.js'
import { flatten } from '../../model/project.js'
import type { AssignmentView } from '../../model/types.js'
import { leadLabel } from '../../lead/clients.js'
import { T } from '../text.js'
import { Avatar, StatusBadge } from './badges.js'

const time = (iso: string) => (iso ? new Date(iso).toLocaleString(T.locale, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '')

/** The conversation with the lead as a ribbon; assignments appear as cards where they were handed out. */
export function HistoryView(props: { failed?: boolean; onRetry?: () => void; history: GoalHistory | undefined; tree: AssignmentView; onOpenNode: (id: string) => void; focusAssignment?: string; onFocused: () => void }) {
  const { history, tree } = props
  const box = useRef<HTMLDivElement>(null)
  const byId = new Map(flatten(tree).map((n) => [n.id, n]))

  useEffect(() => {
    if (!props.focusAssignment || !history) return
    const el = box.current?.querySelector<HTMLElement>(`[data-assignment="${CSS.escape(props.focusAssignment)}"]`) ?? box.current?.querySelector<HTMLElement>('.msg')
    if (!el) return
    el.scrollIntoView?.({ block: 'center' })
    el.setAttribute('data-focused', '')
    const off = setTimeout(() => {
      el.removeAttribute('data-focused')
      props.onFocused()
    }, 1500)
    return () => clearTimeout(off)
  }, [props.focusAssignment, history, props.onFocused])

  if (props.failed) return <div role="alert"><p>{T.loadFailed}</p><button type="button" className="btn press" onClick={props.onRetry}>{T.retry}</button></div>
  if (!history) return <p className="hint">{T.loading}</p>
  if (!history.available) {
    const quotes = flatten(tree).filter((n) => n.quote)
    return (
      <div className="hist" ref={box}>
        <p className="hint">{T.historyUnavailable}</p>
        {quotes.map((n) => (
          <div className="msg" key={n.id}>
            <span className="av you" aria-hidden="true">
              {T.meInitial}
            </span>
            <div>
              <div className="who">{n.title}</div>
              <p>{n.quote}</p>
            </div>
          </div>
        ))}
      </div>
    )
  }
  const row = (item: HistoryItem, i: number) => {
    if (item.kind === 'session') return <div key={`s${i}`} className="session">{T.historySession(time(item.ts))}{history.source === 'journal' && leadLabel(item.sessionId) !== 'lead' ? ` · ${leadLabel(item.sessionId)}` : ''}</div>
    if (item.kind === 'actions') return <div key={`a${i}`} className="actions-count">{T.actionsCount(item.count)}</div>
    if (item.kind === 'owner' || item.kind === 'lead')
      return (
        <div className="msg" key={`m${i}`}>
          <span className={`av ${item.kind === 'owner' ? 'you' : 'claude'}`} aria-hidden="true">
            {item.kind === 'owner' ? T.meInitial : 'C'}
          </span>
          <div>
            <div className="who">
              {item.kind === 'owner' ? T.you : T.lead} · {time(item.ts)}
            </div>
            <p className="text">{item.text}</p>
          </div>
        </div>
      )
    if (item.kind !== 'assignment') return null
    const node = item.assignmentId ? byId.get(item.assignmentId) : undefined
    // Only handing work out is a card to open; every other call (start, close, cancel, escalate…) is a milestone line.
    if (item.tool !== 'assign') {
      const label = T.historyTool[item.tool as keyof typeof T.historyTool] ?? item.tool
      const subject = node?.title ?? item.title
      return (
        <div key={`g${i}`} className="milestone">
          {label}
          {subject ? `: ${subject}` : ''}
        </div>
      )
    }
    const title = node?.title ?? item.title ?? T.historyTool[item.tool as keyof typeof T.historyTool] ?? item.tool
    return (
      <button
        type="button"
        key={`c${i}`}
        className="dcard press"
        data-assignment={item.assignmentId}
        aria-disabled={node ? undefined : true}
        onClick={() => node && props.onOpenNode(node.id)}
      >
        {node && <Avatar provider={node.provider} />}
        <span className="t">{title}</span>
        {node && <StatusBadge status={node.status} />}
      </button>
    )
  }
  return (
    <div className="hist" ref={box}>
      {history.source === 'journal' && <p className="hint">{T.historyFromJournal}</p>}
      {history.truncated && <p className="hint">{T.historyTruncated}</p>}
      {history.items.map(row)}
    </div>
  )
}
