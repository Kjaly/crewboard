import { useEffect, useState } from 'react'
import type { Attention, OrchestraRepoSnapshot, TaskDetail, TaskSnapshot, VerdictFact, WorkerInfo } from '../../shared/types.js'
import { useAction } from '../actions.js'
import { api } from '../api.js'
import { CopyForAgent } from '../copy-agent.js'
import { taskHandoff } from '../handoff.js'
import { identityLabel, taskIdentity, workerIdentity } from '../provider.js'
import { CLASS_LABEL, classOfTask } from '../routing.js'
import { orchestraStore, type Density } from '../store.js'
import { taskTone } from '../styles.js'
import { isChecking, isOwnWork } from '../../../../core/src/plan/graph.js'
import { nowPhrase, sinceLabel } from '../summary.js'
import { workerName } from '../preset-picker.js'
import { isHandPicked, workerChoiceOf, workerOptions } from '../workers.js'
import { ReportCard } from './report.js'
import { ChangesTab, ContractTab, FeedTab, LinksTab, NotesTab, OlderRunActivity, resolveTab, type TabKey } from './tabs.js'
import type { TraceTarget } from './trace.js'
import { RunTracePanel } from './run-trace-panel.js'
import { VendorMark } from '../vendor-mark.js'
import { DecisionBrief } from './decision-brief.js'
import type { GcCandidate, SteerResult } from '@crewboard/core'
import { t, useLang } from '../i18n.js'

/** Automatic worker selection delegates routing to the host; on an assigned task it also clears the assignment. */
const AUTO = 'auto'
/** Run the task's assigned worker as it is (the host applies the launch rule). */
const KEEP = 'keep'

/** Keep both ends of a path visible; title and copy retain the exact value. */
export const shortPath = (p: string): string => {
  if (p.length <= 34) return p
  return `${p.slice(0, 8)}…${p.slice(-14)}`
}

export const dependencyChips = (deps: string[]) => ({ shown: deps.slice(0, 2), remaining: Math.max(0, deps.length - 2) })

type Launch = { agent: string; at: string; worktree?: { path: string; branch: string } }

type Primary = 'run' | 'continue' | 'steer' | 'accept' | 'decision' | 'blocked' | 'orchestrator' | 'merge' | 'none'

/**
 * One main button per context. `orchestrator` (rt1): the orchestrator's move and no button for the person —
 * a root task it has to start or is working on, a decision it still prepares. `merge` (w1d): accepted work not in the
 * base branch yet — the person merges it; the panel gives the exact commands, Crewboard does not merge by itself.
 */
export function primaryAction(task: TaskSnapshot): Primary {
  if (task.unmerged) return 'merge'
  if (task.status === 'accepted' || task.status === 'closed' || task.status === 'superseded' || task.status === 'dropped') return 'none'
  if (task.status === 'blocked') return 'blocked'
  if (task.byOrchestrator || task.preparing || (task.kind === 'root' && task.status === 'ready')) return 'orchestrator'
  if (task.status === 'running') return 'steer'
  if (task.status === 'in_review') return 'accept'
  if (task.needsHuman) return 'decision'
  // The last run ended without handing its work in (bg1): finishing it is the move, not a fresh start.
  if (task.lastOutcome === 'incomplete') return 'continue'
  return 'run'
}

/**
 * The orchestrator's check above Accept / Send back (vr1): a calm mark while it checks, its note once checked.
 */
export function CheckMark({ task }: { task: TaskSnapshot }) {
  // A prepared decision (rt1) carries the orchestrator's note — the options and its recommendation — too.
  const prepared = task.kind === 'decision' && task.check === 'checked'
  if ((task.status !== 'in_review' && !prepared) || !task.check) return null
  if (isChecking(task.check)) return <p className="orc-vcheck" role="status"><span aria-hidden="true">◌ </span>{t(task.check === 'checking' ? 'check.checking' : 'check.pending')}</p>
  return <div className="orc-vcheck" role="note"><p className="orc-vcheck__head"><span aria-hidden="true">✓ </span>{t(prepared ? 'check.prepared' : 'check.checked')}</p>{task.checkNote ? <p className="orc-vcheck__note">{task.checkNote}</p> : null}</div>
}

