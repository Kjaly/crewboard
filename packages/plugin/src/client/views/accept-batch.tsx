import { type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PlanCost, RepoSnapshot, TaskSnapshot } from '../../shared/types.js'
import type { Verdict } from '@crewboard/core'
import { waitsForHuman } from '../../../../core/src/plan/graph.js'
import { useAction } from '../actions.js'
import { api } from '../api.js'
import { t, useLang } from '../i18n.js'
import { durationLabel, usePlanCost } from '../insight.js'

const WIDTH = 340
const MIN_HEIGHT = 180

/**
 * What one confirmation may cover — the same rule the host applies before it asks: finished work
 * waiting for a human, plus the decisions only a human can close. Anything else is refused server-side.
 */
export function acceptableTasks(repo: RepoSnapshot): TaskSnapshot[] {
  return repo.tasks.filter((t) => waitsForHuman(t))
}

/** How long the plan has been waiting on this person: the end of the last run, as the time screen counts it. */
export function waitLabels(cost: PlanCost | null, now: Date): Map<string, string> {
  const lastFinish = new Map<string, number>()
  for (const run of cost?.runs ?? []) {
    const at = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN
    if (!Number.isFinite(at)) continue
    if (at > (lastFinish.get(run.taskId) ?? 0)) lastFinish.set(run.taskId, at)
  }
  const out = new Map<string, string>()
  for (const [taskId, at] of lastFinish) {
    const waited = now.getTime() - at
    if (waited > 0) out.set(taskId, t('queue.batch.waited', { duration: durationLabel(waited) }))
  }
  return out
}

/** The trigger lives in a column head; the sheet is a popover, so the board never loses its place. */
export function AcceptBatch({ repo, onSelect }: { repo: RepoSnapshot; onSelect(id: string): void }) {
  useLang()
  const tasks = useMemo(() => acceptableTasks(repo), [repo])
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  if (tasks.length === 0 || repo.example) return null

  const close = () => {
    setOpen(false)
    anchor.current?.focus()
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="orc-btn orc-btn--ghost orc-batch"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t('queue.batch.acceptAll', { count: tasks.length })}
      </button>
      {open ? <Sheet repo={repo} tasks={tasks} anchor={anchor} onSelect={onSelect} onClose={close} /> : null}
    </>
  )
}

type Placement = { left: number; top: number; maxHeight: number }

/** Fixed, not absolute: both hosts of the button scroll, and an absolute popover would be clipped by them. */
function place(el: HTMLElement): Placement {
  const rect = el.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8))
  const below = window.innerHeight - rect.bottom - 14
  const above = rect.top - 14
  if (below >= MIN_HEIGHT || below >= above) return { left, top: rect.bottom + 6, maxHeight: Math.max(MIN_HEIGHT, below) }
  const maxHeight = Math.max(MIN_HEIGHT, above)
  return { left, top: Math.max(8, rect.top - 6 - maxHeight), maxHeight }
}

function Sheet({
  repo,
  tasks,
  anchor,
  onSelect,
  onClose,
}: {
  repo: RepoSnapshot
  tasks: TaskSnapshot[]
  anchor: RefObject<HTMLButtonElement | null>
  onSelect(id: string): void
  onClose(): void
}) {
  // Exclusions rather than a selection: a task that arrives while the sheet is open is checked, as it would be on open.
  const lang = useLang()
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set())
  const [verdicts, setVerdicts] = useState<Record<string, Verdict | null>>({})
  const [placement, setPlacement] = useState<Placement | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const prefix = useId()
  const action = useAction()
  const { cost } = usePlanCost(repo.root, repo.rev)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Locale changes intentionally refresh the translated result.
  const waits = useMemo(() => waitLabels(cost, new Date()), [cost, lang])
  const chosen = tasks.filter((t) => !excluded.has(t.id)).map((t) => t.id)

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let live = true
    setVerdicts({})
    void Promise.all(tasks.map(async (task) => {
      const result = await api.task(repo.root, task.id).catch(() => null)
      return [task.id, result?.ok ? result.value.verdict : null] as const
    })).then((entries) => { if (live) setVerdicts(Object.fromEntries(entries)) })
    return () => { live = false }
  }, [repo.root, repo.rev, tasks])

  useLayoutEffect(() => {
    if (anchor.current) setPlacement(place(anchor.current))
  }, [anchor])

  useEffect(() => {
    box.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      // Captured, so Escape closes the sheet instead of dropping the task selection behind it.
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!box.current?.contains(target) && !anchor.current?.contains(target)) onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [anchor, onClose])

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const send = async () => {
    if ((await action.call(() => api.acceptBatch(repo.root, chosen))) === true) onClose()
  }

  return (
    <div
      ref={box}
      className="orc-sheet"
      role="dialog"
      aria-label={t('queue.batch.dialogLabel', { count: tasks.length })}
      tabIndex={-1}
      style={placement ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight } : undefined}
    >
      <div className="orc-sheet__head">
        <span>{t('queue.batch.title')}</span>
        <span className="orc-top__spacer" />
        <button
          type="button"
          className="orc-more"
          onClick={() => setExcluded(chosen.length === 0 ? new Set() : new Set(tasks.map((t) => t.id)))}
        >
          {chosen.length === 0 ? t('queue.batch.selectAll') : t('queue.batch.clearAll')}
        </button>
      </div>

      <ul className="orc-sheet__list">
        {tasks.map((task) => {
          const id = `${prefix}-${task.id}`
          const meta = [task.id, task.worker, waits.get(task.id)].filter(Boolean).join(' · ')
          const verdict = verdicts[task.id]
          const risk = verdict?.kind === 'negative'
            ? `${t('verdict.negative')} · ${verdict.why ? t(`verdict.why.${verdict.why}`) : t('verdict.negative')}`
            : verdict?.kind === 'disputed'
              ? `${t('verdict.disputed')} · ${verdict.mismatch ? t(`verdict.mismatch.${verdict.mismatch}`) : t('verdict.disputed')}`
              : null
          return (
            <li key={task.id} className="orc-sheet__item">
              <input type="checkbox" className="orc-check" id={id} checked={!excluded.has(task.id)} onChange={() => toggle(task.id)} />
              <label className="orc-sheet__label" htmlFor={id}>
                <span className="orc-card__title">
                  {task.kind === 'decision' ? (
                    <span className="orc-sheet__kind" aria-hidden="true">◆</span>
                  ) : null}
                  {task.title}
                </span>
                <span className="orc-meta">{meta}</span>
                {!excluded.has(task.id) && risk ? <span className="orc-meta">{risk}</span> : null}
              </label>
              <button type="button" className="orc-sheet__open" onClick={() => onSelect(task.id)}>
                {t('queue.batch.open')}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="orc-sheet__foot">
        <div className="orc-actions">
          <button type="button" className="orc-btn" disabled={action.pending || chosen.length === 0} onClick={send}>
            {t('queue.batch.acceptSelected', { count: chosen.length })}
          </button>
          <button type="button" className="orc-btn orc-btn--ghost" onClick={onClose}>
            {t('queue.batch.cancel')}
          </button>
        </div>
        <p className="orc-hint">{t('queue.batch.confirmHint')}</p>
        {action.error ? <p className="orc-error">{action.error}</p> : null}
      </div>
    </div>
  )
}
