import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoSnapshot, TaskDetail, Trajectory, WorkerInfo } from '../../shared/types.js'
import { identityLabel, workerIdentity } from '../provider.js'
import { useAction } from '../actions.js'
import { api } from '../api.js'
import { agentBadge, clockLabel, turnsWord } from '../insight.js'
import type { Density } from '../store.js'
import { directWorker, workerOptions } from '../workers.js'
import { t, useLang } from '../i18n.js'
import { CompareRuns } from './trace-compare.js'
import { LedgerView } from '../lazy-views.js'
import { anchorForRecord } from './trace-anchor.js'
import { type Entity, KIND_NAME, type Step, type StepKind, type TraceLane, offset, toEntities, toSteps } from './trace-steps.js'

export { KIND_NAME, offset, spanKind, toEntities, toSteps } from './trace-steps.js'
export type { Entity, Step, StepKind, TraceLane } from './trace-steps.js'

export type TraceTarget = {
  taskId: string
  taskTitle: string
  run: { runId: string; agent: string; startedAt: string; active?: boolean }
}

type View = 'ledger' | 'lanes' | 'journal' | 'compare'

const LANES: Array<{ key: TraceLane; label: string }> = [
  { key: 'input', get label() { return t('panel.trace.lane.input') } },
  { key: 'model', get label() { return t('panel.trace.lane.model') } },
  { key: 'tools', get label() { return t('panel.trace.lane.tools') } },
  { key: 'watch', get label() { return t('panel.trace.lane.watch') } },
]

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null
  return !!el && (EDITABLE.has(el.tagName) || el.isContentEditable === true)
}

/** The label a relaunch or a correction starts from — the step the human is looking at. */
export const stepAnchor = (entity: Entity | null): string | undefined => entity?.steps[0]?.label

/**
 * One main button per run state: an active run can be corrected from this step,
 * and a finished one can be relaunched from it. The other action lives in the menu.
 */
