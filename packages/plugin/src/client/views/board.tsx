import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { Attention, TaskSnapshot, ViewStatus, WorkerInfo } from '../../shared/types.js'
import { lensIds, lensTasks } from '../lens.js'
import { t, useLang } from '../i18n.js'
import { decideFolds, foldGraph, readManualFolds, taskCount, writeManualFold } from '../fold.js'
import { taskTone } from '../styles.js'
import { identityLabel, runFact, workerIdentity } from '../provider.js'
import { taskEssence } from '../summary.js'
import { AcceptBatch, acceptableTasks } from './accept-batch.js'
import { laneOf, laneTitle } from './graph/layout.js'
import type { ViewProps } from './types.js'
import { VendorMark } from '../vendor-mark.js'

/** The accepted archive shows a few cards before expanding the rest. */
const ACCEPTED_SHOWN = 6

const COLUMNS: Array<{ key: ViewStatus; titleKey: string; always?: boolean }> = [
  { key: 'ready', titleKey: 'board.ready', always: true },
  { key: 'running', titleKey: 'board.running', always: true },
  { key: 'in_review', titleKey: 'board.review' },
  { key: 'blocked', titleKey: 'board.blocked' },
  { key: 'backlog', titleKey: 'board.backlog' },
]

export function attentionByTask(attention: Attention[]): Map<string, Attention[]> {
  const map = new Map<string, Attention[]>()
  for (const a of attention) map.set(a.taskId, [...(map.get(a.taskId) ?? []), a])
  return map
}

