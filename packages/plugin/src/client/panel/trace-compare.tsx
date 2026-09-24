import { useEffect, useMemo, useState } from 'react'
import type { RepoSnapshot, Run, TaskDetail, Trajectory } from '../../shared/types.js'
import { api } from '../api.js'
import { agentBadge, clockLabel } from '../insight.js'
import { t, useLang } from '../i18n.js'
import { type Step, toSteps } from './trace-steps.js'

/**
 * Two runs of one task under each other on a shared scale, and the block that answers the only
 * question the pair is opened for: what changed between them.
 */

export type RunShare = { read: number; edit: number; cmd: number }
export type RunFacts = { durationMs: number; steps: number; share: RunShare; steers: number; outcome: string }

const OUTCOME_LABEL: Record<string, string> = { get completed() { return t('panel.compare.outcome.completed') }, get failed() { return t('panel.compare.outcome.failed') }, get cancelled() { return t('panel.compare.outcome.cancelled') } }
const KINDS = ['read', 'edit', 'cmd'] as const

export const runLabel = (run: Run, index: number): string => t('panel.compare.runLabel', { count: index + 1, agent: run.agent })

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** What the trace of one run says in numbers; works with no trace at all — then only the clock is known. */
export function runFacts(run: Run, trace: Trajectory | null, notes: TaskDetail['notes'] = []): RunFacts {
  const steps: Step[] = trace ? toSteps(trace).filter((s) => s.kind !== 'input') : []
  const started = Date.parse(run.startedAt)
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN
  const durationMs = trace ? trace.totals.durationMs : Number.isFinite(finished) ? finished - started : 0
  const spent = (kind: (typeof KINDS)[number]) => steps.filter((s) => s.kind === kind).reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
  const end = Number.isFinite(finished) ? finished : Number.POSITIVE_INFINITY
  return {
    durationMs,
    steps: steps.length,
    share: { read: percent(spent('read'), durationMs), edit: percent(spent('edit'), durationMs), cmd: percent(spent('cmd'), durationMs) },
    steers: notes.filter((n) => n.type === 'steer' && Date.parse(n.at) >= started && Date.parse(n.at) <= end).length,
    outcome: run.outcome ? (OUTCOME_LABEL[run.outcome] ?? run.outcome) : t('panel.compare.running'),
  }
}

/** The one phrase that goes above the table: the difference a human would say out loud. */
export function compareAnswer(a: RunFacts, b: RunFacts): string {
  const slower = a.durationMs > 0 && b.durationMs > 0 ? b.durationMs / a.durationMs : 1
  const time =
    a.durationMs === 0 || b.durationMs === 0
      ? t('panel.compare.timeUnknown')
      : slower >= 1.15
        ? t('panel.compare.slower', { factor: slower.toFixed(1) })
        : slower <= 0.87
          ? t('panel.compare.faster', { factor: (1 / slower).toFixed(1) })
          : t('panel.compare.sameTime')
  const steps = b.steps === a.steps ? t('panel.compare.sameSteps') : b.steps > a.steps ? t('panel.compare.moreSteps', { count: b.steps - a.steps }) : t('panel.compare.fewerSteps', { count: a.steps - b.steps })
  return t('panel.compare.answer', { time, steps })
}

const shareLine = (f: RunFacts) => `${f.share.read} % / ${f.share.edit} % / ${f.share.cmd} %`

function Track({ trace, scaleMs, label }: { trace: Trajectory | null; scaleMs: number; label: string }) {
  if (!trace) return /* biome-ignore lint/a11y/useAriaPropsSupportedByRole: This label describes a styled presentation region or indicator. */ <div className="orc-cmp__track" aria-label={t('panel.compare.traceUnavailable', { label })} />
  const span = Math.max(1, scaleMs)
  return (
    <div className="orc-cmp__track" role="img" aria-label={label}>
      {toSteps(trace)
        .filter((s) => s.kind !== 'input')
        .map((step) => (
          <span
            key={step.key}
            className={`orc-cmp__step${step.approximate ? ' orc-cmp__step--approx' : ''}`}
            style={{
              left: `${((step.start - trace.start) / span) * 100}%`,
              width: `${Math.max(((step.end - step.start) / span) * 100, 0.6)}%`,
              background: `var(--orc-k-${step.kind})`,
            }}
          />
        ))}
    </div>
  )
}

