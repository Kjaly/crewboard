import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PlanRunCost, RepoSnapshot, TaskReviewDetail, TaskReviewSummary, Trajectory } from '../../shared/types.js'
import { api } from '../api.js'
import { CopyForAgent } from '../copy-agent.js'
import { findingHandoff, taskHandoff } from '../handoff.js'
import { clockLabel } from '../insight.js'
import { getLang, t, useLang } from '../i18n.js'
import { LedgerView } from '../lazy-views.js'
import type { TraceTarget } from '../panel/trace.js'
import { formatRoute } from '../route.js'
import { ledgerStrip } from '../../../../core/src/runs/ledger-strip.js'
import { noteText } from '../note-text.js'
import { runStatus } from './review-index.js'
import { DetailStrip, StatusWord } from './review-parts.js'

export type ReviewDetail = { kind: 'run'; taskId: string; runId: string; expanded: boolean } | { kind: 'task'; taskId: string }
export type UsageMode = 'cash' | 'equivalent' | 'tokens' | 'quota'
const modes: UsageMode[] = ['cash', 'equivalent', 'tokens', 'quota']
const taskPageByKey = new Map<string, number>()
const number = (n: number) => new Intl.NumberFormat(getLang(), { maximumFractionDigits: 3 }).format(n)
const usd = (n: number) => `USD ${number(n)}`
const date = (s?: string) => s ? new Date(s).toLocaleString(getLang()) : '—'
const elapsed = (run: PlanRunCost, snapshot: string) => clockLabel((run.durationSec ?? Math.max(0, (Date.parse(snapshot) - Date.parse(run.startedAt)) / 1000)) * 1000)
const availability = (state?: string) => state === 'pending' ? t('review.pendingUsage') : state === 'partial' ? t('review.partial') : state === 'notApplicable' ? t('review.notApplicable') : t('review.unavailable')
const execution = (state?: string) => state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'running' ? t(`drill.execution.${state}`) : t('review.unavailable')
const trigger = (state?: string) => state === 'initial' || state === 'human_relaunch' || state === 'automatic_retry' ? t(`drill.trigger.${state}`) : t('review.triggerUnknown')
const decisionName = (state?: string) => state === 'accepted' || state === 'accept' ? t('drill.decision.accepted') : state === 'rejected' || state === 'reject' ? t('drill.decision.rejected') : state ?? t('review.noDecision')
const taskStateName = (state?: string) => state === 'in_review' ? t('panel.status.inReview') : state && ['ready', 'running', 'accepted', 'blocked', 'superseded', 'backlog'].includes(state) ? t(`panel.status.${state}`) : state ?? '—'
const metric = (value: number | undefined, state?: string, format = number) => value === undefined || state === 'pending' || state === 'unavailable' ? availability(state) : `${state === 'partial' ? `${t('review.partial')} · ` : ''}${format(value)}`
const quota = (run: PlanRunCost) => run.quotaMeasurements?.length ? run.quotaMeasurements.map((sample) => `${sample.provider} · ${sample.windowId}: ${sample.reset ? t('drill.reset') : sample.attribution !== 'shared' ? `${number(sample.afterPct - sample.beforePct)} ${t('review.pp')}` : t('review.sharedQuota')}`).join(' · ') : availability(run.pending ? 'pending' : 'unavailable')
export function quotaWindows(attempts: PlanRunCost[]) {
  const seen = new Set<string>()
  const windows = new Map<string, { amount: number; shared: boolean; reset: boolean }>()
  for (const run of attempts) for (const sample of run.quotaMeasurements ?? []) {
    if (seen.has(sample.sampleId)) continue
    seen.add(sample.sampleId)
    const key = `${sample.provider} · ${sample.accountKey} · ${sample.windowId}`
    const value = windows.get(key) ?? { amount: 0, shared: false, reset: false }
    if (sample.reset) value.reset = true
    else if (sample.attribution !== 'shared') value.amount += sample.afterPct - sample.beforePct
    else value.shared = true
    windows.set(key, value)
  }
  return [...windows].map(([window, value]) => ({ window, ...value }))
}
export function runReviewWaitMs(intervals: TaskReviewDetail['reviewIntervals'], runId: string, snapshot: string): number | undefined {
  const ranges = intervals.filter((item) => item.runId === runId && item.association !== 'task_only').map((item) => [Date.parse(item.enteredAt), Date.parse(item.decidedAt ?? snapshot)] as const).sort((a, b) => a[0] - b[0])
  if (!ranges.length) return undefined
  let amount = 0, end = 0
  for (const [from, to] of ranges) { amount += Math.max(0, to - Math.max(from, end)); end = Math.max(end, to) }
  return amount
}
const tokens = (run: PlanRunCost, key: 'input' | 'output' | 'cacheRead') => metric(run.tokens?.[key], run.availability?.[key])

