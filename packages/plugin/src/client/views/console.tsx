import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Attention, TaskDetail, TaskSnapshot } from '../../shared/types.js'
import { useAction } from '../actions.js'
import { api } from '../api.js'
import { deadEnds } from '../dead-ends.js'
import { lensIds, lensTasks } from '../lens.js'
import { relativeTime, t, useLang } from '../i18n.js'
import { taskTone } from '../styles.js'
import { sinceLabel, taskEssence } from '../summary.js'
import { AcceptBatch } from './accept-batch.js'
import type { ViewProps } from './types.js'

function Block({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="orc-block" aria-label={`${title}: ${count}`}>
      <div className="orc-col__bar">
        <h2 className="orc-block__head">
          <span>{title}</span>
          <span className="orc-col__count">{count}</span>
        </h2>
        {action}
      </div>
      {count === 0 ? <p className="orc-meta">{t('panel.console.emptyBlock')}</p> : <ul className="orc-rows">{children}</ul>}
    </section>
  )
}

function Row({
  task,
  meta,
  tone,
  selected,
  detailed,
  dim,
  rowRef,
  onSelect,
  children,
}: {
  task: TaskSnapshot
  meta: string
  tone?: 'warn' | 'alert'
  selected: boolean
  detailed?: boolean
  dim?: boolean
  rowRef?(el: HTMLLIElement | null): void
  onSelect(id: string): void
  children?: ReactNode
}) {
  const status = taskTone(task)
  return (
    <li ref={rowRef} className={`orc-row${dim ? ' orc-lens-dim' : ''}`}>
      <button type="button" className="orc-row__main" aria-pressed={selected} onClick={() => onSelect(task.id)}>
        <span className="orc-card__top">
          <span className="orc-glyph" style={{ color: status.color }} aria-hidden="true">
            {task.status === 'running' ? <span className="orc-pulse" /> : status.glyph}
          </span>
          <span className="orc-card__title">{task.title}</span>
          {detailed ? <span className="orc-card__id">{task.id}</span> : null}
        </span>
        <span className={`orc-meta${tone ? ` orc-meta--${tone}` : ''}`}>
          {tone ? <span className="orc-sr-only">{status.label}. </span> : null}
          {meta}
        </span>
      </button>
      {children}
    </li>
  )
}

type RowLens = { dim: boolean; rowRef(el: HTMLLIElement | null): void }

function AttentionRow({ item, task, selected, detailed, onSelect, root, dim, rowRef }: { item: Attention; task: TaskSnapshot; selected: boolean; detailed: boolean; onSelect(id: string): void; root: string } & RowLens) {
  const action = useAction()
  const meta = item.hint ? `${item.message} → ${item.hint}` : item.message
  return (
    <Row task={task} meta={meta} tone={item.severity === 'alert' ? 'alert' : 'warn'} selected={selected} detailed={detailed} dim={dim} rowRef={rowRef} onSelect={onSelect}>
      {task.status === 'running' ? (
        <button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => action.call(() => api.stop(root, task.id))}>
          {t('panel.console.stop')}
        </button>
      ) : (
        <button type="button" className="orc-btn orc-btn--ghost" onClick={() => onSelect(task.id)}>
          {t('panel.console.open')}
        </button>
      )}
      {action.error ? <span className="orc-error">{action.error}</span> : null}
    </Row>
  )
}

function ReadyRow({ task, selected, detailed, onSelect, root, now, dim, rowRef }: { task: TaskSnapshot; selected: boolean; detailed: boolean; onSelect(id: string): void; root: string; now: Date } & RowLens) {
  const action = useAction()
  // A decision is never handed to a worker: it opens in the panel, where the human answers it.
  if (task.needsHuman) {
    return (
      <Row task={task} meta={taskEssence(task, now)} selected={selected} detailed={detailed} dim={dim} rowRef={rowRef} onSelect={onSelect}>
        <button type="button" className="orc-btn orc-btn--ghost" onClick={() => onSelect(task.id)}>
          {t('panel.console.open')}
        </button>
      </Row>
    )
  }
  return (
    <Row task={task} meta={taskEssence(task, now)} selected={selected} detailed={detailed} dim={dim} rowRef={rowRef} onSelect={onSelect}>
      <button
        type="button"
        className="orc-btn"
        disabled={action.pending}
        onClick={() => action.call(() => api.run(root, task.id))}
      >
          {t('panel.console.run')}
      </button>
      {action.error ? <span className="orc-error">{action.error}</span> : null}
    </Row>
  )
}

/**
 * Answers, top to bottom: what is broken, what is working, what could start now. On a wide window
 * attention keeps the left column and work stacks on the right; on a narrow one it is a single track.
 */