/** What the orchestrator is doing while the move is its own (rt1): said instead of a button. */
const orchestratorMove = (task: TaskSnapshot): string =>
  t(task.preparing ? 'panel.task.preparingHelp' : task.byOrchestrator ? 'panel.task.byOrchestratorHelp' : 'panel.task.rootReadyHelp', { id: task.id })

/**
 * One fact of the verdict. A fact that points at a line of the report is a link and nothing else:
 * drawing the label *and* the link printed the same words twice, one on top of the other.
 */
function VerdictFactChip({ fact, onJump }: { fact: VerdictFact; onJump(line: number): void }) {
  const label =
    fact.code === 'tests' ? (fact.text ?? t('verdict.checksInReport'))
    : fact.code === 'files_changed' ? t('verdict.fact.files_changed', { count: fact.count ?? 0 })
    : fact.code === 'checks_run' || fact.code === 'checks_unreported' || fact.code === 'checks_unreadable' || fact.code === 'uncommitted' ? t(`verdict.fact.${fact.code}`, { count: fact.count ?? 0 })
    : fact.code === 'duration' ? t('verdict.fact.duration', { time: t('panel.duration.minutes', { count: fact.minutes ?? 0 }) })
    : t(`verdict.fact.${fact.code}`)
  const className = `orc-verdict__fact orc-verdict__fact--${fact.tone}`
  if (fact.sourceLine === undefined) return <span className={className}>{label}</span>
  return (
    <button type="button" className={`${className} orc-verdict__fact--link`} onClick={() => onJump(fact.sourceLine!)}>
      {label} <span aria-hidden="true">↗</span>
    </button>
  )
}