export function usageRows(run: PlanRunCost, trace: Trajectory | null, mode: UsageMode) {
  const records = trace?.records ?? []
  if (mode === 'quota') return []
  if (mode === 'equivalent') return []
  return records.flatMap((record) => {
    const value = mode === 'cash' ? record.costUsd : record.tokens ? record.tokens.input + record.tokens.output : undefined
    return value === undefined ? [] : [{ id: record.index, at: record.startedAt, label: record.label, value }]
  }).sort((a, b) => a.at - b.at || a.id - b.id)
}

export function UsageOverTime({ run, trace }: { run: PlanRunCost; trace: Trajectory | null }) {
  useLang()
  const [mode, setMode] = useState<UsageMode>('cash')
  const rows = usageRows(run, trace, mode)
  const total = mode === 'cash' ? run.cashUsd?.value : mode === 'equivalent' ? run.apiEquivalentUsd?.value : mode === 'tokens' && run.tokens ? run.tokens.input + run.tokens.output : undefined
  const attributed = rows.reduce((sum, row) => sum + row.value, 0)
  const residual = total === undefined ? undefined : total - attributed
  const unreconciled = residual !== undefined && residual < -0.000001
  const format = mode === 'cash' || mode === 'equivalent' ? usd : number
  let cumulative = 0
  const origin = Date.parse(run.startedAt)
  const finish = Date.parse(run.finishedAt ?? new Date().toISOString())
  const range = Math.max(1, finish - origin)
  const max = Math.max(total ?? 0, attributed, 0.000001)
  let plotted = 0
  const points = rows.map((row) => { plotted += row.value; return `${Math.max(0, Math.min(100, (row.at - origin) / range * 100))},${29 - plotted / max * 26}` })
  return <section className="orc-drill__usage" aria-label={t('review.usageTime')}>
    <h3>{t('review.usageTime')}</h3>
    {/* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */} <div className="orc-drill__modes" role="group" aria-label={t('review.usageTime')}>{modes.map((item) => <button type="button" key={item} aria-pressed={mode === item} onClick={() => setMode(item)}>{t(`drill.mode.${item}`)}</button>)}</div>
    {mode === 'equivalent' ? <p className="orc-meta">{t('review.notCharged')}</p> : null}
    {mode === 'quota' ? <><p className="orc-meta">{t('drill.quotaSamples')}</p><p>{quota(run)}</p></> : rows.length ? <div className="orc-drill__chart">{rows.length > 1 ? <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={t('review.usageTime')}><polyline fill="none" stroke="var(--orc-ok)" strokeWidth="1.5" points={`0,29 ${points.join(' ')}`} /></svg> : null}<table><caption>{t('review.breakdown')}</caption><thead><tr><th scope="col">{t('drill.time')}</th><th scope="col">{t('drill.source')}</th><th scope="col">{t('drill.increment')}</th><th scope="col">{t('review.cumulative')}</th></tr></thead><tbody>{rows.map((row) => { cumulative += row.value; return <tr key={row.id}><td>{date(new Date(row.at).toISOString())}</td><td>{row.label}</td><td>{format(row.value)}</td><td>{format(cumulative)}</td></tr> })}</tbody></table></div> : <p className="orc-meta">{t('review.noStepUsage')}</p>}
    {mode !== 'quota' ? <dl className="orc-drill__totals"><div><dt>{t('drill.attributed')}</dt><dd>{rows.length ? format(attributed) : '—'}</dd></div><div><dt>{t('review.unattributed')}</dt><dd>{unreconciled ? t('drill.unreconciled') : residual === undefined ? availability(run.pending ? 'pending' : 'unavailable') : format(Math.max(0, residual))}</dd></div><div><dt>{t('drill.total')}</dt><dd>{total === undefined ? availability(run.pending ? 'pending' : 'unavailable') : format(total)}</dd></div></dl> : null}
  </section>
}