function InspectorActions({
  repo,
  workers,
  target,
  entity,
  onSteerFrom,
}: {
  repo: RepoSnapshot
  workers?: readonly WorkerInfo[]
  target: TraceTarget
  entity: Entity
  onSteerFrom?(prefill: string): void
}) {
  useLang()
  const [form, setForm] = useState(false)
  const [note, setNote] = useState('')
  const [worker, setWorker] = useState(directWorker(target.run.agent))
  const [started, setStarted] = useState<string | null>(null)
  const action = useAction()
  const anchor = stepAnchor(entity) ?? ''
  const active = target.run.active === true

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    setForm(false)
    setNote('')
    setStarted(null)
  }, [entity.key])

  const steer = () => onSteerFrom?.(t('panel.trace.fromStep', { step: anchor }))
  const relaunch = () =>
    action
      .call(async () => {
        const result = await api.relaunch(repo.root, target.taskId, { agent: worker, fromStep: anchor, ...(note.trim() ? { note: note.trim() } : {}) })
        if (result.ok) setStarted(result.value.runId)
        return result
      })
      .then((ok) => {
        if (ok) {
          setForm(false)
          setNote('')
        }
      })

  const primaryLabel = active ? t('panel.trace.steerFrom') : t('panel.trace.relaunchFrom')
  const otherLabel = active ? t('panel.trace.relaunchFrom') : t('panel.trace.steer')
  const onPrimary = () => (active ? steer() : setForm(!form))
  const onOther = () => (active ? setForm(!form) : steer())

  return (
    <div className="orc-insp__acts">
      <div className="orc-actions">
        <button type="button" className="orc-btn" onClick={onPrimary} aria-expanded={active ? undefined : form}>
          {primaryLabel}
        </button>
        <details className="orc-menu">
          <summary className="orc-btn orc-btn--ghost">{t('panel.trace.more')} ▾</summary>
          <div className="orc-menu__list">
            <button type="button" className="orc-more" onClick={onOther}>
              {otherLabel}
            </button>
          </div>
        </details>
      </div>

      {form ? (
        <div className="orc-form">
          <p className="orc-hint">{t('panel.trace.relaunchHint')}</p>
          <select className="orc-select" aria-label={t('panel.trace.worker')} value={worker} onChange={(e) => setWorker(e.target.value)}>
            {workerOptions(worker, workers).map((w) => (
              <option key={w} value={w}>
                {identityLabel(workerIdentity(w, workers))}
              </option>
            ))}
          </select>
          <textarea
            className="orc-field"
            aria-label={t('panel.trace.workerInstruction')}
            placeholder={t('panel.trace.instructionPlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="orc-actions">
            <button type="button" className="orc-btn" disabled={action.pending} onClick={relaunch}>
              {t('panel.trace.relaunch')}
            </button>
            <button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm(false)}>
              {t('panel.trace.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {started ? (
        <p className="orc-meta" role="status">
          {t('panel.trace.started')} <code>{started}</code>
        </p>
      ) : null}
      {action.error ? <p className="orc-error">{action.error}</p> : null}
    </div>
  )
}

function Inspector({
  entity,
  start,
  onClose,
  repo,
  workers,
  target,
  onSteerFrom,
}: {
  entity: Entity | null
  start: number
  onClose(): void
  repo: RepoSnapshot
  workers?: readonly WorkerInfo[]
  target: TraceTarget
  onSteerFrom?(prefill: string): void
}) {
  useLang()
  if (!entity) {
    return (
      <aside className="orc-tr__insp" aria-live="polite">
        <p className="orc-meta">{t('panel.trace.selectStep')}</p>
      </aside>
    )
  }
  const many = entity.steps.length > 1
  return (
    <aside className="orc-tr__insp" aria-live="polite" aria-label={t('panel.trace.runStep')}>
      <div className="orc-tr__ihead">
        <h3 className="orc-tr__it">{many ? t('panel.trace.nearbyMarks', { count: entity.steps.length }) : entity.steps[0]?.label}</h3>
        <button type="button" className="orc-more" onClick={onClose}>
          {t('panel.trace.close')}
        </button>
      </div>
      {entity.steps.map((step: Step) => {
        const length = step.end - step.start
        return (
          <div key={step.key} className="orc-tr__istep">
            {many ? <p className="orc-tr__it">{step.label}</p> : null}
            <p className="orc-meta">
              {KIND_NAME[step.kind]} · {offset(step.start, start)}
              {length > 0 ? ` · ${clockLabel(length)}` : ''}
            </p>
            {step.approximate ? <p className="orc-hint">{t('panel.trace.approximate')}</p> : null}
          </div>
        )
      })}
      <p className="orc-hint">{t('panel.trace.feedHint')}</p>
      <InspectorActions repo={repo} workers={workers} target={target} entity={entity} onSteerFrom={onSteerFrom} />
    </aside>
  )
}

export function TraceScreen({
  repo,
  workers,
  target,
  density,
  onClose,
  onSteerFrom,
  trace: given,
  now = new Date(),
}: {
  repo: RepoSnapshot
  workers?: readonly WorkerInfo[]
  target: TraceTarget
  density: Density
  onClose(): void
  onSteerFrom?(prefill: string): void
  trace?: Trajectory
  now?: Date
}) {
  const lang = useLang()
  const [fetched, setFetched] = useState<Trajectory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [view, setView] = useState<View>(given && !given.records ? 'lanes' : 'ledger')
  const [selected, setSelected] = useState<string | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const root = useRef<HTMLElement>(null)
  const trace = given ?? fetched

  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (given) return
    let alive = true
    setFetched(null)
    setError(null)
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => { void api
      .trace(repo.root, target.taskId, target.run.runId)
      .then((r) => {
        if (!alive) return
        if (r.ok) {
          setFetched(r.value)
          if (target.run.active && !r.value.outcome) timer = setTimeout(refresh, 2000)
        }
        else setError(r.message ?? r.error)
      })
      .catch(() => {
        if (alive) setError(t('panel.trace.serverUnavailable'))
      })
    }
    refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [repo.root, target.taskId, target.run.runId, given])

  // The task's run list determines whether comparison is available.
  useEffect(() => {
    let alive = true
    api
      .task(repo.root, target.taskId)
      .then((r) => {
        if (alive) setDetail(r.ok ? r.value : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [repo.root, target.taskId])

  const runs = detail?.runs ?? []
  const canCompare = runs.length >= 2

  // biome-ignore lint/correctness/useExhaustiveDependencies: Locale changes intentionally refresh the translated result.
  const steps = useMemo(() => (trace ? toSteps(trace) : []), [trace, lang])
  const entities = useMemo(() => (trace ? toEntities(steps, trace.start, trace.end) : []), [steps, trace])
  const current = entities.find((e) => e.key === selected) ?? null

  const move = (delta: number) => {
    if (entities.length === 0) return
    const index = entities.findIndex((e) => e.key === selected)
    const next = entities[Math.min(entities.length - 1, Math.max(0, (index < 0 ? -1 : index) + delta))]
    if (next) focus(next.key)
  }
  const jump = (delta: number) => {
    const problems = entities.filter((e) => e.steps.some((s) => s.kind === 'problem'))
    if (problems.length === 0) return
    const index = problems.findIndex((e) => e.key === selected)
    const next = problems[(((index < 0 ? -delta : index + delta) % problems.length) + problems.length) % problems.length]
    if (next) focus(next.key)
  }
  const focus = (key: string) => {
    setSelected(key)
    buttons.current.get(key)?.focus()
  }

  // Escape must work even before the first step is clicked, when focus is still outside the lanes.
  useEffect(() => {
    const onWindowKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (root.current && active && root.current.contains(active)) return
      onClose()
    }
    window.addEventListener('keydown', onWindowKey)
    return () => window.removeEventListener('keydown', onWindowKey)
  }, [onClose])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The inspector now carries a text field: navigation keys belong to the lanes, letters to the typist.
    if (isTyping(event.target) && event.key !== 'Escape') return
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(1),
      ArrowLeft: () => move(-1),
      j: () => jump(1),
      k: () => jump(-1),
      Escape: () => (selected ? setSelected(null) : onClose()),
    }
    const handler = keys[event.key]
    if (!handler) return
    event.preventDefault()
    event.stopPropagation()
    handler()
  }

  const status = target.run.active
    ? t('panel.trace.statusRunning', { time: clockLabel(now.getTime() - Date.parse(target.run.startedAt)) })
    : trace
      ? t('panel.trace.statusFinishedTime', { time: clockLabel(trace.totals.durationMs) })
      : t('panel.trace.statusFinished')

  const views: Array<{ key: View; label: string; disabled?: boolean; hint?: string }> = [
    ...(trace?.records ? [{ key: 'ledger' as const, label: t('panel.ledger.title') }] : [{ key: 'lanes' as const, label: t('panel.trace.viewLanes') }, { key: 'journal' as const, label: t('panel.trace.viewJournal') }]),
    {
      key: 'compare',
      label: t('panel.trace.viewCompare'),
      disabled: !canCompare,
      ...(canCompare ? {} : { hint: t('panel.trace.compareUnavailable') }),
    },
  ]

  return (
    <section className="orc-tr" ref={root} aria-label={t('panel.trace.aria', { id: target.run.runId })} onKeyDown={onKeyDown}>
      <header className="orc-tr__head">
        <span className="orc-wk" aria-hidden="true">
          {agentBadge(target.run.agent)}
        </span>
        <h2 className="orc-tr__title">{target.taskTitle}</h2>
        <span className={`orc-tr__status${target.run.active ? ' orc-tr__status--live' : ''}`}>
          {target.run.active ? <span className="orc-pulse" aria-hidden="true" /> : null}
          {status}
        </span>
        <span className="orc-top__spacer" />
        <div className="orc-seg" role="radiogroup" aria-label={t('panel.trace.viewLabel')}>
          {views.map((item) => (
            /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <button
              key={item.key}
              type="button"
              role="radio"
              className="orc-seg__item"
              aria-checked={view === item.key}
              disabled={item.disabled}
              {...(item.hint ? { title: item.hint, 'aria-description': item.hint } : {})}
              onClick={() => setView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="orc-btn orc-btn--ghost" onClick={onClose}>
          {t('panel.trace.backToPlan')}
        </button>
      </header>

      {view === 'compare' ? (
        <div className="orc-tr__pane">
          <CompareRuns repo={repo} taskId={target.taskId} runs={runs} notes={detail?.notes ?? []} />
        </div>
      ) : !trace ? (
        <p className="orc-empty">{error ? t('panel.trace.unavailable', { error }) : t('panel.trace.loading')}</p>
      ) : view === 'ledger' ? (
        <LedgerView trace={trace} repo={repo} target={target} workers={workers} onSteerFrom={onSteerFrom} actions={(record) => <InspectorActions repo={repo} workers={workers} target={target} entity={anchorForRecord(record)} onSteerFrom={onSteerFrom} />} />
      ) : steps.length === 0 ? (
        <p className="orc-empty">{t('panel.trace.noSteps')}</p>
      ) : view === 'journal' ? (
        <ol className="orc-tr__journal">
          {steps.map((step) => (
            <li key={step.key} className={`orc-ev${step.kind === 'problem' ? ' orc-ev--problem' : ''}`}>
              <i className="orc-ev__time">{offset(step.start, trace.start)}</i>
              <span className="orc-ev__kind" style={{ color: `var(--orc-k-${step.kind})` }} aria-hidden="true">
                ■
              </span>
              <span className="orc-ev__text">
                {step.label}
                <span className="orc-tr__jmeta">
                  {KIND_NAME[step.kind]}
                  {step.end > step.start ? ` · ${clockLabel(step.end - step.start)}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="orc-tr__body">
          <div className="orc-tr__lanes">
            {LANES.map((lane) => (
              <div key={lane.key} className="orc-tr__lane">
                <span className="orc-tr__lname">{lane.label}</span>
                <div className="orc-tr__track">
                  {entities
                    .filter((e) => e.lane === lane.key)
                    .map((entity) => {
                      const span = Math.max(1, trace.end - trace.start)
                      const left = ((entity.start - trace.start) / span) * 100
                      const first = entity.steps[0]
                      if (!first) return null
                      const width = ((Math.max(...entity.steps.map((s) => s.end)) - entity.start) / span) * 100
                      const mark = width <= 0
                      const label =
                        entity.steps.length > 1
                          ? t('panel.trace.marksAt', { count: entity.steps.length, time: offset(entity.start, trace.start) })
                          : `${first.label}, ${KIND_NAME[first.kind]}, ${offset(first.start, trace.start)}${first.end > first.start ? `, ${clockLabel(first.end - first.start)}` : ''}`
                      return (
                        <button
                          key={entity.key}
                          type="button"
                          ref={(el) => {
                            if (el) buttons.current.set(entity.key, el)
                            else buttons.current.delete(entity.key)
                          }}
                          className={`orc-tr__step${mark ? ' orc-tr__step--mark' : ''}${first.approximate ? ' orc-tr__step--approx' : ''}`}
                          style={{ left: `${left}%`, ...(mark ? {} : { width: `${Math.max(width, 0.4)}%` }), ['--orc-k' as string]: `var(--orc-k-${first.kind})` }}
                          aria-pressed={selected === entity.key}
                          aria-label={label}
                          title={label}
                          onClick={() => focus(entity.key)}
                        >
                          {entity.steps.length > 1 ? <span className="orc-tr__count">{entity.steps.length}</span> : null}
                        </button>
                      )
                    })}
                </div>
              </div>
            ))}

            <div className="orc-legend" aria-hidden="true">
              {(['input', 'model', 'read', 'edit', 'cmd', 'problem'] as StepKind[]).map((kind) => (
                <span key={kind}>
                  <span className="orc-sw" style={{ background: `var(--orc-k-${kind})` }} />
                  {KIND_NAME[kind]}
                </span>
              ))}
            </div>

            {density === 'detail' ? (
              <dl className="orc-facts">
                <div>
                  <dt>{t('panel.trace.time')}</dt>
                  <dd>
                    {t('panel.trace.timeBreakdown', { total: clockLabel(trace.totals.durationMs), model: clockLabel(trace.totals.modelMs), tools: clockLabel(trace.totals.toolMs) })}
                  </dd>
                </div>
                <div>
                  <dt>{t('panel.trace.steps')}</dt>
                  <dd>
                    {t('panel.trace.toolCalls', { count: trace.totals.toolCalls })} · {turnsWord(trace.totals.turns)}
                  </dd>
                </div>
                <div>
                  <dt>{t('panel.trace.context')}</dt>
                  <dd>
                    {trace.totals.contextPeak
                      ? t('panel.trace.contextUsage', { used: Math.round(trace.totals.contextPeak.used / 1000), size: Math.round((trace.totals.contextPeak.size || 0) / 1000) })
                      : t('panel.trace.noData')}
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
          <Inspector entity={current} start={trace.start} onClose={() => setSelected(null)} repo={repo} workers={workers} target={target} onSteerFrom={onSteerFrom} />
        </div>
      )}
    </section>
  )
}
