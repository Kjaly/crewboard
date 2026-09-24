import { useEffect, useState } from 'react'
import type { Trajectory } from '../../shared/types.js'
import { api } from '../api.js'
import { clockLabel } from '../insight.js'
import { t, useLang } from '../i18n.js'
import type { TraceTarget } from './trace.js'
import { KIND_NAME, offset, toSteps } from './trace-steps.js'

/** The selected run's trace stays beside the plan, under Activity. */
export function RunTracePanel({ root, target, onBack }: { root: string; target: TraceTarget; onBack(): void }) {
  useLang()
  const [trajectory, setTrajectory] = useState<Trajectory | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setTrajectory(null)
    setError(null)
    void api.trace(root, target.taskId, target.run.runId).then((result) => {
      if (!live) return
      if (result.ok) setTrajectory(result.value)
      else setError(result.message ?? result.error)
    }).catch(() => { if (live) setError(t('panel.trace.serverUnavailable')) })
    return () => { live = false }
  }, [root, target.taskId, target.run.runId])
  return <section className="orc-runtrace" aria-label={t('panel.trace.aria', { id: target.run.runId })}>
    <button type="button" className="orc-more" onClick={onBack}>← {t('panel.task.tab.activity')}</button>
    <h3 className="orc-block__head">{target.run.agent} · {target.run.runId}</h3>
    {trajectory ? <><p className="orc-meta">{clockLabel(trajectory.totals.durationMs)} · {t('review.steps', { count: trajectory.spans.length })}</p>
      <ul className="orc-list">{toSteps(trajectory).map((step) => <li key={step.key} className={`orc-ev${step.kind === 'problem' ? ' orc-ev--problem' : ''}`}>
        <i className="orc-ev__time">{offset(step.start, trajectory.start)}</i>
        <span className="orc-ev__text"><strong>{KIND_NAME[step.kind]}</strong> · {step.label}</span>
      </li>)}</ul></> : <p className="orc-meta">{error ? t('panel.trace.unavailable', { error }) : t('panel.trace.loading')}</p>}
  </section>
}
