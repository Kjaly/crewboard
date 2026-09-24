import { type ReactNode, useEffect, useState } from 'react'
import type { TaskSnapshot } from '../../shared/types.js'
import { api } from '../api.js'
import { isChecking, waitsForHuman } from '../../../../core/src/plan/graph.js'
import { t, useLang } from '../i18n.js'
import { sinceLabel } from '../summary.js'
import { TaskCard, attentionByTask } from './board.js'
import { AcceptBatch } from './accept-batch.js'
import type { ViewProps } from './types.js'

type DoneFilter = 'all' | 'accepted' | 'closed' | 'superseded' | 'followup'

/** A task occurs in exactly one column, chosen by the person who can move it next. */
export function workColumns(repo: ViewProps['repo']) {
  const attention = attentionByTask(repo.attention)
  const needsYou = repo.tasks.filter((task) => waitsForHuman(task) || (task.status === 'ready' && task.needsHuman) || attention.has(task.id))
  const assigned = new Set(needsYou.map((task) => task.id))
  const remaining = repo.tasks.filter((task) => !assigned.has(task.id))
  return {
    needsYou,
    // Finished work the orchestrator is still checking is its move, not the person's (vr1).
    running: remaining.filter((task) => task.status === 'running' || (task.status === 'in_review' && isChecking(task.check))),
    ready: remaining.filter((task) => task.status === 'ready'),
    waiting: remaining.filter((task) => task.status === 'blocked'),
    backlog: remaining.filter((task) => task.status === 'backlog'),
    done: remaining.filter((task) => task.status === 'accepted' || task.status === 'closed' || task.status === 'superseded'),
  }
}

function RunningCard({ task, repo, ...props }: { task: TaskSnapshot; repo: ViewProps['repo'] } & Parameters<typeof TaskCard>[0]) {
  const [last, setLast] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let live = true
    void api.task(repo.root, task.id).then((result) => {
      if (live && result.ok) setLast(result.value.events.at(-1)?.text ?? null)
    }).catch(() => {})
    return () => { live = false }
  }, [repo.root, task.id, task.lastRunId, repo.rev])
  return <div><TaskCard {...props} task={task} /><p className="orc-work__last">{[sinceLabel(task.activeSince, props.now), last].filter(Boolean).join(' · ')}</p></div>
}

export function WorkView({ repo, workers, selectedId, onSelect, lens, density, onOpenQueue }: ViewProps & { onOpenQueue?(): void }) {
  useLang()
  const [filter, setFilter] = useState<DoneFilter>('all')
  const [doneOpen, setDoneOpen] = useState(false)
  const columns = workColumns(repo)
  const attention = attentionByTask(repo.attention)
  const dependedOn = new Set(repo.tasks.flatMap((task) => task.deps))
  const followup = new Set(columns.done.filter((task) => (task.status === 'accepted' || task.status === 'closed') && task.kind !== 'decision' && !dependedOn.has(task.id)).map((task) => task.id))
  const done = columns.done.filter((task) => filter === 'all' || (filter === 'followup' ? followup.has(task.id) : task.status === filter))
  const now = new Date()
  const card = (task: TaskSnapshot) => <li key={task.id} className={lens && !(lens === 'attention' ? attention.has(task.id) : lens === 'review' ? task.status === 'in_review' : task.status === lens) ? 'orc-lens-dim' : undefined}>
    {task.status === 'running' ? <RunningCard task={task} repo={repo} attention={attention.get(task.id) ?? []} selected={selectedId === task.id} density={density} onSelect={onSelect} now={now} workers={workers} />
      : <TaskCard task={task} attention={attention.get(task.id) ?? []} selected={selectedId === task.id} density={density} onSelect={onSelect} now={now} workers={workers} />}
  </li>
  const section = (key: keyof Omit<typeof columns, 'done'>, label: string, action?: ReactNode) => <section className="orc-col" aria-label={`${label}: ${columns[key].length}`}>
    <div className="orc-col__bar"><h2 className="orc-col__head">{label} <span className="orc-col__count">{columns[key].length}</span></h2>{action}</div>
    <ul className="orc-cards">{columns[key].map(card)}{columns[key].length === 0 ? <li className="orc-meta">{t('board.empty')}</li> : null}</ul>
  </section>
  if (repo.tasks.length === 0) return <p className="orc-empty">{t('board.noTasks')}</p>
  return <div className="orc-work">
    <p className="orc-work__totals">{t('work.totals', { tasks: repo.tasks.length, accepted: repo.tasks.filter((task) => task.status === 'accepted').length })} · {t('work.critical', { path: repo.criticalPath.join(' → ') || '—' })}</p>
    <div className="orc-board">
      {section('needsYou', t('work.needsYou'), <><button type="button" className="orc-more" onClick={onOpenQueue}>{t('work.reviewQueue')}</button><AcceptBatch repo={repo} onSelect={onSelect} /></>)}
      {section('running', t('board.running'))}
      {section('ready', t('board.ready'))}
      {section('waiting', t('board.blocked'))}
      {section('backlog', t('board.backlog'))}
      <section className="orc-col orc-col--muted" aria-label={`${t('work.done')}: ${columns.done.length}`}>
        <div className="orc-col__bar"><button type="button" className="orc-col__head orc-work__toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>{t('work.done')} <span className="orc-col__count">{columns.done.length}</span> <span aria-hidden="true">{doneOpen ? '▾' : '▸'}</span></button></div>
        {doneOpen ? <>{/* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */} <div className="orc-work__filters" role="group" aria-label={t('work.filter')}>
          {(['all', 'accepted', 'closed', 'superseded', 'followup'] as const).map((key) => <button key={key} type="button" className="orc-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>{t(`work.filter.${key}`)}</button>)}
        </div>{filter === 'followup' ? <p className="orc-meta">{t('work.followupHint')}</p> : null}<ul className="orc-cards">{done.map(card)}{done.length === 0 ? <li className="orc-meta">{t('board.empty')}</li> : null}</ul></> : null}
      </section>
    </div>
  </div>
}
