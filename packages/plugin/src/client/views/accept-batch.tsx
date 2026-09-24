import { type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PlanCost, RepoSnapshot, TaskSnapshot } from '../../shared/types.js'
import type { Verdict } from '@crewboard/core'
import { ownWorkUnchecked, waitsForHuman } from '../../../../core/src/plan/graph.js'
import { cleanToAccept } from '../../../../core/src/orchestration/verdict.js'
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
  // w1b (B03): only clean work starts checked; negative, disputed, unknown and unchecked work waits in its own
  // group, unchecked. `flipped` holds the person's own ticks against that default, so a task that arrives while
  // the sheet is open gets the default too.
  const lang = useLang()
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set())
  const [verdicts, setVerdicts] = useState<Record<string, Verdict | null | undefined>>({})
  const [placement, setPlacement] = useState<Placement | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const prefix = useId()
  const action = useAction()
  const { cost } = usePlanCost(repo.root, repo.rev)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Locale changes intentionally refresh the translated result.
  const waits = useMemo(() => waitLabels(cost, new Date()), [cost, lang])
  const loaded = tasks.every((task) => task.id in verdicts)
  const clean = (task: TaskSnapshot) => cleanToAccept(task, verdicts[task.id])
  const picked = (task: TaskSnapshot) => loaded && clean(task) !== flipped.has(task.id)
  const cleanTasks = tasks.filter(clean)
  const riskyTasks = tasks.filter((task) => !clean(task))
  const chosen = tasks.filter(picked)
  const chosenClean = chosen.filter(clean).length

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let live = true
    setVerdicts({})
    void Promise.all(tasks.map(async (task) => {
      const result = await api.task(repo.root, task.id).catch(() => null)
      // A decision has no verdict (B05); for other work a failed read is «unknown», which is at risk.
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
    setFlipped((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  // Select all flips every task off its default that is not picked yet; clearing flips the picked ones back.
  const setAll = (on: boolean) => setFlipped(new Set(tasks.filter((task) => clean(task) !== on).map((task) => task.id)))

  const send = async () => {
    if ((await action.call(() => api.acceptBatch(repo.root, chosen.map((task) => task.id)))) === true) onClose()
  }

  const riskOf = (task: TaskSnapshot): string | null => {
    const verdict = verdicts[task.id]
    if (verdict?.kind === 'negative') return `${t('verdict.negative')} · ${verdict.why ? t(`verdict.why.${verdict.why}`) : t('verdict.negative')}`
    if (verdict?.kind === 'disputed') return `${t('verdict.disputed')} · ${verdict.mismatch ? t(`verdict.mismatch.${verdict.mismatch}`) : t('verdict.disputed')}`
    if (!verdict && task.kind !== 'decision') return t('queue.batch.verdictUnknown')
    return null
  }

  const row = (task: TaskSnapshot) => {
    const id = `${prefix}-${task.id}`
    const meta = [task.id, task.kind === 'root' ? t('status.orchestrator') : task.worker, waits.get(task.id)].filter(Boolean).join(' · ')
    const risk = riskOf(task)
    return (
      <li key={task.id} className="orc-sheet__item">
        <input type="checkbox" className="orc-check" id={id} checked={picked(task)} disabled={!loaded} onChange={() => toggle(task.id)} />
        <label className="orc-sheet__label" htmlFor={id}>
          <span className="orc-card__title">
            {task.kind === 'decision' || task.kind === 'root' ? (
              <span className="orc-sheet__kind" aria-hidden="true">{task.kind === 'root' ? '▣' : '◆'}</span>
            ) : null}
            {task.title}
          </span>
          <span className="orc-meta">{meta}</span>
          {risk ? <span className="orc-meta orc-sheet__risk">{risk}</span> : null}
          {ownWorkUnchecked(task.kind, task.check) ? <span className="orc-meta orc-sheet__unchecked">{t('queue.batch.unchecked')}</span> : null}
        </label>
        <button type="button" className="orc-sheet__open" onClick={() => onSelect(task.id)}>
          {t('queue.batch.open')}
        </button>
      </li>
    )
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
        <button type="button" className="orc-more" disabled={!loaded} onClick={() => setAll(chosen.length === 0)}>
          {chosen.length === 0 ? t('queue.batch.selectAll') : t('queue.batch.clearAll')}
        </button>
      </div>

      {!loaded ? <p className="orc-meta orc-sheet__group">{t('queue.batch.loading')}</p> : null}
      <div className="orc-sheet__list">
        {!loaded ? <ul className="orc-sheet__rows">{tasks.map(row)}</ul> : <>
          {cleanTasks.length ? <section aria-label={t('queue.batch.clean', { count: cleanTasks.length })}>
            <h3 className="orc-sheet__group">{t('queue.batch.clean', { count: cleanTasks.length })}</h3>
            <ul className="orc-sheet__rows">{cleanTasks.map(row)}</ul>
          </section> : null}
          {riskyTasks.length ? <section aria-label={t('queue.batch.risky', { count: riskyTasks.length })}>
            <h3 className="orc-sheet__group">{t('queue.batch.risky', { count: riskyTasks.length })}</h3>
            <p className="orc-meta orc-sheet__group-hint">{t('queue.batch.riskyHint')}</p>
            <ul className="orc-sheet__rows">{riskyTasks.map(row)}</ul>
          </section> : null}
        </>}
      </div>

      <div className="orc-sheet__foot">
        {loaded && chosen.length ? <p className="orc-meta">{t('queue.batch.summary', { clean: chosenClean, risky: chosen.length - chosenClean })}</p> : null}
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