function useTaskReview(root: string, taskId: string) {
  const [state, setState] = useState<{ data: TaskReviewDetail | null; error: boolean }>({ data: null, error: false })
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { let live = true; let timer: ReturnType<typeof setTimeout> | undefined; setState({ data: null, error: false }); const schedule = () => { timer = setTimeout(() => { if (document.visibilityState === 'hidden') schedule(); else load() }, 5000) }; const load = () => { void api.taskReview(root, taskId).then((result) => { if (!live) return; setState((current) => result.ok ? { data: result.value, error: false } : { ...current, error: true }); if (!result.ok || result.value.attempts.some((run) => !run.finishedAt || run.pending)) schedule() }).catch(() => { if (live) { setState((current) => ({ ...current, error: true })); schedule() } }) }; load(); return () => { live = false; clearTimeout(timer) } }, [root, taskId, retry])
  return { ...state, retry: () => setRetry((n) => n + 1) }
}

function RunDetail({ repo, run, summary, task, beside, backTask, backPanel, onBack, onTask, onExpand }: { repo: RepoSnapshot; run: PlanRunCost; summary?: TaskReviewSummary; task: TaskReviewDetail | null; beside: boolean; backTask?: boolean; backPanel?: boolean; onBack(): void; onTask(): void; onExpand(): void }) {
  const [trace, setTrace] = useState<Trajectory | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { let live = true; let timer: ReturnType<typeof setTimeout> | undefined; setTrace(null); setError(false); const schedule = () => { timer = setTimeout(() => { if (document.visibilityState === 'hidden') schedule(); else load() }, 5000) }; const load = () => { void api.trace(repo.root, run.taskId, run.runId).then((result) => { if (!live) return; if (result.ok) { setTrace(result.value); setError(false); if (!run.finishedAt || run.pending) schedule() } else { setError(true); schedule() } }).catch(() => { if (live) { setError(true); schedule() } }) }; load(); return () => { live = false; clearTimeout(timer) } }, [repo.root, run.taskId, run.runId, run.finishedAt, run.pending, retry])
  const intervals = (task?.reviewIntervals ?? summary?.reviewIntervals ?? []).filter((item) => item.runId === run.runId && item.association !== 'task_only').map((item) => ({ from: Date.parse('enteredAt' in item ? item.enteredAt : item.from), to: Date.parse(('enteredAt' in item ? item.decidedAt : item.to) ?? new Date().toISOString()) })).sort((a, b) => a.from - b.from)
  let wait = intervals.length ? 0 : undefined
  let end = 0
  for (const interval of intervals) { wait! += Math.max(0, interval.to - Math.max(end, interval.from)); end = Math.max(end, interval.to) }
  const decision = task?.decisions.findLast((item) => task.reviewIntervals.some((interval) => interval.runId === run.runId && (interval.decisionId ? interval.decisionId === item.id : interval.decidedAt === item.at)))
  const heading = useRef<HTMLHeadingElement>(null)
  const [seek, setSeek] = useState<{ stepId: string; seq: number } | undefined>()
  const [copied, setCopied] = useState(false)
  // Opening a run moves focus to its title, beside the list or in place of it; Back hands it to the row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus moves once per opened run.
  useEffect(() => { heading.current?.focus({ preventScroll: beside }) }, [run.runId])
  const repoTask = repo.tasks.find((item) => item.id === run.taskId)
  const status = runStatus(run, decision?.type === 'accept' ? 'accept' : decision?.type === 'reject' ? 'reject' : '', repoTask?.status, repoTask?.lastRunId ? repoTask.lastRunId === run.runId : true)
  const strip = useMemo(() => (trace?.overviewMarks?.length ? ledgerStrip(trace.overviewMarks, { start: trace.start, end: trace.end }) : null), [trace])
  const link = `${window.location.origin}${window.location.pathname}${window.location.search}${formatRoute({ repo: repo.root, plan: repo.planId ?? '_', view: 'review', task: run.taskId, tab: 'review-run', run: run.runId })}`
  const money = run.cashUsd ? metric(run.cashUsd.value, run.availability?.cash, usd) : run.apiEquivalentUsd ? `≈ ${usd(run.apiEquivalentUsd.value)}` : run.quotaMeasurements?.length ? quota(run) : availability(run.pending ? 'pending' : 'unavailable')
  const target: TraceTarget = { taskId: run.taskId, taskTitle: run.taskTitle, run: { runId: run.runId, agent: run.agent, startedAt: run.startedAt, active: !run.finishedAt } }
  const facts: Array<[string, string]> = [
    [t('drill.worker'), run.canonicalWorkerId ?? run.agent], [t('drill.model'), run.model ?? availability()], [t('drill.attempt'), number(run.attemptIndex ?? (summary?.runIds.indexOf(run.runId) ?? -1) + 1)],
    [t('drill.start'), date(run.startedAt)], [t('drill.end'), run.finishedAt ? date(run.finishedAt) : t('review.outcome.running')], [t('drill.elapsed'), elapsed(run, new Date().toISOString())],
    [t('review.input'), tokens(run, 'input')], [t('review.output'), tokens(run, 'output')], [t('review.cacheRead'), tokens(run, 'cacheRead')], [t('review.cacheWrite'), metric(run.tokens?.cacheWrite, run.availability?.cacheWrite)], [t('drill.reasoning') + (run.reasoningIncludedInOutput ? ` (${t('drill.reasoningIncluded')})` : ''), metric(run.tokens?.reasoning, run.availability?.reasoning)],
    [t('review.cash'), metric(run.cashUsd?.value, run.availability?.cash, usd)], [t('review.quotaChange'), quota(run)], [t('review.equivalent'), metric(run.apiEquivalentUsd?.value, run.pending ? 'pending' : undefined, usd)],
    [t('review.humanWait'), wait === undefined ? availability() : clockLabel(wait)], [t('review.execution'), execution(run.executionOutcome ?? run.outcome ?? (run.finishedAt ? undefined : 'running'))],
    [t('review.decision'), decision ? `${decisionName(decision.type)}${decision.verdict ? ` · ${decision.verdict.kind}` : ''}${decision.check ? ` · ${t(`review.check.${decision.check}`)}` : ''}` : t('review.noDecision')], [t('drill.reason'), decision ? noteText(decision) : availability()], [t('drill.availability'), run.pending ? t('review.pendingUsage') : Object.values(run.availability ?? {}).includes('partial') ? t('review.partial') : run.tokens || run.cashUsd || run.quotaMeasurements?.length ? t('drill.recorded') : t('review.unavailable')],
  ]
  return <section className={`orc-drill ${beside ? 'orc-drill--beside' : 'orc-drill--main'}`} aria-label={t('review.runDetail')}>
    <header className="orc-drill__head"><button type="button" onClick={onBack}>← {t(backTask ? 'review.backTask' : backPanel ? 'review.backPanel' : beside ? 'review.close' : 'review.back')}</button><button type="button" onClick={onTask}>{t('review.taskHistory')} →</button>{beside ? <button type="button" onClick={onExpand}>{t('review.expand')}</button> : null}<button type="button" onClick={() => { void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? t('review.linkCopied') : t('review.copyLink')}</button>{repoTask ? <CopyForAgent compact text={taskHandoff(repo, repoTask)} /> : null}</header>
    <p className="orc-eyebrow">{t('review.runDetail')} · {run.taskId} · {t('review.attempt', { n: run.attemptIndex ?? 1 })}</p>
    <h2 tabIndex={-1} ref={heading}>{run.taskTitle}</h2><p className="orc-drill__sub"><StatusWord status={status} cancelled={(run.executionOutcome ?? run.outcome) === 'cancelled'} /> · <code>{run.runId}</code></p>
    <dl className="orc-drill__key"><div><dt>{t('drill.elapsed')}</dt><dd>{elapsed(run, new Date().toISOString())}</dd></div><div><dt>{t('drill.worker')}</dt><dd>{run.canonicalWorkerId ?? run.agent}</dd></div><div><dt>{t('review.time.wait')}</dt><dd>{wait === undefined ? availability() : clockLabel(wait)}</dd></div><div><dt>{t('review.runMoney')}</dt><dd>{money}</dd></div></dl>
    {trace ? <DetailStrip cells={strip?.cells ?? []} timing={strip?.timing ?? 'elapsed'} onStep={(stepId) => setSeek((old) => ({ stepId, seq: (old?.seq ?? 0) + 1 }))} /> : null}
    <section className="orc-drill__ledger"><h3>{t('review.ledger')}</h3>{trace ? <LedgerView key={run.runId} trace={trace} repo={repo} target={target} actions={() => null} seek={seek} /> : error ? <p role="alert">{t('review.stepsMissing')} <button type="button" onClick={() => setRetry((n) => n + 1)}>{t('review.retry')}</button></p> : <p>{t('review.loading')}</p>}</section>
    <details className="orc-drill__more"><summary>{t('review.allFacts')}</summary><dl className="orc-drill__facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="orc-drill__estimate">{t('review.notCharged')}</p>
    <UsageOverTime run={run} trace={trace} /></details>
  </section>
}