export function TaskCard({
  task,
  attention,
  selected,
  density,
  onSelect,
  now,
  negativeDeps = [],
  workers,
}: {
  task: TaskSnapshot
  attention: Attention[]
  selected: boolean
  density: 'overview' | 'detail'
  onSelect(id: string): void
  now: Date
  negativeDeps?: string[]
  workers?: readonly WorkerInfo[]
}) {
  const tone = taskTone(task)
  const identity = workerIdentity(task.worker, workers)
  const alert = attention.find((a) => a.severity === 'alert') ?? attention[0]
  const meta = alert ? alert.message : task.kind === 'decision' || task.status === 'blocked'
    ? taskEssence(task, now) : [task.returned ? t('welcome.returned') : tone.label, runFact(task, now)].join(' · ')
  const dim = task.status === 'blocked' || task.status === 'backlog'
  return (
    <button
      type="button"
      data-task-id={task.id}
      className={`orc-card${dim ? ' orc-card--dim' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(task.id)}
    >
      <span className="orc-card__top">
        <span className="orc-glyph" style={{ color: tone.color }} aria-hidden="true">
          {task.status === 'running' ? <span className="orc-pulse" /> : tone.glyph}
        </span>
        {density === 'detail' ? <span className="orc-card__id">{task.id}</span> : null}
        <span className="orc-card__title">{task.title}</span>
        {alert ? (
          <span className="orc-glyph" style={{ color: 'var(--orc-error)' }} role="img" aria-label={t('board.attentionAria')}>
            !
          </span>
        ) : null}
      </span>
      <span className="orc-card__identity"><VendorMark identity={identity} />{identityLabel(identity)}</span>
      <span className={`orc-meta${alert ? (alert.severity === 'alert' ? ' orc-meta--alert' : ' orc-meta--warn') : ''}`}>
        {alert ? <span className="orc-sr-only">{tone.label}. </span> : null}
        {meta}
      </span>
      {negativeDeps.length > 0 ? <span className="orc-dep-warning">{t('board.negativeDep')}</span> : null}
    </button>
  )
}

function Column({
  title,
  tasks,
  cap,
  action,
  summaries,
  total,
  ...rest
}: {
  title: string
  tasks: TaskSnapshot[]
  /** Archive columns show a few cards before expanding the rest in place. */
  cap?: number
  action?: ReactNode
  summaries?: ReactNode
  total?: number
  attention: Map<string, Attention[]>
  selectedId: string | null
  density: 'overview' | 'detail'
  onSelect(id: string): void
  now: Date
  muted?: boolean
  lensOn: boolean
  matchIds: Set<string>
  rowRef(id: string): (el: HTMLLIElement | null) => void
  negativeIds: Set<string>
  workers?: readonly WorkerInfo[]
}) {
  const [all, setAll] = useState(false)
  const shown = cap !== undefined && !all ? tasks.slice(-cap) : tasks
  return (
    <section className={`orc-col${rest.muted ? ' orc-col--muted' : ''}`} aria-label={`${title}: ${total ?? tasks.length}`}>
      <div className="orc-col__bar">
        <h2 className="orc-col__head">
          <span>{title}</span>
          <span className="orc-col__count">{total ?? tasks.length}</span>
        </h2>
        {action}
      </div>
      <ul className="orc-cards">
        {summaries}
        {shown.map((task) => (
          <li key={task.id} ref={rest.rowRef(task.id)} className={rest.lensOn && !rest.matchIds.has(task.id) ? 'orc-lens-dim' : undefined}>
            <TaskCard
              task={task}
              attention={rest.attention.get(task.id) ?? []}
              selected={rest.selectedId === task.id}
              density={rest.density}
              onSelect={rest.onSelect}
              now={rest.now}
              negativeDeps={task.deps.filter((id) => rest.negativeIds.has(id))}
              workers={rest.workers}
            />
          </li>
        ))}
        {shown.length === 0 && (!Array.isArray(summaries) || summaries.length === 0) ? <li className="orc-meta">{t('board.empty')}</li> : null}
      </ul>
      {cap !== undefined && tasks.length > cap ? (
        <button type="button" className="orc-more" onClick={() => setAll(!all)}>
          {all ? t('board.collapse') : t('board.showAll', { count: tasks.length })}
        </button>
      ) : null}
    </section>
  )
}

/** Columns read left to right in the order a person acts on them: attention, then work, then archive. */
export function BoardView({ repo, workers, selectedId, onSelect, density, lens = null, walk }: ViewProps) {
  const lang = useLang()
  const now = new Date()
  const [manual, setManual] = useState<Record<string, boolean>>(() => readManualFolds(repo))
  useEffect(() => setManual(readManualFolds(repo)), [repo])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  const decision = useMemo(() => decideFolds(repo, manual, now), [repo, manual])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Locale changes intentionally refresh the translated result.
  const graph = useMemo(() => foldGraph(repo, decision), [repo, decision, lang])
  const toggleFold = (lane: string) => {
    const folded = !decision.folded.has(lane)
    writeManualFold(repo, lane, folded)
    setManual((old) => ({ ...old, [lane]: folded }))
  }
  const attention = useMemo(() => attentionByTask(repo.attention), [repo.attention])
  const visible = new Set(graph.nodes.filter((n) => n.task).map((n) => n.id))
  const needAttention = repo.tasks.filter((t) => visible.has(t.id) && attention.has(t.id))
  const rest = repo.tasks.filter((t) => visible.has(t.id) && !attention.has(t.id))
  const accepted = rest.filter((t) => t.status === 'accepted' || t.status === 'superseded')
  const summariesFor = (key: ViewStatus | 'accepted') => graph.nodes.filter((n) => {
    if (n.task) return false
    const first = repo.tasks.find((t) => laneOf(t) === n.lane)
    return first && (first.status === 'superseded' ? 'accepted' : first.status) === key
  }).map((n) => <li key={n.id}><button type="button" className="orc-card orc-card--lane" aria-label={t('board.expandLane', { lane: laneTitle(n.lane) })} onClick={() => toggleFold(n.lane)}><strong>{laneTitle(n.lane) || t('board.unnamedLane')} · {taskCount(n.count ?? 0)}</strong><span className="orc-meta">{n.summary}</span></button></li>)

  // A lens on the board: nothing leaves its column, the non-matching cards just step back to 45 %.
  const matchIds = useMemo(() => lensIds(repo, lens), [repo, lens])
  const lensOn = lens !== null && matchIds.size > 0
  const rows = useRef(new Map<string, HTMLLIElement>())
  const rowRef = (id: string) => (el: HTMLLIElement | null) => {
    if (el) rows.current.set(id, el)
    else rows.current.delete(id)
  }
  // Switching a lens on brings the first match into view; walking follows `n`/`N`.
  const firstMatch = useMemo(() => lensTasks(repo, lens)[0]?.id, [repo, lens])
  useEffect(() => {
    if (lensOn && firstMatch) rows.current.get(firstMatch)?.scrollIntoView?.({ block: 'nearest' })
  }, [lensOn, firstMatch])
  useEffect(() => {
    if (walk) rows.current.get(walk.id)?.scrollIntoView?.({ block: 'nearest' })
  }, [walk])

  const negativeIds = new Set(repo.tasks.filter((task) => task.closed === 'negative').map((task) => task.id))
  const shared = { attention, workers, selectedId, density, onSelect, now, lensOn, matchIds, rowRef, negativeIds }
  // Everything one confirmation could close, wherever the card itself ended up — attention pulls
  // finished work out of the review column, and the batch must still be reachable from that head.
  const batch = acceptableTasks(repo).length > 0 ? <AcceptBatch repo={repo} onSelect={onSelect} /> : null

  if (repo.tasks.length === 0) return <p className="orc-empty">{t('board.noTasks')}</p>

  return (
    <div className="orc-board">
      {needAttention.length > 0 ? <Column title={t('board.attention')} tasks={needAttention} {...shared} /> : null}
      {COLUMNS.map(({ key, titleKey, always }) => {
        const title = t(titleKey)
        const tasks = rest.filter((t) => t.status === key)
        const action = key === 'in_review' ? batch : null
        const summaries = summariesFor(key)
        if (tasks.length === 0 && summaries.length === 0 && !always && !action) return null
        return <Column key={key} title={title} tasks={tasks} total={repo.tasks.filter((t) => t.status === key && !attention.has(t.id)).length} summaries={summaries} action={action} muted={key === 'backlog'} {...shared} />
      })}
      <Column title={t('board.accepted')} tasks={accepted} total={repo.tasks.filter((t) => (t.status === 'accepted' || t.status === 'superseded') && !attention.has(t.id)).length} cap={ACCEPTED_SHOWN} muted summaries={summariesFor('accepted')} {...shared} />
    </div>
  )
}
