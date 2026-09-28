import { useEffect, useState } from 'react'
import type { Attention, OrchestraRepoSnapshot, TaskDetail, TaskSnapshot, VerdictFact, WorkerInfo } from '../../shared/types.js'
import { useAction } from '../actions.js'
import { api, shared, taskVersion } from '../api.js'
import { CopyForAgent } from '../copy-agent.js'
import { taskHandoff } from '../handoff.js'
import { identityLabel, taskIdentity, workerIdentity } from '../provider.js'
import { CLASS_LABEL, classOfTask } from '../routing.js'
import { orchestraStore, type Density } from '../store.js'
import { taskTone } from '../styles.js'
import { isChecking, isOwnWork } from '../../../../core/src/plan/graph.js'
import { incompleteText, nowPhrase, sinceLabel } from '../summary.js'
import { workerName } from '../preset-picker.js'
import { isHandPicked, workerChoiceOf, workerOptions } from '../workers.js'
import { ReportCard } from './report.js'
import { ChangesTab, ContractTab, FeedTab, LinksTab, NotesTab, OlderRunActivity, resolveTab, type TabKey } from './tabs.js'
import type { TraceTarget } from './trace.js'
import { RunTracePanel } from './run-trace-panel.js'
import { VendorMark } from '../vendor-mark.js'
import { DecisionBrief } from './decision-brief.js'
import { LastAttemptBlock } from './last-attempt.js'
import { PreviousRuns } from './previous-runs.js'
import { CrewboardChecks } from './crewboard-checks.js'
import type { GcCandidate, SteerResult } from '@crewboard/core'
import { t, useLang } from '../i18n.js'
import { ReviewCheckLine, verdictMark, verdictTone } from '../review-signals.js'
import { conflictLabel, conflictSendBack } from '../conflicts.js'
import { orchestratorClosing, orchestratorMerging } from '../process-status.js'
import { contractBlock } from '../../../../core/src/orchestration/verdict.js'

/** Automatic worker selection delegates routing to the host; on an assigned task it also clears the assignment. */
const AUTO = 'auto'
/** Run the task's assigned worker as it is (the host applies the launch rule). */
const KEEP = 'keep'
/** «Send back and rerun» with the previous run's worker (the host's relaunch rule). */
const SAME = 'same'

/** Keep both ends of a path visible; title and copy retain the exact value. */
export const shortPath = (p: string): string => {
  if (p.length <= 34) return p
  return `${p.slice(0, 8)}…${p.slice(-14)}`
}

export const dependencyChips = (deps: string[]) => ({ shown: deps.slice(0, 2), remaining: Math.max(0, deps.length - 2) })

type Launch = { agent: string; at: string; worktree?: { path: string; branch: string } }

/** Keep reasons the screen already words (`worktree.keep.*`); anything else is git's own message. */
const KEEP_KEYS = { dirty: 1, unmerged: 1, running: 1, recent: 1, rejected: 1, orphan: 1 }

type Primary = 'run' | 'continue' | 'attempt' | 'steer' | 'accept' | 'decision' | 'blocked' | 'orchestrator' | 'merge' | 'none'

/**
 * One main button per context. `orchestrator` (rt1): the orchestrator's move and no button for the person —
 * a root task it has to start or is working on, a decision it still prepares. `merge` (w1d): accepted work not in the
 * base branch yet — the person merges it with Merge (mg1) or by hand with the exact commands the panel gives.
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
  // The last attempt failed (fo1): the move that fits its reason leads, Start becomes the secondary action.
  if (task.lastAttempt?.outcome === 'failed') return 'attempt'
  return 'run'
}

/**
 * The orchestrator's check above Accept / Send back (vr1): a calm mark while it checks, its note once checked.
 */
