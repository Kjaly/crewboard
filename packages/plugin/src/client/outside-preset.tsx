import { useEffect, useRef, useState } from 'react'
import type { TaskSnapshot } from '../shared/types.js'
import { t, useLang } from './i18n.js'
import { outsidePresetTasks, workerChoiceOf } from './workers.js'

/**
 * «N outside preset» next to the preset chip: tasks whose assigned worker the current preset does not
 * route to. A person's pick runs anyway (hand-picked); an agent's pick gives way to the preset at launch.
 */
export function OutsidePresetChip({ tasks, onPick }: { tasks: readonly TaskSnapshot[]; onPick(id: string): void }) {
  useLang()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const rows = outsidePresetTasks(tasks)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])
  if (rows.length === 0) return null
  const label = t('panel.app.outsidePreset', { count: rows.length })
  return (
    <span ref={box} className="orc-lenschip orc-outside">
      <button type="button" className="orc-chip orc-chip--warn" aria-expanded={open} title={t('panel.app.outsidePresetHint')} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">⚑</span> <span className="orc-chip__label">{label}</span>
        <span className="orc-chip__compact" aria-hidden="true">{rows.length}</span>
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape on the list closes it; the rows are buttons.
        <div className="orc-lenspop" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); box.current?.querySelector<HTMLButtonElement>('.orc-chip')?.focus() } }}>
          <ul className="orc-lenspop__list" aria-label={label}>
            {rows.map((task) => (
              <li key={task.id}>
                <button type="button" className="orc-lensrow" onClick={() => { setOpen(false); onPick(task.id) }}>
                  <span className="orc-lensrow__line"><b>{task.id}</b> {task.title}</span>
                  <span className="orc-lensrow__meta">{`${task.worker ?? '—'} · ${t(`panel.task.chosenBy.${workerChoiceOf(task)}`)}${workerChoiceOf(task) === 'agent' ? ` · ${t('panel.app.outsideAgentNote')}` : ''}`}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  )
}
