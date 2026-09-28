import { useEffect, useRef, useState } from 'react'
import type { TaskSnapshot } from '../shared/types.js'
import { t, useLang } from './i18n.js'
import { outsidePresetTasks, workerChoiceOf } from './workers.js'

/**
 * The preset chips next to the preset picker. «Outside preset · N» (red) lists agent assignments the current
 * preset no longer routes to — at launch the preset decides for them. A person's own pick is not an alarm
 * (nb1): «Hand-picked · N» is a neutral chip, and those tasks run as chosen.
 */
export function OutsidePresetChip({ tasks, onPick }: { tasks: readonly TaskSnapshot[]; onPick(id: string): void }) {
  useLang()
  const rows = outsidePresetTasks(tasks)
  const agents = rows.filter((task) => workerChoiceOf(task) !== 'person')
  const people = rows.filter((task) => workerChoiceOf(task) === 'person')
  return <>
    {agents.length ? <PresetChipList rows={agents} tone="warn" label={t('panel.app.outsidePreset', { count: agents.length })} hint={t('panel.app.outsidePresetHint')} onPick={onPick} /> : null}
    {people.length ? <PresetChipList rows={people} tone="neutral" label={t('panel.app.handPicked', { count: people.length })} hint={t('panel.app.handPickedHint')} onPick={onPick} /> : null}
  </>
}

function PresetChipList({ rows, tone, label, hint, onPick }: { rows: readonly TaskSnapshot[]; tone: 'warn' | 'neutral'; label: string; hint: string; onPick(id: string): void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])
  return (
    <span ref={box} className="orc-lenschip orc-outside">
      {/* The label carries the count: no second compact number beside it (UX1-21). */}
      <button type="button" className={`orc-chip${tone === 'warn' ? ' orc-chip--warn' : ''}`} aria-expanded={open} title={hint} onClick={() => setOpen(!open)}>
        {tone === 'warn' ? <span aria-hidden="true">⚑</span> : null} <span className="orc-chip__label">{label}</span>
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