export function CheckMark({ task }: { task: TaskSnapshot }) {
  // A worker's task in review always says where the check stands (vc1): waiting, checking, checked, or off and why.
  if (task.reviewCheck) return <ReviewCheckLine check={task.reviewCheck} note={task.checkNote} />
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
    : fact.code === 'deviation' ? t('verdict.fact.deviation', { text: fact.text ?? '' })
    : fact.code === 'outside_paths' ? t('verdict.fact.outside_paths', { count: fact.count ?? 0 })
    : fact.code === 'crewboard_checks' ? t('verdict.fact.crewboard_checks', { passed: fact.count ?? 0, total: fact.total ?? 0 })
    : t(`verdict.fact.${fact.code}`)
  const className = `orc-verdict__fact orc-verdict__fact--${fact.tone}`
  // Files outside the contract's paths are listed, not only counted (vc1, B27).
  // Failed checks Crewboard ran are named too (ck1).
  const listed = fact.files?.length ? `${fact.files.join(', ')}${(fact.count ?? 0) > fact.files.length ? ', …' : ''}` : fact.commands?.length ? fact.commands.join(', ') : undefined
  if (fact.sourceLine === undefined) return <span className={className} title={listed}>{label}{listed ? <span className="orc-verdict__files">{`: ${listed}`}</span> : null}</span>
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
  /** A failed detail read blocks acceptance until the contract and evidence can be loaded again. */
  const [detailFailed, setDetailFailed] = useState(false)
  const [detailRetry, setDetailRetry] = useState(0)
  const [tab, setTab] = useState<TabKey>('overview')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [panelTrace, setPanelTrace] = useState<TraceTarget | null>(null)
  const [form, setForm] = useState<'none' | 'steer' | 'reject' | 'unchecked' | 'markMerged' | 'dirty'>('none')
  /** Uncommitted changes the copy holds, when a start asked the person what to do with them (fo1). */
  const [dirtyCount, setDirtyCount] = useState(0)
  const [message, setMessage] = useState('')
  const [steerOutcome, setSteerOutcome] = useState<SteerResult | null>(null)
  const [reason, setReason] = useState('')
  const [rerunWorker, setRerunWorker] = useState(SAME)
  const assigned = task.workerSource ? task.worker : undefined
  const [worker, setWorker] = useState(assigned ? KEEP : AUTO)
  const [launched, setLaunched] = useState<Launch | null>(null)
  const [copied, setCopied] = useState(false)
  const [branchCopied, setBranchCopied] = useState(false)
  const [logCopied, setLogCopied] = useState(false)
  const [mergeCopied, setMergeCopied] = useState(false)
  const [merged, setMerged] = useState<{ into: string; commit: string; copy: string; keptBecause?: string } | null>(null)
  // bs1: the main checkout had another branch checked out at launch — the copy still took the default base.
  const [baseNotice, setBaseNotice] = useState<{ checkedOut: string; base: string } | null>(null)
  const [baseDriftCopied, setBaseDriftCopied] = useState(false)
  const [candidate, setCandidate] = useState<GcCandidate | null>(null)
  const [copiesLoaded, setCopiesLoaded] = useState(false)
  const [copyRemoved, setCopyRemoved] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [removingCopy, setRemovingCopy] = useState(false)
  const [reportJump, setReportJump] = useState<{ line: number; seq: number } | null>(null)
  useLang()
  const action = useAction()
  const checksAction = useAction()
  const tone = taskTone(task)
  const checking = task.status === 'in_review' && isChecking(task.check)
  const taskClass = classOfTask(task)
  // With nobody's pick yet, the preset's first worker is who will run (nb1): named, never «No worker assigned».
  const presetPick = !task.worker && !launched && !task.runs && task.kind !== 'root' && task.kind !== 'decision' ? repo.effectiveRouting?.routing[taskClass][0] : undefined
  const identity = taskIdentity(task, workers, launched?.agent ?? presetPick)
  const phrase = nowPhrase(task, attention)
  const primary = repo.example ? 'none' : primaryAction(task)
  // A blocked claim does not tell us that the worker asked the person a question.
  // Returning with a reason is the single correction path; it can relaunch the worker.
  const verdict = task.verdict ?? detail?.verdict
  const negativeResult = primary === 'accept' && verdict?.kind === 'negative'
  const riskyResult = primary === 'accept' && (negativeResult || verdict?.kind === 'disputed' || !!verdict?.caution)
  const closeCandidate = primary === 'accept' && orchestratorClosing(repo, task)
  const detailReady = detail?.id === task.id
  const humanReview = detailReady && !!detail?.contract && (detail.contract.humanReviewRequired ?? (contractBlock(detail.contract.text, 'human_review') !== undefined))
  const reviewDetailPending = primary === 'accept' && !isOwnWork(task.kind) && !detailReady
  const assessingClose = closeCandidate && !detailReady && !detailFailed
  const closing = closeCandidate && detailReady && !humanReview
  const merging = primary === 'merge' && orchestratorMerging(repo, task)
  const verdictVisible = detailReady && (primary === 'accept' || primary === 'decision' || task.status === 'in_review' || task.status === 'accepted' || task.status === 'closed') && !!detail?.verdict && !(isOwnWork(detail.kind) && detail.runs.length === 0 && !detail.report)
  const isDecision = task.kind === 'decision'
  // Detail is refetched on selection and whenever the snapshot moved this task forward.
  const freshness = `${task.status}:${task.runs}:${task.lastRunId ?? ''}:${task.check ?? ''}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    setForm('none')
    setMessage('')
    setSteerOutcome(null)
    setReason('')
    setRerunWorker(SAME)
    setWorker(task.workerSource && task.worker ? KEEP : AUTO)
    setLaunched(null)
    setCopied(false)
    setBranchCopied(false)
    setLogCopied(false)
    setMergeCopied(false)
    setMerged(null)
    setBaseNotice(null)
    setBaseDriftCopied(false)
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
    setDetail(null)
    setCopiesLoaded(false)
    void shared.worktrees(repo.root, String(repo.rev)).then((r) => {
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
    setDetail(null)
    setDetailFailed(false)
    // The first read is shared with the other readers of this task (pf1); a running task's feed then asks every 2 s,
    // since the host does not follow a live run's steps.
    const version = taskVersion(repo, task.id)
    const refresh = (first: boolean) => { void (first ? shared.task : shared.taskReload)(repo.root, task.id, version)
      .then((r) => {
        if (!alive) return
        setDetail(r.ok ? r.value : null)
        setDetailFailed(!r.ok)
      })
      .catch(() => { if (alive) { setDetail(null); setDetailFailed(true) } }) }
    refresh(detailRetry === 0)
    const timer = task.status === 'running' ? setInterval(() => refresh(false), 2000) : undefined
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [repo.root, task.id, freshness, detailRetry])

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

  // Start and «Try again» share one call; a copy with uncommitted changes asks the person first (fo1).
  const start = (dirtyCopy?: 'keep' | 'reset') => void action.call(async () => {
    // «Auto» on an assigned task clears the assignment; KEEP leaves the choice to the launch rule.
    const r = await api.run(repo.root, task.id, worker === KEEP ? undefined : worker === AUTO ? (assigned ? AUTO : undefined) : worker, dirtyCopy)
    if (!r.ok && r.error === 'dirty_copy') {
      setDirtyCount(Number(r.vars?.count ?? 0))
      setForm('dirty')
      return { ok: true, value: null }
    }
    if (r.ok) {
      if (form === 'dirty') setForm('none')
      setLaunched({ agent: r.value.agent ?? worker, at: new Date().toISOString(), ...(r.value.worktree ? { worktree: r.value.worktree } : {}) })
      setBaseNotice(r.value.baseNotice ?? null)
    }
    return r
  })
  const continueRun = () => void action.call(() => api.continueRun(repo.root, task.id))
  // wk1 (B29): a worker's run can be sent back and started again at once; a decision or root task has no run to repeat.
  const canRerun = !isDecision && task.kind !== 'root' && task.runs > 0
  const lastWorker = detail?.runs?.at(-1)?.agent
  const presetWorkers = (repo.effectiveRouting?.routing[taskClass] ?? []).filter((id) => id !== lastWorker)
  const sendBack = (rerun: boolean) => void action.call(() => api.reject(repo.root, task.id, reason.trim(), rerun ? { rerun: true, ...(rerunWorker !== SAME ? { agent: rerunWorker } : {}) } : undefined)).then(after)
  const sentBack = task.lastDecision?.verdict === 'sent_back' && task.status !== 'running' && task.status !== 'in_review' ? task.lastDecision : undefined
  // The answer is the task's detail with the new record: the snapshot does not change, so nothing else refreshes it (ck1).
  const runChecks = () => void checksAction.call(async () => {
    const r = await api.runChecks(repo.root, task.id)
    if (r.ok) setDetail(r.value)
    return r
  })
  const attempt = task.status === 'running' ? undefined : task.lastAttempt
  // mg1: the person's Merge — the host checks, asks natively and refuses with the same texts as `crewboard merge`.
  const merge = (strategy: 'no-ff' | 'squash') => void action.call(async () => {
    const result = await api.merge(repo.root, task.id, strategy)
    if (result.ok) {
      setMerged(result.value)
      if (result.value.copy === 'removed') setCopyRemoved(true)
    }
    return result
  })
  // mk1: work that reached the base in a way Crewboard cannot see — the person records it, with a reason.
  const markMerged = () => void action.call(() => api.markMerged(repo.root, task.id, reason.trim())).then(after)
  // mk1: a detached main checkout has no branch to name — say which checkout's current commit it is.
  const mergeInto = detail?.merge?.detached ? t('panel.task.mergeDetached', { path: detail.merge.detached.root }) : detail?.merge?.into ?? t('panel.task.mergeBase')
  const conflicts = task.status === 'in_review' ? task.conflicts ?? [] : []

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
  // A red baseline's full output is in a file (tk1): the panel names it and copies its path.
  const baselineLog = detail?.worktree?.baseline && !detail.worktree.baseline.ok ? detail.worktree.baseline.log : undefined
  const copyLog = () => {
    void navigator.clipboard?.writeText(baselineLog ?? '').then(() => {
      setLogCopied(true)
      setTimeout(() => setLogCopied(false), 1600)
    }).catch(() => {})
  }
  const copyMerge = () => {
    void navigator.clipboard?.writeText(detail?.merge?.commands.join('\n') ?? '').then(() => {
      setMergeCopied(true)
      setTimeout(() => setMergeCopied(false), 1600)
    }).catch(() => {})
  }
  // bs1: the recorded base drifted from the repository's current default — the rebase command, once.
  const baseDrift = detail?.id === task.id ? detail.baseDrift : undefined
  const baseDriftCommand = baseDrift ? `git -C ${baseDrift.path} rebase ${baseDrift.default}` : ''
  const copyBaseDrift = () => {
    void navigator.clipboard?.writeText(baseDriftCommand).then(() => {
      setBaseDriftCopied(true)
      setTimeout(() => setBaseDriftCopied(false), 1600)
    }).catch(() => {})
  }
  const deps = dependencyChips(task.deps)
  const selectedRun = detail?.runs?.find((run) => run.runId === selectedRunId) ?? detail?.runs?.at(-1)

  return (
    <aside className="orc-panel" aria-label={t('panel.task.aria', { title: task.title })}>
      <div className="orc-panel__fixed">
        <div className="orc-sec orc-sec--head">
          <h2 className="orc-h">{task.title}</h2>
          <CopyForAgent text={taskHandoff(repo, task)} />
          <button type="button" className="orc-run__link" onClick={() => { void navigator.clipboard?.writeText(orchestraStore.taskLink(task.id)).catch(() => {}) }}>{t('panel.task.copyLink')}</button>
          {/* A decision is the person's own choice (w1b, B05): no worker, no model, no task class to show. */}
          <div className="orc-panel__identity">{isDecision ? <span>{tone.label}</span> : <><VendorMark identity={identity} /><span className="orc-panel__identity-name">{identityLabel(identity)}</span><span>{`· ${tone.label}`}</span></>}{showRun && runSince ? <span>{`· ${runSince}`}</span> : null}</div>
          <details className="orc-panel__context">
            <summary>{t('panel.task.context')}</summary>
          {isDecision ? null : task.kind === 'root' ? <p className="orc-meta orc-panel__choice">{t('panel.task.rootOwner')}</p> : <p className="orc-meta orc-panel__choice">{presetPick ? t('panel.task.willRun', { worker: identityLabel(identity) }) : t('panel.task.workerChoice', { worker: task.worker || launched ? identityLabel(identity) : repo.effectiveRouting?.routing[taskClass][0] ? workerName(repo.effectiveRouting.routing[taskClass][0], workers ?? []) : '—', who: t(`panel.task.chosenBy.${workerChoiceOf(task)}`) })}{isHandPicked(task) ? <span className="orc-panel__hand" title={t('graph.handPickedTitle')}>{t('graph.handPicked')}</span> : null}</p>}
          <div className="orc-panel__chips">
            {task.lane ? <span className="orc-panel__chip" title={task.lane}>{task.lane}</span> : null}
            {isDecision ? null : <span className="orc-panel__chip">{CLASS_LABEL[taskClass]}</span>}
            {deps.shown.map((id) => <span key={id} className="orc-panel__chip" title={id}>{id}</span>)}
            {deps.remaining ? <span className="orc-panel__chip" title={task.deps.join(', ')}>+{deps.remaining}</span> : null}
          </div>
          {runWorktree ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-panel__worktree" role="group" aria-label={t('panel.task.run')}>
            <code title={runWorktree.path}>{shortPath(runWorktree.path)}</code><button type="button" aria-label={t('panel.task.copyPath')} title={runWorktree.path} onClick={copyPath}>{copied ? '✓' : '⧉'}</button>
            <code title={runWorktree.branch}>{shortPath(runWorktree.branch)}</code><button type="button" aria-label={t('panel.task.copyBranch')} title={runWorktree.branch} onClick={copyBranch}>{branchCopied ? '✓' : '⧉'}</button>
            {detail?.worktree?.base ? <span className="orc-panel__base" title={t('panel.task.baseTitle')}>{t('panel.task.baseLabel', { base: detail.worktree.base })}</span> : null}
            {detail?.worktree?.baseline ? <span className={`orc-panel__baseline${detail.worktree.baseline.ok ? '' : ' orc-panel__baseline--red'}`} title={detail.worktree.baseline.command}>{t(detail.worktree.baseline.ok ? 'panel.task.baselineGreen' : 'panel.task.baselineRed', { commit: detail.worktree.baseline.commit.slice(0, 7), at: new Date(detail.worktree.baseline.at).toLocaleString() })}</span> : null}
            {baselineLog ? <><code title={baselineLog}>{shortPath(baselineLog)}</code><button type="button" aria-label={t('panel.task.copyBaselineLog')} title={baselineLog} onClick={copyLog}>{logCopied ? '✓' : '⧉'}</button></> : null}
          </div> : null}
          </details>
          {baseNotice ? <p className="orc-hint" role="status">{t('panel.task.baseNotice', baseNotice)}</p> : null}
          {baseDrift ? <div className="orc-hint" role="status">
            <p>{t('panel.task.baseDrift', { base: baseDrift.base, default: baseDrift.default })}</p>
            <pre className="orc-merge__commands">{baseDriftCommand}</pre>
            <button type="button" className="orc-run__link" onClick={copyBaseDrift}>{baseDriftCopied ? t('panel.task.mergeCopied') : t('panel.task.baseDriftCopy')}</button>
          </div> : null}
        </div>

        <div className="orc-sec orc-sec--actions">
          {verdictVisible && detail?.verdict ? <div className={`orc-verdict orc-verdict--${verdictTone(detail.verdict)}`} role="status"><span className="orc-verdict__mark" aria-hidden="true">{verdictMark(detail.verdict)}</span><strong>{t(`verdict.${detail.verdict.kind}`)}</strong>{detail.verdict.kind === 'result' && detail.verdict.caution ? <span> · {t(`verdict.caution.${detail.verdict.caution}`)}</span> : null}{detail.verdict.kind === 'negative' && detail.verdict.why ? <span> · {t(`verdict.why.${detail.verdict.why}`)}</span> : null}{detail.verdict.kind === 'disputed' && detail.verdict.mismatch ? <span> · {t(`verdict.mismatch.${detail.verdict.mismatch}`)}</span> : null}</div> : null}
          {detail?.resultAttestation ? <div className={`orc-hint${detail.resultAttestation.freshness === 'stale' ? ' orc-action-state' : ''}`} role="status">
            <strong>{t(task.status === 'accepted' && !!detail.merged && detail.verdict?.kind === 'result' ? 'attestation.historical' : detail.resultAttestation.freshness === 'current' ? 'attestation.current' : 'attestation.stale', { verdict: detail.resultAttestation.record.verdict, reason: detail.resultAttestation.reason ? t(`attestation.staleReason.${detail.resultAttestation.reason}`) : '' })}</strong>
            <p>{t('attestation.facts', { by: detail.resultAttestation.record.by, at: new Date(detail.resultAttestation.record.checkedAt).toLocaleString(), head: detail.resultAttestation.record.head.slice(0, 12), contract: detail.resultAttestation.record.contractPath, revision: detail.resultAttestation.record.contractRevision.slice(0, 12), reason: detail.resultAttestation.reason ?? '' })}</p>
            {detail.currentGit ? <p>{t('attestation.gitNow', { head: detail.currentGit.head?.slice(0, 12) ?? '—', dirty: detail.currentGit.uncommitted ?? '—', at: new Date(detail.currentGit.observedAt).toLocaleString() })}</p> : null}
            {detail.liveCopyAvailable === false ? <p>{t('attestation.liveCopyMissing')}</p> : null}
            {detail.evidence?.uncommitted !== undefined ? <p>{t('attestation.workerSnapshot', { count: detail.evidence.uncommitted, at: detail.evidence.capturedAt })}</p> : null}
            {detail.resultAttestation.receipts?.checks.length ? <div><strong>{t('attestation.receipts')}</strong><ul>{detail.resultAttestation.receipts.checks.map((receipt) => <li key={receipt.command}><code>{receipt.command}</code> — {receipt.exitCode === 0 && !receipt.timedOut ? 'PASS' : 'FAIL'} · {receipt.output}</li>)}</ul></div> : null}
            {detail.resultAttestation.proof ? <details><summary>{t('attestation.proof', { path: detail.resultAttestation.record.report })}</summary><pre>{detail.resultAttestation.proof}</pre></details> : null}
          </div> : null}
          {!detail?.resultAttestation && detail?.evidence?.uncommitted !== undefined ? <p className="orc-meta">{t('attestation.workerSnapshot', { count: detail.evidence.uncommitted, at: detail.evidence.capturedAt })}</p> : null}
          {detail?.workerClaimProjection ? <div className="orc-hint"><strong>{t('attestation.workerClaims', { at: new Date(detail.workerClaimProjection.capturedAt).toLocaleString() })}</strong><ul>{detail.workerClaimProjection.checks.map((check) => <li key={check.command}><code>{check.command}</code> — {t(`attestation.claimState.${check.state}`)}</li>)}</ul></div> : null}
          {detail?.workerClaimProjection?.workerBrowserClaim ? <p className="orc-meta">{t('attestation.workerBrowserClaim', { at: new Date(detail.workerClaimProjection.capturedAt).toLocaleString(), line: detail.workerClaimProjection.workerBrowserClaim.line })}</p> : null}
          {primary === 'accept' || primary === 'decision' ? <CheckMark task={task} /> : null}
          {assessingClose ? <p className="orc-hint orc-action-state" role="status">{t('panel.task.assessingClose')}</p> : null}
          {reviewDetailPending && !closeCandidate && !checking && !detailFailed ? <p className="orc-hint orc-action-state" role="status">{t('panel.task.loadingDetail')}</p> : null}
          {reviewDetailPending && detailFailed ? <div className="orc-detail-error" role="alert"><p>{t('panel.task.detailLoadFailed')}</p><button type="button" className="orc-btn" onClick={() => setDetailRetry((count) => count + 1)}>{t('panel.task.retryDetail')}</button></div> : null}
          {closing ? <p className="orc-hint orc-action-state" role="status">{t('panel.task.orchestratorClosing')}</p> : null}
          {humanReview && primary === 'accept' ? <p className="orc-hint orc-action-state" role="note">{t('panel.task.humanReview')}</p> : null}
          {merging ? <p className="orc-hint orc-action-state" role="status">{t('panel.task.orchestratorMerging')}</p> : null}
          <div className="orc-actions">
            {checking && primary === 'accept' && !reviewDetailPending ? <details className="orc-early"><summary>{t('panel.task.reviewEarly')}</summary><div className="orc-early__actions"><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm(form === 'unchecked' ? 'none' : 'unchecked')}>{t('panel.task.acceptEarly')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm(form === 'reject' ? 'none' : 'reject')}>{t('panel.task.sendBackMore')}</button></div></details> : null}
            {closing ? <details className="orc-early"><summary>{t('panel.task.reviewManually')}</summary><div className="orc-early__actions"><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={accept}>{t('panel.task.accept')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm(form === 'reject' ? 'none' : 'reject')}>{t('panel.task.sendBackMore')}</button></div></details> : null}
            {merging ? <details className="orc-early"><summary>{t('panel.task.mergeManually')}</summary><div className="orc-early__actions"><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => merge('no-ff')}>{t('panel.task.merge')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => merge('squash')}>{t('panel.task.mergeSquash')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} aria-expanded={form === 'markMerged'} onClick={() => setForm(form === 'markMerged' ? 'none' : 'markMerged')}>{t('panel.task.markMerged')}</button></div></details> : null}
            {primary === 'run' || primary === 'attempt' ? (
              <>
                <button type="button" className={primary === 'attempt' ? 'orc-btn orc-btn--ghost' : 'orc-btn'} disabled={action.pending} onClick={() => start()}>{t('panel.task.start')}</button>
                <select className="orc-select" aria-label={t('panel.task.worker')} value={worker} onChange={(e) => setWorker(e.target.value)}>
                  {assigned ? <option value={KEEP}>{t('panel.task.keepAssigned', { worker: identityLabel(workerIdentity(assigned, workers)) })}</option> : null}
                  <option value={AUTO}>{t('panel.task.auto')}</option>
                  {workerOptions(task.worker ?? 'dsh', workers).map((w) => <option key={w} value={w}>{identityLabel(workerIdentity(w, workers))}</option>)}
                </select>
              </>
            ) : null}
            {primary === 'continue' && !attempt ? <button type="button" className="orc-btn" disabled={action.pending} onClick={continueRun}>{t('panel.task.continue')}</button> : null}
            {primary === 'steer' ? <><button type="button" className="orc-btn" onClick={() => setForm(form === 'steer' ? 'none' : 'steer')} aria-expanded={form === 'steer'}>{t('panel.task.steer')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => action.call(() => api.stop(repo.root, task.id))}>{t('panel.task.stop')}</button></> : null}
            {riskyResult && !checking && !reviewDetailPending ? <button type="button" className="orc-btn" onClick={() => setForm(form === 'reject' ? 'none' : 'reject')} aria-expanded={form === 'reject'}>{t('panel.task.sendBackMore')}</button> : null}
            {(primary === 'accept' && !checking && !closing && !reviewDetailPending) || primary === 'decision' ? <><button type="button" className={riskyResult ? 'orc-btn orc-btn--ghost' : 'orc-btn'} disabled={action.pending} onClick={accept}>{primary === 'decision' ? t('panel.task.acceptDecision') : negativeResult ? t('panel.task.acceptNoResult') : verdict?.kind === 'disputed' ? t('panel.task.acceptDisputed') : verdict?.caution ? t('panel.task.acceptDeviation') : t('panel.task.accept')}</button>{!riskyResult ? <button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm(form === 'reject' ? 'none' : 'reject')} aria-expanded={form === 'reject'}>{t('panel.task.sendBackMore')}</button> : null}</> : null}
            {primary === 'orchestrator' ? <span className="orc-meta">{orchestratorMove(task)}</span> : null}
            {primary === 'blocked' ? <button type="button" className="orc-btn" onClick={() => onSelect(task.blockedBy[0] ?? null)} disabled={task.blockedBy.length === 0}>{t('panel.task.blocker')}</button> : null}
            {primary === 'merge' && !merging ? <><button type="button" className="orc-btn" disabled={action.pending} onClick={() => merge('no-ff')}>{t('panel.task.merge')}</button><details className="orc-early"><summary>{t('panel.task.otherMergeOptions')}</summary><div className="orc-early__actions"><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => merge('squash')}>{t('panel.task.mergeSquash')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} aria-expanded={form === 'markMerged'} onClick={() => setForm(form === 'markMerged' ? 'none' : 'markMerged')}>{t('panel.task.markMerged')}</button></div></details></> : null}
            {primary === 'none' ? <span className="orc-meta">{repo.example ? t('welcome.exampleReadOnly') : task.status === 'accepted' && task.kind !== 'decision' && task.kind !== 'root' ? t('panel.task.merged') : t('panel.task.noAction')}</span> : null}
          </div>
          {/* The lead goes under the buttons, never beside them (bx1). */}
          {primary === 'merge' && !merging ? <p className="orc-meta">{t('panel.task.mergeLead', { into: mergeInto })}</p> : null}
          {primary === 'run' || primary === 'attempt' ? <div className="orc-hint orc-run-route">
            <p>{worker === KEEP && assigned ? (task.workerSource === 'agent' && task.outsidePreset ? t('panel.task.staleAssigned', { worker: workerName(assigned, workers ?? []) }) : t('panel.task.assignedHint', { worker: workerName(assigned, workers ?? []), who: t(`panel.task.chosenBy.${workerChoiceOf(task)}`) })) : worker !== AUTO ? t('settings.runManual', { worker: workerName(worker, workers ?? []) }) : repo.effectiveRouting ? t('settings.runSource', {
              worker: repo.effectiveRouting.routing[taskClass][0] ? workerName(repo.effectiveRouting.routing[taskClass][0], workers ?? []) : t('settings.noWorker'),
              source: t(`settings.source.${repo.effectiveRouting.source}`),
              preset: repo.effectiveRouting.preset.builtin ? t('settings.allWorkers') : repo.effectiveRouting.preset.label,
            }) : t('panel.task.autoHint', { class: CLASS_LABEL[taskClass] })}</p>
            {repo.orchestratorCheck && !repo.orchestratorCheck.enabled && task.kind !== 'root' ? <p>{t(`check.runHint.${repo.orchestratorCheck.source}`)}</p> : null}
            {repo.effectiveRouting?.dropped.some((item) => item.reason === 'disabled') ? <p>{t('settings.disabledLine', { workers: repo.effectiveRouting.dropped.filter((item) => item.reason === 'disabled').map((item) => `${workerName(item.id, workers ?? [])}${repo.effectiveRouting?.disabled[item.id] ? ` (${repo.effectiveRouting.disabled[item.id]})` : ''}`).join(', ') })}</p> : null}
          </div> : null}
          {primary === 'continue' ? <div className="orc-hint" role="status"><p>{incompleteText(task.incomplete)}</p><p>{t('panel.task.continueHint')}</p></div> : null}
          {task.kind === 'decision' ? <div className="orc-decision__action-help"><h3 className="orc-decision__heading">{t('panel.task.decisionHelpTitle')}</h3><p>{t('panel.task.decisionAcceptHelp')}</p><p>{t('panel.task.decisionReturnHelp')}</p></div> : null}
          {primary === 'accept' && action.pending ? <p className="orc-hint" role="status">{t('panel.task.confirmHint')}</p> : null}
          {primary === 'merge' && !merging ? <details className="orc-merge-details"><summary>{t('panel.task.mergeCommands')}</summary><div className="orc-hint">
            <p>{t('panel.task.mergeHint', { into: mergeInto })}</p>
            {detail?.merge ? <><pre className="orc-merge__commands">{detail.merge.commands.join('\n')}</pre><button type="button" className="orc-run__link" onClick={copyMerge}>{mergeCopied ? t('panel.task.mergeCopied') : t('panel.task.mergeCopy')}</button></> : null}
          </div></details> : null}
          {form === 'dirty' ? <div className="orc-form" role="alertdialog" aria-label={t('dirty.question', { count: dirtyCount })}><p>{t('dirty.question', { count: dirtyCount })}</p><div className="orc-actions"><button type="button" className="orc-btn" disabled={action.pending} onClick={() => start('keep')}>{t('dirty.keep')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={action.pending} onClick={() => start('reset')}>{t('dirty.reset')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm('none')}>{t('panel.task.cancel')}</button></div><p className="orc-hint">{t('dirty.resetHint')}</p></div> : null}
          {merged ? <p className="orc-hint" role="status">{t('panel.task.mergeDone', { into: merged.into, commit: merged.commit.slice(0, 12) })}{merged.copy === 'removed' ? ` ${t('panel.task.mergeCopyRemoved')}` : merged.copy === 'kept_recent' ? ` ${t('panel.task.mergeCopyKeptRecent')}` : merged.copy === 'kept' && merged.keptBecause ? ` ${t('panel.task.mergeCopyKept', { reason: merged.keptBecause in KEEP_KEYS ? t(`worktree.keep.${merged.keptBecause}`) : merged.keptBecause })}` : ''}</p> : null}
          {form === 'markMerged' && primary === 'merge' ? <div className="orc-form"><p>{t('panel.task.markMergedHelp')}</p><textarea className="orc-field" aria-label={t('panel.task.markMergedReason')} placeholder={t('panel.task.markMergedPlaceholder')} value={reason} onChange={(e) => setReason(e.target.value)} /><div className="orc-actions"><button type="button" className="orc-btn" disabled={action.pending || !reason.trim()} onClick={markMerged}>{t('panel.task.markMergedConfirm')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm('none')}>{t('panel.task.cancel')}</button></div><p className="orc-hint">{t('panel.task.confirmHint')}</p></div> : null}
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
            {steerOutcome?.delivery === 'refused' ? <div role="status"><p className="orc-hint">{steerOutcome.reason === 'legacy_unverified_policy' ? t('panel.task.steerRefusedPolicy') : t('panel.task.steerRefused', { state: steerOutcome.runState })}</p><button type="button" className="orc-btn" disabled={action.pending} onClick={() => void action.call(() => api.relaunch(repo.root, task.id, { note: message })).then(after)}>{t('panel.task.relaunchWithCorrection')}</button></div> : null}
          </div> : null}
          {form === 'reject' ? <div className="orc-form"><textarea className="orc-field" aria-label={t('panel.task.reasonLabel')} placeholder={task.kind === 'decision' ? t('panel.task.decisionReasonPlaceholder') : t('panel.task.reasonPlaceholder')} value={reason} onChange={(e) => setReason(e.target.value)} />
            {canRerun ? <label className="orc-hint">{t('panel.task.rerunWorker')} <select className="orc-select" aria-label={t('panel.task.rerunWorker')} value={rerunWorker} onChange={(e) => setRerunWorker(e.target.value)}><option value={SAME}>{lastWorker ? t('panel.task.rerunSame', { worker: identityLabel(workerIdentity(lastWorker, workers)) }) : t('panel.task.rerunSameUnknown')}</option>{presetWorkers.map((w) => <option key={w} value={w}>{workerName(w, workers ?? [])}</option>)}</select></label> : null}
            <div className="orc-actions"><button type="button" className={riskyResult || !canRerun ? 'orc-btn' : 'orc-btn orc-btn--ghost'} disabled={action.pending || !reason.trim()} onClick={() => sendBack(false)}>{t('panel.task.sendBack')}</button>{canRerun ? <button type="button" className={riskyResult ? 'orc-btn orc-btn--ghost' : 'orc-btn'} disabled={action.pending || !reason.trim()} onClick={() => sendBack(true)}>{t('panel.task.sendBackRerun')}</button> : null}<button type="button" className="orc-btn orc-btn--ghost" onClick={() => setForm('none')}>{t('panel.task.cancel')}</button></div>
            {isDecision || task.kind === 'root' ? null : <p className="orc-hint">{t('panel.task.reasonNextRun')}</p>}
            <p className="orc-hint">{t('panel.task.confirmHint')}</p></div> : null}
          {sentBack && !isDecision && task.kind !== 'root' ? <p className="orc-hint" role="status">{t('panel.task.sentBackPending', { reason: sentBack.reason ?? '' })}</p> : null}
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
            {attempt ? <LastAttemptBlock task={task} attempt={attempt} pending={action.pending} onRetry={() => start()} onContinue={continueRun} /> : null}
            {!attempt && (attention.length > 0 || task.lastOutcome === 'failed' || phrase.tone === 'alert') ? <div className={`orc-now orc-now--${phrase.tone}`}><span style={{ color: tone.color }} aria-hidden="true">{tone.glyph} </span>{phrase.text}{phrase.hint ? <small>{phrase.hint}</small> : null}</div> : null}
            {verdictVisible && detail?.verdict ? <>
              {detail.verdict.facts.length ? /* biome-ignore lint/a11y/useAriaPropsSupportedByRole: This label describes a styled presentation region or indicator. */ <div className="orc-verdict__facts" aria-label={t('verdict.facts')}>{detail.verdict.facts.map((fact, i) => <VerdictFactChip key={`${fact.code}-${i}`} fact={fact} onJump={(line) => setReportJump((prev) => ({ line, seq: (prev?.seq ?? 0) + 1 }))} />)}</div> : null}
              {detail.id === task.id ? <CrewboardChecks detail={detail} canRun={task.status === 'in_review' && !checking && !closing && !assessingClose && !detail.example && !!detail.worktree && !!detail.runs?.at(-1)?.finishedAt} pending={checksAction.pending} onRun={runChecks} /> : null}
              {checksAction.error ? <p className="orc-error" role="alert">{checksAction.error}</p> : null}
            </> : null}
            {conflicts.length ? <div className="orc-conflicts" role="status"><strong>⚠ {t('panel.task.conflictsTitle')}</strong><ul>{conflicts.map((c) => <li key={c.with === 'base' ? `base:${c.into}` : `task:${c.taskId}`}>{conflictLabel(c)}</li>)}</ul><button type="button" className="orc-run__link" onClick={() => { setReason(conflictSendBack(conflicts, t('panel.task.mergeBase'))); setForm('reject') }}>{t('panel.task.conflictSendBack')}</button></div> : null}
            {task.kind === 'decision' ? <DecisionBrief key={`${repo.root}:${repo.planId ?? ''}:${task.id}`} repo={repo} workers={workers} task={task} detail={detail?.id === task.id ? detail : null} onSelect={onSelect} /> : null}
            {detailReady && detail ? <ReportCard key={task.id} task={task} detail={detail} onTab={setTab} jump={reportJump} /> : null}
            <details className="orc-panel__history">
              <summary>{t('panel.task.historyDetails')}</summary>
            {detail?.id === task.id ? <PreviousRuns detail={detail} workers={workers} onOpenRun={(runId) => { setSelectedRunId(runId); setPanelTrace(null); setTab('activity'); onTabChange?.('activity') }} /> : null}
            {detail?.steers?.length ? <section className="orc-overview-section"><h3>{t('panel.task.steersLabel')}</h3><ul className="orc-list orc-steers" aria-label={t('panel.task.steersLabel')}>{detail.steers.map(steer => <li key={steer.id} className="orc-steer"><p className="orc-steer__text">{steer.preview}</p><p className="orc-steer__meta"><span>{t(`panel.task.steerState.${steer.state}`)}</span> · <time dateTime={steer.timestamps[steer.state]}>{new Date(steer.timestamps[steer.state] ?? steer.createdAt).toLocaleTimeString()}</time></p>{steer.state === 'abandoned' ? <div className="orc-steer__recovery"><span>{t(`panel.task.steerReason.${steer.reason ?? 'run_finished'}`)}</span>{task.status === 'accepted' || task.status === 'superseded' ? null : <button type="button" className="orc-btn" disabled={action.pending} onClick={() => void action.call(() => api.relaunch(repo.root, task.id, { note: steer.text ?? steer.preview })).then(after)}>{t('panel.task.relaunchWithCorrection')}</button>}</div> : null}</li>)}</ul></section> : null}
            <section className="orc-overview-section"><h3>{t('panel.task.tab.notes')}</h3><NotesTab detail={detail} /></section>
            <section className="orc-overview-section"><h3>{t('panel.task.tab.links')}</h3><LinksTab task={task} detail={detail} onSelect={onSelect} /></section>
            </details>
            {showRemoved ? <p className="orc-meta">{t('panel.task.copyRemoved')}</p> : null}
            {copyExists ? candidate.keep ? <p className="orc-meta">{t(`worktree.keep.${candidate.keep}`)}</p> : <button type="button" className="orc-run__link" disabled={removingCopy} onClick={() => void removeCopy()}>{t('panel.task.removeCopy')}</button> : null}
            {copyError ? <p className="orc-error" role="alert">{copyError}</p> : null}
          </> : null}
          {tab === 'activity' ? panelTrace?.taskId === task.id ? <RunTracePanel root={repo.root} target={panelTrace} onBack={() => setPanelTrace(null)} /> : <>
            {detail?.runs.length ? <div className="orc-activity-run"><label htmlFor="orc-activity-run">{t('panel.task.pickRun')}</label><select id="orc-activity-run" className="orc-select" value={selectedRun?.runId ?? ''} onChange={(e) => setSelectedRunId(e.target.value)}>{detail.runs.map((run, i) => <option key={run.runId} value={run.runId}>{t('panel.task.runNumber', { count: i + 1 })} · {identityLabel(workerIdentity(run.agent, workers))} · {run.outcome ? t(`panel.tabs.outcome.${run.outcome}`) : t('panel.tabs.runActive')}</option>)}</select>{selectedRun ? <button type="button" className="orc-run__link" onClick={() => { const target = { taskId: detail.id, taskTitle: detail.title, run: { runId: selectedRun.runId, agent: selectedRun.agent, startedAt: selectedRun.startedAt, active: !selectedRun.finishedAt } }; if (onTrace) onTrace(target); else setPanelTrace(target) }}>{t('panel.task.openLedger')} →</button> : null}</div> : <p className="orc-meta">{t('panel.tabs.noRuns')}</p>}
            {selectedRun?.runId === detail?.runs?.at(-1)?.runId ? <FeedTab detail={detail} /> : selectedRun ? <OlderRunActivity root={repo.root} taskId={task.id} runId={selectedRun.runId} /> : null}
          </> : null}
          {tab === 'changes' ? <ChangesTab detail={detail} root={repo.root} /> : null}
          {tab === 'contract' ? <ContractTab detail={detail} /> : null}
        </div>
      </div>

    </aside>
  )
}