export function CompareRuns({ repo, taskId, runs, notes }: { repo: RepoSnapshot; taskId: string; runs: Run[]; notes: TaskDetail['notes'] }) {
  const lang = useLang()
  const last = runs.at(-1)
  const previous = runs.at(-2)
  const [aId, setAId] = useState(previous?.runId ?? '')
  const [bId, setBId] = useState(last?.runId ?? '')
  const [traces, setTraces] = useState<Record<string, Trajectory | null>>({})

  const a = runs.find((r) => r.runId === aId) ?? previous
  const b = runs.find((r) => r.runId === bId) ?? last

  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    let alive = true
    for (const run of [a, b]) {
      if (!run || run.runId in traces) continue
      api
        .trace(repo.root, taskId, run.runId)
        .then((r) => {
          if (alive) setTraces((old) => ({ ...old, [run.runId]: r.ok ? r.value : null }))
        })
        .catch(() => {
          if (alive) setTraces((old) => ({ ...old, [run.runId]: null }))
        })
    }
    return () => {
      alive = false
    }
  }, [repo.root, taskId, a?.runId, b?.runId, traces])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  const facts = useMemo(() => {
    if (!a || !b) return null
    return { a: runFacts(a, traces[a.runId] ?? null, notes), b: runFacts(b, traces[b.runId] ?? null, notes) }
  }, [a, b, traces, notes, lang])

  if (!a || !b || !facts) return <p className="orc-empty">{t('panel.compare.onlyOneRun')}</p>

  const scaleMs = Math.max(1, facts.a.durationMs, facts.b.durationMs)
  const pick = (value: string, onChange: (id: string) => void, label: string) => (
    <select className="orc-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {runs.map((run, i) => (
        <option key={run.runId} value={run.runId}>
          {runLabel(run, i)}
        </option>
      ))}
    </select>
  )

  const rows: Array<[string, string, string]> = [
    [t('panel.compare.duration'), clockLabel(facts.a.durationMs), clockLabel(facts.b.durationMs)],
    [t('panel.compare.steps'), `${facts.a.steps}`, `${facts.b.steps}`],
    [t('panel.compare.activity'), shareLine(facts.a), shareLine(facts.b)],
    [t('panel.compare.steers'), `${facts.a.steers}`, `${facts.b.steers}`],
    [t('panel.compare.outcome'), facts.a.outcome, facts.b.outcome],
  ]

  return (
    <section className="orc-cmp" aria-label={t('panel.compare.aria')}>
      <p className="orc-answer">{compareAnswer(facts.a, facts.b)}</p>
      <div className="orc-cmp__pickers">
        {pick(a.runId, setAId, t('panel.compare.firstRun'))}
        {pick(b.runId, setBId, t('panel.compare.secondRun'))}
      </div>

      {[a, b].map((run, i) => (
        <div key={`${run.runId}-${i}`} className="orc-cmp__row">
          <span className="orc-cmp__name">
            <span className="orc-wk" aria-hidden="true">
              {agentBadge(run.agent)}
            </span>
            {runLabel(run, runs.indexOf(run))}
          </span>
          <Track trace={traces[run.runId] ?? null} scaleMs={scaleMs} label={t('panel.compare.runSteps', { id: run.runId })} />
          <span className="orc-cmp__meta orc-num">{clockLabel(i === 0 ? facts.a.durationMs : facts.b.durationMs)}</span>
        </div>
      ))}

      <table className="orc-table">
        <caption className="orc-cmp__caption">{t('panel.compare.difference')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('panel.compare.what')}</th>
            <th scope="col">{runLabel(a, runs.indexOf(a))}</th>
            <th scope="col">{runLabel(b, runs.indexOf(b))}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, left, right]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="orc-num">{left}</td>
              <td className="orc-num">{right}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="orc-hint">{t('panel.compare.scaleHint')}</p>
    </section>
  )
}