export function TaskHistory({ repo, summary, data, backRun, onBack, onRun }: { repo: RepoSnapshot; summary?: TaskReviewSummary; data: TaskReviewDetail; backRun?: boolean; onBack(): void; onRun(id: string): void }) {
  useLang()
  const attempts = useMemo(() => [...data.attempts].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId)), [data])
  const pageKey = `${repo.root}:${repo.planId ?? ''}:${data.taskId}`
  const [page, setPageState] = useState(() => taskPageByKey.get(pageKey) ?? 0)
  const setPage = (value: number) => { taskPageByKey.set(pageKey, value); setPageState(value) }
  const [usageMode, setUsageMode] = useState<UsageMode>('cash')
  const count = typeof window !== 'undefined' && window.innerWidth <= 1100 ? 2 : 3
  const from = Math.min(page, Math.max(0, attempts.length - count))
  const shown = attempts.slice(from, from + count)
  const cumulative = (index: number) => { const prior = attempts.slice(0, index + 1); return `${t('review.cash')}: ${prior.some((r) => r.cashUsd) ? usd(prior.reduce((s, r) => s + (r.cashUsd?.value ?? 0), 0)) : '—'} · ${t('review.equivalent')}: ${prior.some((r) => r.apiEquivalentUsd) ? usd(prior.reduce((s, r) => s + (r.apiEquivalentUsd?.value ?? 0), 0)) : '—'} · ${t('review.quotaChange')}: ${quotaWindows(prior).map((item) => `${item.window} ${number(item.amount)} ${t('review.pp')}`).join('; ') || '—'} · ${t('review.workerSum')}: ${clockLabel(prior.reduce((s, r) => s + (r.durationSec ?? 0), 0) * 1000)}` }
  const row = (label: string, render: (run: PlanRunCost, index: number) => string | ReactNode) => <tr key={label}><th scope="row">{label}</th>{shown.map((run, i) => <td key={run.runId}>{render(run, from + i)}</td>)}</tr>
  const repoTask = repo.tasks.find((item) => item.id === data.taskId)
  return <section className="orc-drill orc-drill--main" aria-label={t('review.taskHistory')}><header className="orc-drill__head"><button type="button" onClick={onBack}>← {t(backRun ? 'review.backRun' : 'review.back')}</button>{repoTask ? <CopyForAgent compact text={taskHandoff(repo, repoTask)} /> : null}</header><h2>{t('review.taskHistory')} · {data.taskId} · {summary?.title ?? repoTask?.title}</h2>{data.synthetic ? <p className="orc-synthetic" role="note">{t('welcome.syntheticData')}</p> : null}
    <dl className="orc-drill__facts"><div><dt>{t('drill.state')}</dt><dd>{taskStateName(summary?.state)}</dd></div><div><dt>{t('drill.elapsed')}</dt><dd>{summary?.elapsedSec === undefined ? '—' : clockLabel(summary.elapsedSec * 1000)}</dd></div><div><dt>{t('review.workerSum')}</dt><dd>{summary ? clockLabel(summary.workerSec * 1000) : '—'}</dd></div><div><dt>{t('review.humanWait')}</dt><dd>{summary ? clockLabel(summary.reviewWaitMs) : '—'}</dd></div><div><dt>{t('review.cash')}</dt><dd>{!summary?.accounting.knownRuns ? availability(summary?.accounting.pendingRuns ? 'pending' : summary?.accounting.cashEligibleRuns === 0 ? 'notApplicable' : 'unavailable') : `${summary.accounting.knownRuns < (summary.accounting.cashEligibleRuns ?? attempts.length) ? `${t('review.partial')} · ` : ''}${usd(summary.accounting.cashUsd ?? 0)}`}</dd></div><div><dt>{t('review.equivalent')}</dt><dd>{summary?.accounting.apiEquivalentUsd === undefined ? '—' : usd(summary.accounting.apiEquivalentUsd)} <small>{t('review.notCharged')}</small></dd></div><div><dt>{t('review.quotaChange')}</dt><dd>{quotaWindows(attempts).length ? quotaWindows(attempts).map((item) => `${item.window}: ${number(item.amount)} ${t('review.pp')}${item.shared ? ` · ${t('review.sharedQuota')}` : ''}${item.reset ? ` · ${t('drill.reset')}` : ''}`).join('; ') : '—'}</dd></div></dl>
    <h3>{t('review.allAttempts')} · {attempts.length}</h3>{attempts.length ? <><div className="orc-drill__paging" aria-live="polite"><button type="button" disabled={from === 0} onClick={() => setPage(Math.max(0, from - count))}>{t('review.previous')}</button><span>{t('drill.attemptRange', { from: from + 1, to: from + shown.length, total: attempts.length })}</span><button type="button" disabled={from + count >= attempts.length} onClick={() => setPage(from + count)}>{t('review.next')}</button></div><div className="orc-drill__comparison"><table><caption>{t('review.taskHistory')}</caption><thead><tr><th scope="col">{t('drill.metric')}</th>{shown.map((run, i) => <th scope="col" key={run.runId}>{t('review.attempt', { n: run.attemptIndex ?? from + i + 1 })}</th>)}</tr></thead><tbody>
      {row(t('drill.trigger'), (run) => trigger(run.attemptTrigger))}{row(t('drill.worker'), (run) => `${run.canonicalWorkerId ?? run.agent}${run.model ? ` · ${run.model}` : ''}`)}{row(t('review.execution'), (run) => execution(run.executionOutcome ?? run.outcome))}{row(t('review.decision'), (run) => decisionName(data.reviewIntervals.find((item) => item.runId === run.runId)?.decision))}{row(t('drill.reason'), (run) => data.reviewIntervals.find((item) => item.runId === run.runId)?.reason ?? '—')}{row(t('drill.start'), (run) => date(run.startedAt))}{row(t('drill.end'), (run) => date(run.finishedAt))}{row(t('drill.elapsed'), (run) => elapsed(run, data.generatedAt))}{row(t('review.humanWait'), (run) => { const wait = runReviewWaitMs(data.reviewIntervals, run.runId, data.generatedAt); return wait === undefined ? '—' : clockLabel(wait) })}{row(t('review.input'), (run) => tokens(run, 'input'))}{row(t('review.output'), (run) => tokens(run, 'output'))}{row(t('review.cacheRead'), (run) => tokens(run, 'cacheRead'))}{row(t('review.cash'), (run) => metric(run.cashUsd?.value, run.availability?.cash, usd))}{row(t('review.quotaChange'), quota)}{row(t('review.equivalent'), (run) => metric(run.apiEquivalentUsd?.value, run.pending ? 'pending' : undefined, usd))}{row(t('review.cumulative'), (_run, index) => cumulative(index))}{row(t('review.openRun'), (run) => <button type="button" onClick={() => onRun(run.runId)}>{t('review.openRun')} →</button>)}
    </tbody></table></div></> : <p>{t('review.noRuns')}</p>}
    <h3>{t('drill.decisionHistory')}</h3>{data.decisions.length ? <ol>{data.decisions.map((item, i) => <li key={i}>{date(item.at)} · {decisionName(item.type)}{item.verdict ? ` · ${item.verdict.kind}` : ''}{item.check ? ` · ${t(`review.check.${item.check}`)}` : ''}{noteText(item) ? ` · ${noteText(item)}` : ''}{item.text && repoTask ? <> <CopyForAgent compact text={findingHandoff(repo, repoTask, noteText(item))} /></> : null}</li>)}</ol> : <p>{t('review.noDecision')}</p>}
    <h3>{t('review.usageTime')}</h3>{/* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */} <div className="orc-drill__modes" role="group" aria-label={t('review.usageTime')}>{modes.map((item) => <button type="button" key={item} aria-pressed={usageMode === item} onClick={() => setUsageMode(item)}>{t(`drill.mode.${item}`)}</button>)}</div><p className="orc-meta">{t('review.noStepUsage')}{usageMode === 'equivalent' ? ` · ${t('review.notCharged')}` : ''}</p><table><caption>{t('review.usageTime')} · {t(`drill.mode.${usageMode}`)}</caption><thead><tr><th scope="col">{t('drill.attempt')}</th><th scope="col">{t('drill.start')}</th><th scope="col">{t('drill.end')}</th><th scope="col">{t(`drill.mode.${usageMode}`)}</th></tr></thead><tbody>{attempts.map((run, i) => <tr key={run.runId}><th scope="row">{i + 1}</th><td>{date(run.startedAt)}</td><td>{date(run.finishedAt)}</td><td>{usageMode === 'cash' ? metric(run.cashUsd?.value, run.availability?.cash, usd) : usageMode === 'equivalent' ? metric(run.apiEquivalentUsd?.value, run.pending ? 'pending' : undefined, usd) : usageMode === 'tokens' ? run.tokens ? number(run.tokens.input + run.tokens.output) : availability(run.pending ? 'pending' : 'unavailable') : quota(run)}</td></tr>)}</tbody></table>
  </section>
}