export function ConsoleView({ repo, selectedId, onSelect, density, lens = null, walk }: ViewProps) {
  useLang()
  const now = new Date()
  const detailed = density === 'detail'
  const byId = new Map(repo.tasks.map((t) => [t.id, t]))
  const attention = repo.attention.filter((a) => byId.has(a.taskId))
  const running = repo.tasks.filter((t) => t.status === 'running')
  const ready = repo.tasks.filter((t) => t.status === 'ready')
  const ended = deadEnds(repo)
  const selected = selectedId ? byId.get(selectedId) : undefined
  const [detail, setDetail] = useState<TaskDetail | null>(null)

  // A lens on the console: every row stays on the list, the non-matching ones step back to 45 %.
  const matchIds = lensIds(repo, lens)
  const lensOn = lens !== null && matchIds.size > 0
  const rows = useRef(new Map<string, HTMLLIElement>())
  const rowRef = (id: string) => (el: HTMLLIElement | null) => {
    if (el) rows.current.set(id, el)
    else rows.current.delete(id)
  }
  const lensOf = (id: string): RowLens => ({ dim: lensOn && !matchIds.has(id), rowRef: rowRef(id) })
  const firstMatch = lensTasks(repo, lens)[0]?.id
  useEffect(() => {
    if (lensOn && firstMatch) rows.current.get(firstMatch)?.scrollIntoView?.({ block: 'nearest' })
  }, [lensOn, firstMatch])
  useEffect(() => {
    if (walk) rows.current.get(walk.id)?.scrollIntoView?.({ block: 'nearest' })
  }, [walk])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (!selected || selected.status !== 'running') {
      setDetail(null)
      return
    }
    let alive = true
    api
      .task(repo.root, selected.id)
      .then((r) => {
        if (alive) setDetail(r.ok ? r.value : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [repo.root, selected?.id, selected?.status, selected?.lastRunId])

  // An empty plan (or a plan with nothing in flight) gets one calm line, not three hollow cards.
  if (repo.tasks.length === 0) {
    return <p className="orc-empty">{t('panel.console.noTasks')}</p>
  }
  if (attention.length === 0 && running.length === 0 && ready.length === 0 && ended.length === 0) {
    return <p className="orc-empty">{t('panel.console.idle')}</p>
  }

  return (
    <div className="orc-console">
      <div className="orc-console__col">
        <Block title={t('panel.console.attention')} count={attention.length} action={<AcceptBatch repo={repo} onSelect={onSelect} />}>
          {attention.map((item) => {
            const task = byId.get(item.taskId)
            return task ? (
              <AttentionRow key={`${item.runId}:${item.kind}`} item={item} task={task} selected={selectedId === task.id} detailed={detailed} onSelect={onSelect} root={repo.root} {...lensOf(task.id)} />
            ) : null
          })}
        </Block>
      </div>

      <div className="orc-console__col">
        <Block title={t('panel.console.running')} count={running.length}>
          {running.map((task) => {
            const last = task.id === selected?.id ? detail?.events.at(-1) : undefined
            const parts = [task.worker ?? t('panel.console.worker'), sinceLabel(task.activeSince, now), last?.text].filter(Boolean) as string[]
            return <Row key={task.id} task={task} meta={parts.join(' · ')} selected={selectedId === task.id} detailed={detailed} onSelect={onSelect} {...lensOf(task.id)} />
          })}
        </Block>

        <Block title={t('panel.console.ready')} count={ready.length}>
          {ready.map((task) => (
            <ReadyRow key={task.id} task={task} selected={selectedId === task.id} detailed={detailed} onSelect={onSelect} root={repo.root} now={now} {...lensOf(task.id)} />
          ))}
        </Block>

        {ended.length > 0 ? (
          <section className="orc-block" aria-label={t('panel.console.deadEndsCount', { count: ended.length })}>
            <div className="orc-col__bar">
              <h2 className="orc-block__head">
                <span>{t('panel.console.deadEnds')}</span>
                <span className="orc-col__count">{ended.length}</span>
              </h2>
            </div>
            <ul className="orc-rows">
              {ended.map((task) => (
                <Row key={task.id} task={task} meta={t('panel.console.acceptedAgo', { worker: task.worker ?? t('panel.console.worker'), time: task.acceptedAt && Number.isFinite(Date.parse(task.acceptedAt)) ? relativeTime(new Date(task.acceptedAt), now) : t('panel.console.longAgo') })} selected={selectedId === task.id} detailed onSelect={onSelect} {...lensOf(task.id)} />
              ))}
            </ul>
            <p className="orc-meta">{t('panel.console.deadEndsHint')}</p>
          </section>
        ) : null}
      </div>

      {density === 'detail' ? (
        <section className="orc-block orc-console__tally" aria-label={t('panel.console.totals')}>
          <h2 className="orc-block__head">
            <span>{t('panel.console.totals')}</span>
          </h2>
          <dl className="orc-facts">
            <div>
              <dt>{t('panel.console.totalTasks')}</dt>
              <dd className="orc-num">{repo.tasks.length}</dd>
            </div>
            <div>
              <dt>{t('panel.console.accepted')}</dt>
              <dd className="orc-num">{repo.tasks.filter((t) => t.status === 'accepted').length}</dd>
            </div>
            <div>
              <dt>{t('panel.console.criticalPath')}</dt>
              <dd>{repo.criticalPath.join(' → ') || '—'}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  )
}