export function TaskPanel({
  repo,
  workers,
  task,
  attention,
  onSelect,
  onTrace,
  steerDraft,
  tabRequest,
  runTraceRequest,
  onTabChange,
}: {
  repo: OrchestraRepoSnapshot
  workers?: readonly WorkerInfo[]
  task: TaskSnapshot
  attention: Attention[]
  onSelect(id: string | null): void
  density: Density
  onTrace?(target: TraceTarget): void
  /** A correction started in the trace. `seq` makes a repeat click land again. */
  steerDraft?: { taskId: string; text: string; seq: number }
  /** The queue can request a tab; `seq` lets the same request land twice. */
  tabRequest?: { tab: string; seq: number }
  runTraceRequest?: { target: TraceTarget; seq: number }
  onTabChange?(tab: TabKey): void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [tab, setTab] = useState<TabKey>('overview')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [panelTrace, setPanelTrace] = useState<TraceTarget | null>(null)
  const [form, setForm] = useState<'none' | 'steer' | 'reject' | 'unchecked'>('none')
  const [message, setMessage] = useState('')
  const [steerOutcome, setSteerOutcome] = useState<SteerResult | null>(null)
  const [reason, setReason] = useState('')
  const assigned = task.workerSource ? task.worker : undefined
  const [worker, setWorker] = useState(assigned ? KEEP : AUTO)
  const [launched, setLaunched] = useState<Launch | null>(null)
  const [copied, setCopied] = useState(false)
  const [branchCopied, setBranchCopied] = useState(false)
  const [mergeCopied, setMergeCopied] = useState(false)
  const [candidate, setCandidate] = useState<GcCandidate | null>(null)
  const [copiesLoaded, setCopiesLoaded] = useState(false)
  const [copyRemoved, setCopyRemoved] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [removingCopy, setRemovingCopy] = useState(false)
  const [reportJump, setReportJump] = useState<{ line: number; seq: number } | null>(null)
  useLang()
  const action = useAction()
  const tone = taskTone(task)
  const checking = task.status === 'in_review' && isChecking(task.check)
  const identity = taskIdentity(task, workers, launched?.agent)
  const phrase = nowPhrase(task, attention)
  const primary = repo.example ? 'none' : primaryAction(task)
  const taskClass = classOfTask(task)
  const isDecision = task.kind === 'decision'
  // Detail is refetched on selection and whenever the snapshot moved this task forward.
  const freshness = `${task.status}:${task.runs}:${task.lastRunId ?? ''}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    setForm('none')
    setMessage('')
    setSteerOutcome(null)
    setReason('')
    setWorker(task.workerSource && task.worker ? KEEP : AUTO)
    setLaunched(null)
    setCopied(false)
    setBranchCopied(false)
    setMergeCopied(false)
    setSelectedRunId(null)
    setTab('overview')
    setCandidate(null)
    setCopiesLoaded(false)
    setCopyRemoved(false)
    setCopyError('')
    setReportJump(null)
    setPanelTrace(null)
  }, [task.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let alive = true
    setCopiesLoaded(false)
    void api.worktrees(repo.root).then((r) => {
      if (!alive) return
      if (r.ok) { setCandidate(r.value.candidates.find((c) => c.taskId === task.id) ?? null); setCopiesLoaded(true) }
    }).catch(() => {})
    return () => { alive = false }
  }, [repo.root, task.id, freshness])

  // A correction started in the trace opens the same field here, already written up to the colon.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (!steerDraft || steerDraft.taskId !== task.id) return
    setForm('steer')
    setMessage(steerDraft.text)
    setSteerOutcome(null)
  }, [steerDraft?.seq, steerDraft?.taskId, task.id])

  // An outside request opens the named tab once per request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (tabRequest) setTab(resolveTab(tabRequest.tab))
  }, [tabRequest?.seq, tabRequest?.tab])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (runTraceRequest?.target.taskId !== task.id) return
    setPanelTrace(runTraceRequest.target)
    setTab('activity')
  }, [runTraceRequest?.seq, task.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    let alive = true
    const refresh = () => { void api
      .task(repo.root, task.id)
      .then((r) => {
        if (alive) setDetail(r.ok ? r.value : null)
      })
      .catch(() => {}) }
    refresh()
    const timer = task.status === 'running' ? setInterval(refresh, 2000) : undefined
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [repo.root, task.id, freshness])

  const after = async (ok: boolean) => {
    if (!ok) return
    setForm('none')
    setMessage('')
    setReason('')
  }
  const accept = () => void action.call(async () => {
    const result = await api.accept(repo.root, task.id)
    if (result.ok && result.value.worktreeRemoved) setCopyRemoved(true)
    return result
  }).then(after)

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: t('panel.task.tab.overview') },
    { key: 'activity', label: t('panel.task.tab.activity') },
    { key: 'changes', label: detail?.changedFiles.length ? t('panel.task.tab.changesCount', { count: detail.changedFiles.length }) : t('panel.task.tab.changes') },
    { key: 'contract', label: t('panel.task.tab.contract') },
  ]

  // Run details remain visible while the run is live.
  const showRun = task.status === 'running' || (launched !== null && !task.lastOutcome && task.status === 'ready')
  const runWorktree = detail?.worktree ?? launched?.worktree ?? candidate ?? undefined
  const copyExists = candidate !== null && !copyRemoved
  const showRemoved = copyRemoved || (task.status === 'accepted' && copiesLoaded && !candidate && !!runWorktree)
  const removeCopy = async () => {
    if (!candidate || candidate.keep || removingCopy) return
    setRemovingCopy(true)
    setCopyError('')
    try {
      const r = await api.worktreeGc(repo.root, [task.id])
      if (!r.ok) setCopyError(t('panel.task.copyRemoveFailed'))
      else if (r.value.removed.includes(task.id)) { setCopyRemoved(true); setCandidate(null) }
      else setCopyError(r.value.failed.find((f) => f.taskId === task.id)?.reason ?? t('panel.task.copyRemains'))
    } catch { setCopyError(t('panel.task.serverUnavailable')) }
    finally { setRemovingCopy(false) }
  }
  const runSince = sinceLabel(task.activeSince ?? launched?.at)
  const copyPath = () => {
    try {
      void navigator.clipboard
        ?.writeText(runWorktree?.path ?? '')
        .then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
        .catch(() => {})
    } catch {
      /* clipboard may be unavailable; the title still shows the path */
    }
  }
  const copyBranch = () => {
    void navigator.clipboard?.writeText(runWorktree?.branch ?? '').then(() => {
      setBranchCopied(true)
      setTimeout(() => setBranchCopied(false), 1600)
    }).catch(() => {})
  }
  const copyMerge = () => {
    void navigator.clipboard?.writeText(detail?.merge?.commands.join('\n') ?? '').then(() => {
      setMergeCopied(true)
      setTimeout(() => setMergeCopied(false), 1600)
    }).catch(() => {})
  }
  const deps = dependencyChips(task.deps)
  const selectedRun = detail?.runs.find((run) => run.runId === selectedRunId) ?? detail?.runs.at(-1)

  return (
    <aside className="orc-panel" aria-label={t('panel.task.aria', { title: task.title })}>
      <div className="orc-panel__fixed">
        <div className="orc-sec orc-sec--head">
          <h2 className="orc-h">{task.title}</h2>
          <CopyForAgent text={taskHandoff(repo, task)} />
          <button type="button" className="orc-run__link" onClick={() => { void navigator.clipboard?.writeText(orchestraStore.taskLink(task.id)).catch(() => {}) }}>{t('panel.task.copyLink')}</button>
          {/* A decision is the person's own choice (w1b, B05): no worker, no model, no task class to show. */}
          <div className="orc-panel__identity">{isDecision ? <span>{tone.label}</span> : <><VendorMark identity={identity} /><span className="orc-panel__identity-name">{identityLabel(identity)}</span><span>{`· ${tone.label}`}</span></>}{showRun && runSince ? <span>{`· ${runSince}`}</span> : null}</div>
          {isDecision ? null : task.kind === 'root' ? <p className="orc-meta orc-panel__choice">{t('panel.task.rootOwner')}</p> : <p className="orc-meta orc-panel__choice">{t('panel.task.workerChoice', { worker: task.worker ? identityLabel(identity) : repo.effectiveRouting?.routing[taskClass][0] ? workerName(repo.effectiveRouting.routing[taskClass][0], workers ?? []) : '—', who: t(`panel.task.chosenBy.${workerChoiceOf(task)}`) })}{isHandPicked(task) ? <span className="orc-panel__hand" title={t('graph.handPickedTitle')}>⚑ {t('graph.handPicked')}</span> : null}</p>}
          <div className="orc-panel__chips">
            {task.lane ? <span className="orc-panel__chip" title={task.lane}>{task.lane}</span> : null}
            {isDecision ? null : <span className="orc-panel__chip">{CLASS_LABEL[taskClass]}</span>}
            {deps.shown.map((id) => <span key={id} className="orc-panel__chip" title={id}>{id}</span>)}
            {deps.remaining ? <span className="orc-panel__chip" title={task.deps.join(', ')}>+{deps.remaining}</span> : null}
          </div>
          {runWorktree ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-panel__worktree" role="group" aria-label={t('panel.task.run')}>
            <code title={runWorktree.path}>{shortPath(runWorktree.path)}</code><button type="button" aria-label={t('panel.task.copyPath')} title={runWorktree.path} onClick={copyPath}>{copied ? '✓' : '⧉'}</button>
            <code title={runWorktree.branch}>{shortPath(runWorktree.branch)}</code><button type="button" aria-label={t('panel.task.copyBranch')} title={runWorktree.branch} onClick={copyBranch}>{branchCopied ? '✓' : '⧉'}</button>
            {detail?.worktree?.baseline ? <span className={`orc-panel__baseline${detail.worktree.baseline.ok ? '' : ' orc-panel__baseline--red'}`} title={detail.worktree.baseline.command}>{t(detail.worktree.baseline.ok ? 'panel.task.baselineGreen' : 'panel.task.baselineRed', { commit: detail.worktree.baseline.commit.slice(0, 7), at: new Date(detail.worktree.baseline.at).toLocaleString() })}</span> : null}
          </div> : null}
        </div>

        <div className="orc-sec orc-sec--actions">
          {primary === 'accept' || primary === 'decision' ? <CheckMark task={task} /> : null}
          <div className="orc-actions">
            {primary === 'run' ? (
              <>
                <button type="button" className="orc-btn" disabled={action.pending} onClick={() => action.call(async () => {
                  // «Auto» on an assigned task clears the assignment; KEEP leaves the choice to the launch rule.
                  const r = await api.run(repo.root, task.id, worker === KEEP ? undefined : worker === AUTO ? (assigned ? AUTO : undefined) : worker)
                  if (r.ok) setLaunched({ agent: r.value.agent ?? worker, at: new Date().toISOString(), ...(r.value.worktree ? { worktree: r.value.worktree } : {}) })
                  return r
                })}>{t('panel.task.start')}</button>
                <select className="orc-select" aria-label={t('panel.task.worker')} value={worker} onChange={(e) => setWorker(e.target.value)}>
                  {assigned ? <option value={KEEP}>{t('panel.task.keepAssigned', { worker: identityLabel(workerIdentity(assigned, workers)) })}</option> : null}
                  <option value={AUTO}>{t('panel.task.auto')}</option>
                  {workerOptions(task.worker ?? 'dsh', workers).map((w) => <option key={w} value={w}>{identityLabel(workerIdentity(w, workers))}</option>)}
                </select>
              </>
            ) : null}
            {primary === 'continue' ? <button type="button" className="orc-btn" disabled={action.pending} onClick={() => void action.call(() => api.continueRun(repo.root, task.id))}>{t('panel.task.continue')}</button> : null}
            {primary === 'steer' ? <><button type="button" className="orc-btn" onClick={() => setForm(form === 'steer' ? 'none' : 'steer')} aria-expanded={form === 'steer'}>{t('panel.task.steer')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => action.call(() => api.stop(repo.root, task.id))}>{t('panel.task.stop')}</button></> : null}
            {primary === 'accept' || primary === 'decision' ? <><button type="button" className="orc-btn" disabled={action.pending} aria-expanded={checking ? form === 'unchecked' : undefined} onClick={() => checking ? setForm(form === 'unchecked' ? 'none' : 'unchecked') : accept()}>{primary === 'accept' ? t('panel.task.accept') : t('panel.task.acceptDecision')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm(form === 'reject' ? 'none' : 'reject')} aria-expanded={form === 'reject'}>{t('panel.task.sendBackMore')}</button></> : null}
            {primary === 'orchestrator' ? <span className="orc-meta">{orchestratorMove(task)}</span> : null}
            {primary === 'blocked' ? <button type="button" className="orc-btn" onClick={() => onSelect(task.blockedBy[0] ?? null)} disabled={task.blockedBy.length === 0}>{t('panel.task.blocker')}</button> : null}
            {primary === 'merge' ? <span className="orc-meta">{t('panel.task.mergeLead', { into: detail?.merge?.into ?? t('panel.task.mergeBase') })}</span> : null}
            {primary === 'none' ? <span className="orc-meta">{repo.example ? t('welcome.exampleReadOnly') : task.status === 'accepted' && task.kind !== 'decision' && task.kind !== 'root' ? t('panel.task.merged') : t('panel.task.noAction')}</span> : null}
          </div>
          {primary === 'run' ? <div className="orc-hint orc-run-route">
            <p>{worker === KEEP && assigned ? (task.workerSource === 'agent' && task.outsidePreset ? t('panel.task.staleAssigned', { worker: workerName(assigned, workers ?? []) }) : t('panel.task.assignedHint', { worker: workerName(assigned, workers ?? []), who: t(`panel.task.chosenBy.${workerChoiceOf(task)}`) })) : worker !== AUTO ? t('settings.runManual', { worker: workerName(worker, workers ?? []) }) : repo.effectiveRouting ? t('settings.runSource', {
              worker: repo.effectiveRouting.routing[taskClass][0] ? workerName(repo.effectiveRouting.routing[taskClass][0], workers ?? []) : t('settings.noWorker'),
              source: t(`settings.source.${repo.effectiveRouting.source}`),
              preset: repo.effectiveRouting.preset.builtin ? t('settings.allWorkers') : repo.effectiveRouting.preset.label,
            }) : t('panel.task.autoHint', { class: CLASS_LABEL[taskClass] })}</p>
            {repo.effectiveRouting?.dropped.some((item) => item.reason === 'disabled') ? <p>{t('settings.disabledLine', { workers: repo.effectiveRouting.dropped.filter((item) => item.reason === 'disabled').map((item) => `${workerName(item.id, workers ?? [])}${repo.effectiveRouting?.disabled[item.id] ? ` (${repo.effectiveRouting.disabled[item.id]})` : ''}`).join(', ') })}</p> : null}
          </div> : null}
          {primary === 'continue' ? <div className="orc-hint" role="status"><p>{t(task.incomplete?.reason === 'no_claim' ? 'panel.task.incompleteNoClaim' : 'panel.task.incompleteNoReport', { count: task.incomplete?.uncommitted ?? 0 })}</p><p>{t('panel.task.continueHint')}</p></div> : null}
          {task.kind === 'decision' ? <div className="orc-decision__action-help"><h3 className="orc-decision__heading">{t('panel.task.decisionHelpTitle')}</h3><p>{t('panel.task.decisionAcceptHelp')}</p><p>{t('panel.task.decisionReturnHelp')}</p></div> : null}
          {primary === 'accept' ? <p className="orc-hint">{t('panel.task.confirmHint')}</p> : null}
          {primary === 'merge' ? <div className="orc-hint" role="status">
            <p>{t('panel.task.mergeHint')}</p>
            {detail?.merge ? <><pre className="orc-merge__commands">{detail.merge.commands.join('\n')}</pre><button type="button" className="orc-run__link" onClick={copyMerge}>{mergeCopied ? t('panel.task.mergeCopied') : t('panel.task.mergeCopy')}</button></> : null}
          </div> : null}
          {form === 'unchecked' && checking ? <div className="orc-form" role="alertdialog" aria-label={t('check.acceptEarly')}><p>{t('check.acceptEarly')}</p><div className="orc-actions"><button type="button" className="orc-btn" disabled={action.pending} onClick={accept}>{t('check.acceptAnyway')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm('none')}>{t('panel.task.cancel')}</button></div></div> : null}
          {form === 'steer' ? <div className="orc-form">
            {/* biome-ignore lint/a11y/noAutofocus: Focus moves to this field when its dialog opens. */} <textarea autoFocus className="orc-field" aria-label={t('panel.task.steerLabel')} placeholder={t('panel.task.steerPlaceholder')} value={message} onChange={(e) => { setMessage(e.target.value); setSteerOutcome(null) }} />
            <div className="orc-actions">
              <button type="button" className="orc-btn" disabled={action.pending || !message.trim() || steerOutcome?.delivery === 'delivered'} onClick={() => void action.call(async () => {
                const result = await api.steer(repo.root, task.id, message.trim())
                if (result.ok) setSteerOutcome(result.value as SteerResult)
                return result
              })}>{t('panel.task.send')}</button>
              <button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm('none')}>{t('panel.task.cancel')}</button>
            </div>
            {steerOutcome?.delivery === 'delivered' ? <p role="status" className="orc-hint">{steerOutcome.steerId} · {t(`panel.task.steerState.${steerOutcome.state}`)}</p> : null}
            {steerOutcome?.delivery === 'failed' ? <p role="alert" className="orc-error">{t('panel.task.steerFailed', { reason: steerOutcome.reason ?? '' })}</p> : null}
            {steerOutcome?.delivery === 'abandoned' ? <div role="status"><p className="orc-hint">{steerOutcome.steerId} · {t(`panel.task.steerReason.${steerOutcome.reason}`)}</p><button type="button" className="orc-btn" disabled={action.pending} onClick={() => void action.call(() => api.relaunch(repo.root, task.id, { note: message })).then(after)}>{t('panel.task.relaunchWithCorrection')}</button></div> : null}
            {steerOutcome?.delivery === 'refused' ? <div role="status"><p className="orc-hint">{t('panel.task.steerRefused', { state: steerOutcome.runState })}</p><button type="button" className="orc-btn" disabled={action.pending} onClick={() => void action.call(() => api.relaunch(repo.root, task.id, { note: message })).then(after)}>{t('panel.task.relaunchWithCorrection')}</button></div> : null}
          </div> : null}
          {form === 'reject' ? <div className="orc-form"><textarea className="orc-field" aria-label={t('panel.task.reasonLabel')} placeholder={task.kind === 'decision' ? t('panel.task.decisionReasonPlaceholder') : t('panel.task.reasonPlaceholder')} value={reason} onChange={(e) => setReason(e.target.value)} /><div className="orc-actions"><button type="button" className="orc-btn" disabled={action.pending || !reason.trim()} onClick={() => action.call(() => api.reject(repo.root, task.id, reason.trim())).then(after)}>{t('panel.task.sendBack')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm('none')}>{t('panel.task.cancel')}</button></div><p className="orc-hint">{t('panel.task.confirmHint')}</p></div> : null}
          {action.error ? <p className="orc-error">{action.error}</p> : null}
        </div>
      </div>
      <div className="orc-panel__scroll">
        <div className="orc-tabs" role="tablist" aria-label={t('panel.task.details')} onKeyDown={(event) => {
          const index = tabs.findIndex((item) => item.key === tab)
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
          if (next < 0) return
          event.preventDefault()
          setTab(tabs[next]!.key)
          onTabChange?.(tabs[next]!.key)
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}>
          {tabs.map(({ key, label }) => (
            <button key={key} type="button" role="tab" className="orc-tab" aria-selected={tab === key} onClick={() => { setTab(key); setPanelTrace(null); onTabChange?.(key) }}>
              {label}
            </button>
          ))}
        </div>
        <div className="orc-tabpanel" role="tabpanel">
          {tab === 'overview' ? <>
            {(attention.length > 0 || task.lastOutcome === 'failed' || phrase.tone === 'alert') ? <div className={`orc-now orc-now--${phrase.tone}`}><span style={{ color: tone.color }} aria-hidden="true">{tone.glyph} </span>{phrase.text}{phrase.hint ? <small>{phrase.hint}</small> : null}</div> : null}
            {(primary === 'accept' || primary === 'decision' || task.status === 'in_review' || task.status === 'accepted' || task.status === 'closed') && detail?.verdict && !(isOwnWork(detail.kind) && detail.runs.length === 0 && !detail.report) ? <>
              <div className={`orc-verdict orc-verdict--${detail.verdict.kind}`} role="status"><span className="orc-verdict__mark" aria-hidden="true">{detail.verdict.kind === 'result' ? '✓' : detail.verdict.kind === 'negative' ? '−' : '?'}</span><strong>{t(`verdict.${detail.verdict.kind}`)}</strong>{detail.verdict.kind === 'negative' && detail.verdict.why ? <span> · {t(`verdict.why.${detail.verdict.why}`)}</span> : null}{detail.verdict.kind === 'disputed' && detail.verdict.mismatch ? <span> · {t(`verdict.mismatch.${detail.verdict.mismatch}`)}</span> : null}</div>
              {detail.verdict.facts.length ? /* biome-ignore lint/a11y/useAriaPropsSupportedByRole: This label describes a styled presentation region or indicator. */ <div className="orc-verdict__facts" aria-label={t('verdict.facts')}>{detail.verdict.facts.map((fact, i) => <VerdictFactChip key={`${fact.code}-${i}`} fact={fact} onJump={(line) => setReportJump((prev) => ({ line, seq: (prev?.seq ?? 0) + 1 }))} />)}</div> : null}
            </> : null}
            {task.kind === 'decision' ? <DecisionBrief key={`${repo.root}:${repo.planId ?? ''}:${task.id}`} repo={repo} workers={workers} task={task} detail={detail?.id === task.id ? detail : null} onSelect={onSelect} /> : null}
            {detail ? <ReportCard key={task.id} task={task} detail={detail} onTab={setTab} jump={reportJump} /> : null}
            {detail?.steers?.length ? <section className="orc-overview-section"><h3>{t('panel.task.steersLabel')}</h3><ul className="orc-list orc-steers" aria-label={t('panel.task.steersLabel')}>{detail.steers.map(steer => <li key={steer.id} className="orc-steer"><p className="orc-steer__text">{steer.preview}</p><p className="orc-steer__meta"><span>{t(`panel.task.steerState.${steer.state}`)}</span> · <time dateTime={steer.timestamps[steer.state]}>{new Date(steer.timestamps[steer.state] ?? steer.createdAt).toLocaleTimeString()}</time></p>{steer.state === 'abandoned' ? <div className="orc-steer__recovery"><span>{t(`panel.task.steerReason.${steer.reason ?? 'run_finished'}`)}</span>{task.status === 'accepted' || task.status === 'superseded' ? null : <button type="button" className="orc-btn" disabled={action.pending} onClick={() => void action.call(() => api.relaunch(repo.root, task.id, { note: steer.text ?? steer.preview })).then(after)}>{t('panel.task.relaunchWithCorrection')}</button>}</div> : null}</li>)}</ul></section> : null}
            <section className="orc-overview-section"><h3>{t('panel.task.tab.notes')}</h3><NotesTab detail={detail} /></section>
            <section className="orc-overview-section"><h3>{t('panel.task.tab.links')}</h3><LinksTab task={task} detail={detail} onSelect={onSelect} /></section>
            {showRemoved ? <p className="orc-meta">{t('panel.task.copyRemoved')}</p> : null}
            {copyExists ? candidate.keep ? <p className="orc-meta">{t(`worktree.keep.${candidate.keep}`)}</p> : <button type="button" className="orc-run__link" disabled={removingCopy} onClick={() => void removeCopy()}>{t('panel.task.removeCopy')}</button> : null}
            {copyError ? <p className="orc-error" role="alert">{copyError}</p> : null}
          </> : null}
          {tab === 'activity' ? panelTrace?.taskId === task.id ? <RunTracePanel root={repo.root} target={panelTrace} onBack={() => setPanelTrace(null)} /> : <>
            {detail?.runs.length ? <div className="orc-activity-run"><label htmlFor="orc-activity-run">{t('panel.task.pickRun')}</label><select id="orc-activity-run" className="orc-select" value={selectedRun?.runId ?? ''} onChange={(e) => setSelectedRunId(e.target.value)}>{detail.runs.map((run, i) => <option key={run.runId} value={run.runId}>{t('panel.task.runNumber', { count: i + 1 })} · {identityLabel(workerIdentity(run.agent, workers))} · {run.outcome ? t(`panel.tabs.outcome.${run.outcome}`) : t('panel.tabs.runActive')}</option>)}</select>{selectedRun ? <button type="button" className="orc-run__link" onClick={() => { const target = { taskId: detail.id, taskTitle: detail.title, run: { runId: selectedRun.runId, agent: selectedRun.agent, startedAt: selectedRun.startedAt, active: !selectedRun.finishedAt } }; if (onTrace) onTrace(target); else setPanelTrace(target) }}>{t('panel.task.openLedger')} →</button> : null}</div> : <p className="orc-meta">{t('panel.tabs.noRuns')}</p>}
            {selectedRun?.runId === detail?.runs.at(-1)?.runId ? <FeedTab detail={detail} /> : selectedRun ? <OlderRunActivity root={repo.root} taskId={task.id} runId={selectedRun.runId} /> : null}
          </> : null}
          {tab === 'changes' ? <ChangesTab detail={detail} root={repo.root} /> : null}
          {tab === 'contract' ? <ContractTab detail={detail} /> : null}
        </div>
      </div>

    </aside>
  )
}
