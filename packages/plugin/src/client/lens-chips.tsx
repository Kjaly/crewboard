import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoSnapshot, TaskSnapshot } from '../shared/types.js'
import { relativeTime, t, useLang } from './i18n.js'
import { lensTasks, type Lens } from './lens.js'

/**
 * A header status chip that lists what it counts. Click turns the lens on and opens the list under
 * the chip; a row flies to its task and opens the panel; Escape — or a second click on the chip —
 * closes the list and turns the lens off again. `n`/`N` keep stepping while the lens is on.
 */

const GLYPH: Record<Lens, string> = { attention: '⚠', running: '●', ready: '○', review: '◐' }
const TONE: Record<Lens, string> = { attention: 'warn', running: 'running', ready: 'ready', review: 'review' }
const TITLE: Record<Lens, string> = {
  attention: 'panel.app.attentionHint',
  running: 'panel.app.runningHint',
  ready: 'panel.app.readyHint',
  review: 'panel.app.reviewHint',
}
const COUNT: Record<Lens, string> = {
  attention: 'panel.app.attentionCount',
  running: 'panel.app.runningCount',
  ready: 'panel.app.readyCount',
  review: 'panel.app.reviewCount',
}

/** The list's reading order: alerts before warnings, then the oldest wait first. */
function lensRows(repo: RepoSnapshot, kind: Lens): Array<{ task: TaskSnapshot; alert: boolean }> {
  const alerts = new Set(repo.attention.filter((a) => a.severity === 'alert').map((a) => a.taskId))
  const stamp = (task: TaskSnapshot) => (task.activeSince ? Date.parse(task.activeSince) : Number.POSITIVE_INFINITY)
  return lensTasks(repo, kind)
    .map((task) => ({ task, alert: alerts.has(task.id) }))
    .sort((a, b) => Number(b.alert) - Number(a.alert) || stamp(a.task) - stamp(b.task))
}

const rowMeta = (task: TaskSnapshot): string => {
  const who = task.worker ?? '—'
  const when = task.status === 'running' && task.activeSince ? relativeTime(Date.parse(task.activeSince)) : t(`panel.status.${task.status === 'in_review' ? 'inReview' : task.status}`)
  return `${who} · ${when}`
}

export function LensChip({ kind, count, repo, active, onLens, onPick }: {
  kind: Lens
  count: number
  repo: RepoSnapshot
  active: boolean
  onLens(lens: Lens | null): void
  onPick(id: string): void
}) {
  useLang()
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState(0)
  const box = useRef<HTMLSpanElement>(null)
  const rows = useMemo(() => lensRows(repo, kind), [repo, kind])

  // A lens released elsewhere (Escape, an empty match set) folds its list with it.
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])

  // The list is anchored to the chip: a click anywhere else folds it but keeps the lens.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.('.orc-lenschip')) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  if (count === 0) return null
  const pick = (id: string) => {
    setOpen(false)
    onPick(id)
  }
  const clickChip = () => {
    if (!active) {
      onLens(kind)
      setOpen(true)
      setRow(0)
    } else if (!open) {
      setOpen(true)
      setRow(0)
    } else {
      setOpen(false)
      onLens(null)
    }
  }
  const onListKeys = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      setRow((i) => (i + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
      event.preventDefault()
      event.stopPropagation()
    } else if (event.key === 'Enter') {
      const target = rows[row]
      if (target) pick(target.task.id)
      event.preventDefault()
    } else if (event.key === 'Escape') {
      setOpen(false)
      onLens(null)
      box.current?.querySelector<HTMLButtonElement>('.orc-chip')?.focus()
      event.preventDefault()
      event.stopPropagation()
    }
  }
  return (
    <span ref={box} className={`orc-lenschip${active ? ' orc-lenschip--on' : ''}`}>
      <button
        type="button"
        className={`orc-chip orc-chip--${TONE[kind]}`}
        aria-pressed={active}
        aria-expanded={open}
        title={t(TITLE[kind])}
        onClick={clickChip}
      >
        <span aria-hidden="true">{GLYPH[kind]}</span> <span className="orc-chip__label">{t(COUNT[kind], { count })}</span>
        <span className="orc-chip__compact" aria-hidden="true">{count}</span>
      </button>
      {open ? (
        <div className="orc-lenspop" role="listbox" aria-label={t(COUNT[kind], { count })} onKeyDown={onListKeys} tabIndex={-1}>
          <ul className="orc-lenspop__list" role="none">
            {rows.map(({ task, alert }, i) => (
              <li key={task.id} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === row}
                  className={`orc-lensrow${i === row ? ' orc-lensrow--active' : ''}${alert ? ' orc-lensrow--alert' : ''}`}
                  onMouseEnter={() => setRow(i)}
                  onClick={() => pick(task.id)}
                >
                  <span className="orc-lensrow__line">
                    <b>{task.id}</b> {task.title}
                  </span>
                  <span className="orc-lensrow__meta">{rowMeta(task)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="orc-lenspop__hint">{t('panel.app.lensListHint')}</p>
        </div>
      ) : null}
    </span>
  )
}
