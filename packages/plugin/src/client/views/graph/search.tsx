import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskSnapshot } from '../../../shared/types.js'
import { rankText } from '../../sidebar-model.js'
import { taskTone } from '../../styles.js'
import { t, useLang } from '../../i18n.js'

/**
 * ⌘K over the canvas: in a plan of a hundred tasks, finding one by eye is panning, and panning is
 * not reading. The field answers by id and by title, Enter selects and flies the camera there.
 */

const LIMIT = 8

/** Exported for the test: matches on id or title, best prefix hits first, plan order otherwise. */
export function searchTasks(tasks: TaskSnapshot[], query: string): TaskSnapshot[] {
  const q = query.trim().toLowerCase()
  if (!q) return tasks.slice(0, LIMIT)
  const score = (task: TaskSnapshot): number => rankText(task.id, task.title, q)
  return tasks
    .map((task, index) => ({ task, index, rank: score(task) }))
    .filter((row) => Number.isFinite(row.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, LIMIT)
    .map((row) => row.task)
}

export type GraphSearchProps = {
  tasks: TaskSnapshot[]
  onPick(id: string): void
  onClose(): void
}

export function GraphSearch({ tasks, onPick, onClose }: GraphSearchProps) {
  useLang()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const field = useRef<HTMLInputElement | null>(null)
  const matches = useMemo(() => searchTasks(tasks, query), [tasks, query])
  const current = Math.min(active, Math.max(0, matches.length - 1))

  useEffect(() => field.current?.focus(), [])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The canvas has its own arrow and letter keys: while the field is open they belong to the field.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (matches.length === 0) return
      setActive((index) => (Math.min(index, matches.length - 1) + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const task = matches[current]
      if (task) onPick(task.id)
    }
  }

  return (
    // The wrapper is not a control: it only keeps the keys of its own field away from the canvas.
    /* biome-ignore lint/a11y/noStaticElementInteractions: This wrapper keeps field keys away from the canvas. */
    <div className="orc-gsearch" onKeyDown={onKeyDown}>
      <input
        ref={field}
        type="text"
        className="orc-gsearch__field"
        aria-label={t('graph.search.label')}
        placeholder={t('graph.search.placeholder')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onBlur={onClose}
      />
      {matches.length === 0 ? (
        <p className="orc-gsearch__empty">{t('graph.search.empty')}</p>
      ) : (
        <ul className="orc-gsearch__list">
          {matches.map((task, index) => {
            const tone = taskTone(task)
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className="orc-gsearch__item"
                  aria-current={index === current}
                  // Pointer down, not click: the field's blur would close the list first.
                  onPointerDown={(event) => {
                    event.preventDefault()
                    onPick(task.id)
                  }}
                >
                  <span className="orc-glyph" style={{ color: tone.color }} aria-hidden="true">
                    {tone.glyph}
                  </span>
                  <span className="orc-gsearch__title">{task.title}</span>
                  <span className="orc-card__id">{task.id}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="orc-gsearch__keys">{t('graph.search.keys')}</p>
    </div>
  )
}