export function ReviewDrilldown({ repo, detail, summary, run, beside = false, backTask, backRun, backPanel, onBack, onTask, onRun, onExpand }: { repo: RepoSnapshot; detail: ReviewDetail; summary?: TaskReviewSummary; run?: PlanRunCost; beside?: boolean; backTask?: boolean; backRun?: boolean; backPanel?: boolean; onBack(): void; onTask(): void; onRun(id: string): void; onExpand(): void }) {
  useLang()
  const task = useTaskReview(repo.root, detail.taskId)
  if (detail.kind === 'task') return task.data ? <TaskHistory repo={repo} summary={task.data.summary ?? summary} data={task.data} backRun={backRun} onBack={onBack} onRun={onRun} /> : <section className="orc-drill"><button type="button" onClick={onBack}>← {t(backRun ? 'review.backRun' : 'review.back')}</button><p role={task.error ? 'alert' : 'status'}>{task.error ? t('review.unavailable') : t('review.loading')}</p>{task.error ? <button type="button" onClick={task.retry}>{t('review.retry')}</button> : null}</section>
  const chosen = task.data?.attempts.find((item) => item.runId === detail.runId) ?? run
  return chosen ? <RunDetail repo={repo} run={chosen} summary={task.data?.summary ?? summary} task={task.data} beside={beside} backTask={backTask} backPanel={backPanel} onBack={onBack} onTask={onTask} onExpand={onExpand} /> : <p role="alert">{t('review.unavailable')}</p>
}
