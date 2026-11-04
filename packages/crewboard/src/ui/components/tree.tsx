import { useEffect, useRef, useState } from 'react'
import { CaretRight } from '../icons.js'
import type { AssignmentView, Status } from '../../model/types.js'
import { T } from '../text.js'
import { Avatar, StatusBadge } from './badges.js'
import { requestText } from './request-line.js'
import { RunFeed } from './run-feed.js'
import type { Api } from '../api.js'

const ORDER: Record<Status, number> = { waiting_owner: 0, waiting_answer: 1, running: 2, reported: 2, paused: 2, queued: 3, done: 4, cancelled: 4, abandoned: 4 }
const FINISHED: ReadonlySet<Status> = new Set(['done', 'cancelled', 'abandoned'])

/** The nodes in the order the tree shows them, skipping folded finished groups: what arrow keys walk. */
export function visibleOrder(root: AssignmentView, open: ReadonlySet<string>): AssignmentView[] {
  const out: AssignmentView[] = []
  const walk = (n: AssignmentView) => {
    out.push(n)
    const kids = [...n.children].sort((a, b) => ORDER[a.status] - ORDER[b.status])
    for (const k of kids) if (!FINISHED.has(k.status) || open.has(n.id)) walk(k)
  }
  walk(root)
  return out
}

export function Tree(props: { api: Api; project: string; root: AssignmentView; selectedId: string; onSelect: (id: string) => void; onNavigate?: (id: string) => void; open: ReadonlySet<string>; onToggle: (id: string) => void; onShortcut?: (key: string) => void; leadClient?: string }) {
  const { selectedId, onSelect, open, onToggle } = props
  const box = useRef<HTMLDivElement>(null)
  const [focusedId, setFocusedId] = useState<string>()
  const [reading, setReading] = useState<{ selection: string; ids: ReadonlySet<string> }>({ selection: selectedId, ids: new Set() })
  const retainFeed = (id: string) => setReading((have) => {
    if (have.selection === selectedId && have.ids.has(id)) return have
    return { selection: selectedId, ids: new Set([...(have.selection === selectedId ? have.ids : []), id]) }
  })
  const shown = new Set(open)
  const reveal = (n: AssignmentView): boolean => {
    const children = n.children.map((child) => ({ child, pinned: reveal(child) }))
    if (children.some(({ child, pinned }) => pinned && FINISHED.has(child.status))) shown.add(n.id)
    return children.some(({ pinned }) => pinned) || n.id === selectedId || n.id === focusedId || (reading.selection === selectedId && reading.ids.has(n.id))
  }
  reveal(props.root)
  const order = visibleOrder(props.root, shown)
  const tabId = order.some((n) => n.id === selectedId) ? selectedId : props.root.id
  // A feed stays after its run ends (folded to a summary), so remember which runs were seen running.
  const fed = useRef(new Map<string, string>())
  // Arrow keys move the selection only while the tree has focus; focus follows the selected row.
  const onKeyDown = (e: React.KeyboardEvent) => {
    // By physical key, so U/S/P/C also work on a Russian layout.
    const shortcut = { KeyU: 'u', KeyS: 's', KeyP: 'p', KeyC: 'c' }[e.code]
    if (shortcut && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      return props.onShortcut?.(shortcut)
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const i = order.findIndex((n) => n.id === selectedId)
    const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (!next) return
    e.preventDefault()
    ;(props.onNavigate ?? onSelect)(next.id)
  }
  useEffect(() => {
    const el = box.current
    if (!el?.contains(document.activeElement)) return
    el.querySelector<HTMLElement>(`[role="treeitem"][data-id="${CSS.escape(selectedId)}"]`)?.focus()
  }, [selectedId])
  const row = (n: AssignmentView) => (
    <button
      type="button"
      key={n.id}
      role="treeitem"
      data-id={n.id}
      aria-selected={selectedId === n.id}
      tabIndex={tabId === n.id ? 0 : -1}
      onFocus={() => setFocusedId(n.id)}
      className={`n press ${n.parentId === null ? 'root' : ''} ${n.status === 'waiting_owner' ? 'ask' : ''} ${FINISHED.has(n.status) ? (n.status === 'done' ? 'done' : 'cancel') : ''}`}
      onClick={() => onSelect(n.id)}
    >
      <Avatar provider={n.provider} leadClient={props.leadClient} />
      <span className="t">{n.title}</span>
      <StatusBadge status={n.status} />
      <span className="doing">
        <span>{n.request ? requestText(n.request) : T.doing(n.doing)}</span>
      </span>
    </button>
  )
  const feed = (n: AssignmentView) => {
    if (n.runId && n.runOpen) fed.current.set(n.id, n.runId)
    const runId = n.runId
    if (!runId || fed.current.get(n.id) !== runId) return null
    return <RunFeed key={runId} api={props.api} project={props.project} assignmentId={n.id} runId={runId} running={n.runOpen === true} onRead={() => retainFeed(n.id)} />
  }
  const branch = (n: AssignmentView): React.ReactNode => {
    const kids = [...n.children].sort((a, b) => ORDER[a.status] - ORDER[b.status])
    const active = kids.filter((k) => !FINISHED.has(k.status))
    const finished = kids.filter((k) => FINISHED.has(k.status))
    const isOpen = shown.has(n.id)
    return (
      <div key={n.id}>
        {row(n)}
        {feed(n)}
        {kids.length > 0 && (
          <div className="kids">
            {[
              ...active.map(branch),
              finished.length > 0 ? (
                <button key="finished" type="button" className="fold press" aria-expanded={isOpen} onClick={() => onToggle(n.id)}>
                  <CaretRight size={12} aria-hidden="true" />
                  {T.finishedGroup(finished.length)}
                </button>
              ) : null,
              ...(isOpen ? finished.map(branch) : []),
            ]}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="tree" role="tree" aria-label={T.tree} ref={box} onKeyDown={onKeyDown} onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setFocusedId(undefined)
    }}>
      {branch(props.root)}
    </div>
  )
}
