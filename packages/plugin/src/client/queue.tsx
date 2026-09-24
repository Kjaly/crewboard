import { useEffect, useMemo, useState } from 'react'
import type { RepoSnapshot, TaskDetail, TaskSnapshot } from '../shared/types.js'
import { useAction } from './actions.js'
import { api } from './api.js'
import { t, useLang } from './i18n.js'
import { usePlanCost } from './insight.js'
import { reportLine } from './panel/report.js'
import type { PlanItem } from './plans.js'
import { acceptableTasks, backgroundReview } from './review.js'
import { taskTone } from './styles.js'
import { orchestraStore } from './store.js'
import { AcceptBatch, waitLabels } from './views/accept-batch.js'

const FILES_SHOWN = 8

/**
 * One row of the queue. Each row fetches its task detail once on mount: the report's first line
 * sits under the title before any expanding — the queue is short, so the `git diff` is paid per
 * waiting task, not per row of the whole plan. Expanding reuses the same detail for the file list.
 */
function QueueRow({
  root,
  task,
  wait,
  onOpenTask,
}: {
  root: string
  task: TaskSnapshot
  wait?: string
  onOpenTask(id: string, changes?: boolean): void
}) {
  useLang()
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const tone = taskTone(task)
  const decision = task.kind === 'decision'

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let alive = true
    api
      .task(root, task.id)
      .then((r) => {
        if (alive) setDetail(r.ok ? r.value : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [root, task.id, task.runs, task.lastRunId])

  const files = detail?.changedFiles
  const report = detail?.report?.text.trim() ? reportLine(detail.report.text) : undefined
  // w1b (B03): the verdict next to the title, so a risky result is visible before Accept; a decision has none (B05).
  const verdict = detail?.verdict
  const verdictReason = verdict?.why ? t(`verdict.why.${verdict.why}`) : verdict?.mismatch ? t(`verdict.mismatch.${verdict.mismatch}`).replace(/\.$/, '') : ''
  const meta = [decision ? t('queue.decisionYours') : (task.worker ?? '—'), wait, open && files ? t('queue.files', { count: files.length }) : undefined]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="orc-qrow">
      <button type="button" className="orc-qrow__top" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="orc-glyph" style={{ color: tone.color }} aria-hidden="true">
          {tone.glyph}
        </span>
        <span className="orc-card__id">{task.id}</span>
        <span className="orc-card__title">{task.title}</span>
        <span className="orc-qrow__chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {verdict ? <span className={`orc-qrow__verdict orc-verdict--${verdict.kind}`} title={verdictReason || undefined}><span className="orc-verdict__mark" aria-hidden="true">{verdict.kind === 'result' ? '✓' : verdict.kind === 'negative' ? '−' : '?'}</span>{t(`verdict.${verdict.kind}`)}{verdictReason ? ` · ${verdictReason}` : ''}</span> : null}
      {report ? <span className="orc-qrow__report">{report}</span> : null}
      <span className="orc-meta">{meta}</span>

      {open ? (
        <div className="orc-qrow__detail">
          {!detail ? (
            <span className="orc-meta">{t('queue.loadingChanges')}</span>
          ) : files && files.length > 0 ? (
            <ul className="orc-qrow__files">
              {files.slice(0, FILES_SHOWN).map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
              {files.length > FILES_SHOWN ? <li className="orc-meta">{t('queue.moreFiles', { count: files.length - FILES_SHOWN })}</li> : null}
            </ul>
          ) : (
            <span className="orc-meta">{decision ? t('queue.decisionNoFiles') : t('queue.noChanges')}</span>
          )}
        </div>
      ) : null}

      <div className="orc-qrow__acts">
        <button type="button" className="orc-btn orc-btn--ghost" onClick={() => onOpenTask(task.id, !decision)}>
          {decision ? t('queue.open') : t('queue.changes')}
        </button>
        <button type="button" className="orc-btn" disabled={action.pending} onClick={() => action.call(() => api.accept(root, task.id))}>
          {t('queue.accept')}
        </button>
        <button type="button" className="orc-btn orc-btn--ghost" aria-expanded={rejecting} onClick={() => setRejecting(!rejecting)}>
          {t('queue.sendBackMore')}
        </button>
      </div>

      {rejecting ? (
        <div className="orc-form">
          <textarea
            // The reason is mandatory — the worker will read it.
            // biome-ignore lint/a11y/noAutofocus: Focus moves to this field when its dialog opens.
            autoFocus
            className="orc-field"
            aria-label={t('queue.reasonLabel', { id: task.id })}
            placeholder={t('queue.reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="orc-actions">
            <button
              type="button"
              className="orc-btn"
              disabled={action.pending || !reason.trim()}
              onClick={() =>
                action.call(() => api.reject(root, task.id, reason.trim())).then((ok) => {
                  if (ok) {
                    setRejecting(false)
                    setReason('')
                  }
                })
              }
            >
              {t('queue.sendBack')}
            </button>
            <button type="button" className="orc-btn orc-btn--ghost" onClick={() => setRejecting(false)}>
              {t('queue.cancel')}
            </button>
          </div>
          <p className="orc-hint">{t('queue.confirmHint')}</p>
        </div>
      ) : null}

      {action.error ? (
        <p className="orc-error" role="status">
          {action.error}
        </p>
      ) : null}
    </li>
  )
}

/** A background plan in the queue: only the count is known; opening it switches plans. */
function OtherPlanRow({ root, plan }: { root: string; plan: PlanItem }) {
  useLang()
  const action = useAction()
  return (
    <li className="orc-qrow">
      <div className="orc-qrow__line">
        <span className="orc-glyph" style={{ color: 'var(--orc-warn)' }} aria-hidden="true">
          ◐
        </span>
        <span className="orc-card__title">{plan.goal}</span>
      </div>
      <span className="orc-meta">
        {t('queue.otherPlanReview', { count: plan.waitingHuman })}
      </span>
      <div className="orc-qrow__acts">
        <button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => orchestraStore.openWaiting({ root, planId: plan.id })}>
          {t('queue.switchPlan')}
        </button>
      </div>
      {action.error ? <p className="orc-error">{action.error}</p> : null}
    </li>
  )
}

/**
 * The acceptance queue — everything a human still has to close, in the same right-hand column the
 * task panel owns. Selecting a task from here swaps the queue back for the task panel.
 */
export function ReviewQueue({ repo, onOpenTask, onClose }: { repo: RepoSnapshot; onOpenTask(id: string, changes?: boolean): void; onClose(): void }) {
  const lang = useLang()
  const tasks = useMemo(() => acceptableTasks(repo), [repo])
  const others = useMemo(() => backgroundReview(repo), [repo])
  const otherCount = others.reduce((n, p) => n + p.waitingHuman, 0)
  const { cost } = usePlanCost(repo.root, repo.rev)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Locale changes intentionally refresh the translated result.
  const waits = useMemo(() => waitLabels(cost, new Date()), [cost, lang])

  return (
    <aside className="orc-panel orc-queue" aria-label={t('queue.title')}>
      <div className="orc-panel__scroll">
        <div className="orc-sec">
          <div className="orc-queue__bar">
            <h2 className="orc-h">{t('queue.title')}</h2>
            <button type="button" className="orc-queue__x" aria-label={t('queue.close')} onClick={onClose}>
              ×
            </button>
          </div>
          <p className="orc-sub">
            {tasks.length > 0
              ? t('queue.waitingDecisions', { count: tasks.length })
              : t('queue.emptyPlan')}
            {otherCount > 0 ? ` · ${t('queue.otherCount', { count: otherCount })}` : ''}
          </p>
          {/* The one batch entry point (w1b, B03): the same sheet as Work and the board, with verdicts. */}
          <div className="orc-actions"><AcceptBatch repo={repo} onSelect={(id) => onOpenTask(id)} /></div>
        </div>

        {tasks.length === 0 && others.length === 0 ? (
          <p className="orc-meta orc-queue__empty">
            {t('queue.emptyHint')}
          </p>
        ) : null}

        <ul className="orc-queue__list">
          {tasks.map((task) => (
            <QueueRow key={task.id} root={repo.root} task={task} wait={waits.get(task.id)} onOpenTask={onOpenTask} />
          ))}
        </ul>

        {others.length > 0 ? (
          <section className="orc-queue__other" aria-label={t('queue.otherPlans')}>
            <h3 className="orc-block__head">{t('queue.otherPlans')}</h3>
            <ul className="orc-queue__list">
              {others.map((plan) => (
                <OtherPlanRow key={plan.id} root={repo.root} plan={plan} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </aside>
  )
}
