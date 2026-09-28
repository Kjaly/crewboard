import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { nodeExec, type Exec } from '../exec.js'
import { type ViewStatus, deriveViews, isOwnWork } from '../plan/graph.js'
import type { Note, Run, Task, TaskCheck } from '../plan/schema.js'
import { loadPlan } from '../plan/store.js'
import type { RawEvent } from '../runs/raw-event.js'
import { type NormEvent, normalize } from '../runs/normalize.js'
import { type RunReport, extractReport, reportedAnswer } from '../runs/report.js'
import { type EvidenceFile, type FileStatus, fileStatus, readEvidence, type RunEvidence } from '../runs/evidence.js'
import type { Backends } from './backends.js'
import { attestedVerdict, contractBlock, projectWorkerCheckClaims, requiredChecks, verdictOf, type Verdict, type WorkerClaimProjection } from './verdict.js'
import { backendsForPlan } from '../runs/example-backend.js'
import { exampleFilePath } from '../plan/example.js'
import { listSteers, type SteerRecord } from '../runs/steers.js'
import { join } from 'node:path'
import { CREWBOARD_DIR } from '../plan/store.js'
import { type MessageVars, orchText } from './messages.js'
import { type BaselineRecord, readWorktreeState } from '../worktree/state.js'
import { baseBranch, checkedOutBranch, uncommittedCount } from '../worktree/merged.js'
import { resolveDefaultBase } from '../worktree/default-base.js'
import { mergeCommands } from '../plan/merge.js'
import { taskBase } from '../worktree/merge-task.js'
import { type LastDecision, lastDecisionOf } from './decision.js'
import { inspectAttestation } from './attestation.js'

const MAX_CONTRACT_BYTES = 64 * 1024
const MAX_DIFF_CHARS = 200 * 1024
const MAX_EVENTS = 200

export class DetailError extends Error {
  constructor(
    readonly code: 'unknown_task' | 'no_worktree' | 'unknown_file',
    readonly vars: MessageVars,
  ) {
    super(orchText('en', code, vars))
    this.name = 'DetailError'
  }
}

export type TaskDetail = {
  id: string
  title: string
  kind: Task['kind']
  /** The stored class (routing); absent — the kind decides. */
  class?: Task['class']
  status: ViewStatus
  lane?: string
  deps: string[]
  dependents: string[]
  /** Dependencies not done yet (a blocked task); `waitingMerge` — the part accepted but not merged (w1d). */
  blockedBy?: string[]
  waitingMerge?: string[]
  worker?: string
  /** The orchestrator's check (vr1, rt1) as stored: state, who, when, the note and, on own work, the report file. */
  check?: TaskCheck
  /** Latest independent judgement and a live freshness check against run, Git HEAD and contract. */
  resultAttestation?: Awaited<ReturnType<typeof inspectAttestation>>
  /** Current Git observation, separate from immutable worker-time evidence. */
  currentGit?: { head?: string; uncommitted?: number; observedAt: string }
  liveCopyAvailable?: boolean
  /** The accepted work reached its base (w1d, mg1). */
  merged?: Task['merged']
  /** `baseline` is the copy's last baseline run (worktree/state.ts); absent when none is on record. */
  worktree?: { path: string; branch: string; base?: string; baseline?: BaselineRecord }
  contract?: { path: string; text: string; truncated: boolean; humanReviewRequired?: boolean }
  runs: Run[]
  notes: Note[]
  steers: SteerRecord[]
  events: NormEvent[]
  changedFiles: string[]
  /** `changedFiles` with line counts and A/M/D (wk1) — for the Changes tab; counts are null when git did not give them. */
  files?: EvidenceFile[]
  report?: RunReport
  evidence?: RunEvidence
  /** Versioned, read-time re-extraction from the immutable worker answer; never a receipt. */
  workerClaimProjection?: WorkerClaimProjection
  /** Absent on a decision (w1b, B05): a decision is the person's choice, there is no worker's claim to judge. */
  verdict?: Verdict
  /** The latest human decision (wk1, B23), as the snapshot's task carries it. */
  lastDecision?: LastDecision
  /**
   * Files the run left in the copy without a commit (w1d) — from its evidence, else the copy as it is now. Accepted
   * as is, they would not reach the base branch.
   */
  uncommitted?: number
  /** Accepted work not merged into the base branch yet (w1d): where it goes and the exact commands that take it there. */
  merge?: {
    into: string
    branch: string
    path: string
    commands: string[]
    /** mk1: `into` is the HEAD commit of a detached main checkout, not a branch — say «the current commit of <root>». */
    detached?: { root: string }
  }
  /**
   * The task's recorded base differs from the repository's current default base (bs1): the person chose one
   * on purpose, or the default moved on since. `path` is the copy, for the rebase command.
   */
  baseDrift?: { base: string; default: string; path: string }
  example?: boolean
}

type Changes = { base?: string; tracked: string[]; untracked: string[]; status?: Map<string, FileStatus> }

const exists = (p: string) => stat(p).then(() => true, () => false)
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)

function insideRoot(root: string, rel: string): string | undefined {
  const abs = resolve(root, rel)
  const r = relative(root, abs)
  return r && !r.startsWith('..') && !isAbsolute(r) ? abs : undefined
}

async function readContract(root: string, rel: string | undefined): Promise<TaskDetail['contract']> {
  if (!rel) return undefined
  const abs = insideRoot(root, rel)
  if (!abs) return undefined
  const buf = await readFile(abs).catch(() => undefined)
  if (!buf) return undefined
  return { path: rel, text: buf.subarray(0, MAX_CONTRACT_BYTES).toString('utf8'), truncated: buf.length > MAX_CONTRACT_BYTES, humanReviewRequired: contractBlock(buf.toString('utf8'), 'human_review') !== undefined }
}

/** Changes of a task worktree relative to where it branched off the repository HEAD, plus untracked files. */
async function listChanges(root: string, wt: string, exec: Exec): Promise<Changes> {
  if (!(await exists(wt))) return { tracked: [], untracked: [] }
  const head = await exec('git', ['-C', root, 'rev-parse', 'HEAD'])
  if (head.code !== 0) return { tracked: [], untracked: [] }
  const mergeBase = await exec('git', ['-C', wt, 'merge-base', 'HEAD', head.stdout.trim()])
  if (mergeBase.code !== 0) return { tracked: [], untracked: [] }
  const base = mergeBase.stdout.trim()
  const [tracked, untracked] = await Promise.all([
    exec('git', ['-C', wt, 'diff', '--name-status', '--no-renames', base]),
    exec('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard']),
  ])
  const status = new Map<string, FileStatus>()
  for (const line of tracked.code === 0 ? tracked.stdout.split('\n').filter(Boolean) : []) {
    const [code, ...path] = line.split('\t')
    const known = fileStatus(code)
    if (known && path.length) status.set(path.join('\t'), known)
  }
  const added = untracked.code === 0 ? lines(untracked.stdout) : []
  for (const path of added) status.set(path, 'A')
  return { base, tracked: [...status.keys()].filter((path) => !added.includes(path)), untracked: added, status }
}

/** Once the base contains a task merge, diffing the live copy against that base becomes empty. The recorded
 * merge commit's first parent is the base immediately before this task landed, excluding unrelated earlier work. */
async function mergedHandoffChanges(root: string, task: Task, exec: Exec): Promise<Changes | undefined> {
  const merged = task.merged
  if (!merged?.mergeCommit || !merged.commit || merged.commit !== task.check?.commit) return undefined
  const diff = await exec('git', ['-C', root, 'diff', '--name-status', '--no-renames', `${merged.mergeCommit}^1`, merged.mergeCommit])
  if (diff.code !== 0) return undefined
  const status = new Map<string, FileStatus>()
  for (const line of diff.stdout.split('\n').filter(Boolean)) {
    const [code, ...parts] = line.split('\t')
    const known = fileStatus(code)
    if (known && parts.length) status.set(parts.join('\t'), known)
  }
  return { tracked: [...status.keys()], untracked: [], status }
}

/** Whether `into` is the HEAD commit of a detached checkout rather than a branch (mk1). */
async function detachedAt(root: string, into: string, exec: Exec): Promise<boolean> {
  if (await checkedOutBranch(root, exec)) return false
  if ((await exec('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${into}`])).code === 0) return false
  const head = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.code === 0 && head.stdout.trim() === into
}

export async function getTaskDetail(root: string, taskId: string, backends: Backends, exec: Exec, planId?: string): Promise<TaskDetail> {
  const plan = await loadPlan(root, planId)
  const source = backendsForPlan(plan, root, backends)
  const exampleStates = Object.fromEntries(plan.example ? plan.tasks.flatMap((task) => task.runs.filter((run) => !run.finishedAt).map((run) => [run.runId, { status: 'running', terminal: false, exitCode: null }])) : [])
  const view = deriveViews(plan, exampleStates).find((v) => v.task.id === taskId)
  if (!view) throw new DetailError('unknown_task', { id: taskId })
  const task = view.task
  const run = task.runs.at(-1)
  const evidence = await readEvidence(root, run?.evidence)
  // A finished run's evidence holds the report and files, not the steps: the feed still comes from the run's events
  // (B12), so Activity shows what the worker did. A backend that no longer has them leaves the feed empty.
  let raw: RawEvent[] = []
  if (run) {
    try {
      const backend = await source.forAgent(run.agent, run.runId)
      raw = await backend.events(run.runId)
    } catch {
      raw = []
    }
  }
  const completed = [...task.runs].reverse().find((r) => r.outcome === 'completed')
  const reportEvidence = completed?.runId === run?.runId ? evidence : await readEvidence(root, completed?.evidence)
  const handoff = run?.outcome === 'incomplete' && task.check?.state === 'checked' && task.check.runId === run.runId && task.check.report && task.check.commit
  const handoffPath = handoff ? insideRoot(root, task.check!.report!) : undefined
  const handoffText = handoffPath ? await readFile(handoffPath, 'utf8').catch(() => undefined) : undefined
  const report: RunReport | undefined = handoffText ? { runId: run!.runId, text: handoffText, source: 'orchestrator', truncated: false }
    : task.kind === 'root' || task.kind === 'decision' ? await readOwnReport(root, task) : reportEvidence ? reportEvidence.report : await readReport(task.runs, run?.runId, raw, source)
  const liveCopyAvailable = task.worktree ? await exists(task.worktree.path) : undefined
  const changes = handoffText || !evidence ? (handoffText ? await mergedHandoffChanges(root, task, exec) : undefined) ?? (task.worktree && liveCopyAvailable ? await listChanges(root, task.worktree.path, exec) : { tracked: [], untracked: [] }) : undefined
  const livePaths = [...(changes?.tracked ?? []), ...(changes?.untracked ?? [])]
  // The recorded run's files remain useful if a task reached the base by another path and its merge diff is empty.
  const fallbackPaths = handoffText && task.merged && livePaths.length === 0 ? evidence?.files.map((file) => file.path) ?? [] : []
  const changedPaths = evidence && !handoffText ? evidence.files.map((file) => file.path) : [...new Set([...livePaths, ...fallbackPaths])].sort()
  const contract = await readContract(root, task.contract)
  const runContractPath = run?.contractPath ?? task.contract
  const runContract = runContractPath === task.contract ? contract : await readContract(root, runContractPath)
  const workerClaimProjection = evidence?.finalAnswerState === 'reported' && evidence.finalAnswer?.trim() && runContract
    ? projectWorkerCheckClaims(evidence.finalAnswer, evidence.capturedAt, requiredChecks(runContract.text))
    : undefined
  const currentGit = task.worktree && !plan.example && liveCopyAvailable ? {
    head: (await exec('git', ['-C', task.worktree.path, 'rev-parse', 'HEAD'])).stdout.trim() || undefined,
    uncommitted: await uncommittedCount(task.worktree.path, exec), observedAt: new Date().toISOString(),
  } : undefined
  const resultAttestation = await inspectAttestation(root, task, exec)
  const baseline = task.worktree && (await exists(task.worktree.path)) ? (await readWorktreeState(task.worktree.path))?.baseline : undefined
  // What the run left uncommitted is a fact of its evidence; without evidence (an older run) the copy is asked now.
  const uncommitted = handoffText || !evidence ? task.worktree && !plan.example && liveCopyAvailable ? await uncommittedCount(task.worktree.path, exec) : undefined : evidence.uncommitted
  // Where Merge takes it (mg1): the copy's recorded base, else the checked-out branch.
  const into = view.unmerged ? (task.worktree ? await taskBase(root, task.worktree, exec) : undefined) ?? (await baseBranch(root, exec)) : undefined
  // bs1: a copy whose recorded base no longer matches the repository's default — a person chose one on
  // purpose, or the default moved on since — is worth a notice, once, wherever the base is shown.
  const defaultBase = task.worktree?.base && !plan.example ? (await resolveDefaultBase(root, exec, { planId, plan })).branch : undefined
  const baseDrift = defaultBase && task.worktree?.base && defaultBase !== task.worktree.base ? { base: task.worktree.base, default: defaultBase, path: task.worktree.path } : undefined
  const detail: Omit<TaskDetail, 'verdict'> = {
    id: task.id,
    ...(plan.example ? { example: true } : {}),
    title: task.title,
    kind: task.kind,
    ...(task.class ? { class: task.class } : {}),
    status: view.status,
    ...(task.lane ? { lane: task.lane } : {}),
    deps: task.deps,
    dependents: plan.tasks.filter((t) => t.deps.includes(task.id)).map((t) => t.id),
    ...(view.status === 'blocked' && view.blockedBy.length ? { blockedBy: view.blockedBy } : {}),
    ...(view.waitingMerge?.length ? { waitingMerge: view.waitingMerge } : {}),
    ...(task.worker ? { worker: task.worker } : {}),
    ...(task.check ? { check: task.check } : {}),
    ...(resultAttestation ? { resultAttestation } : {}),
    ...(currentGit ? { currentGit } : {}),
    ...(liveCopyAvailable !== undefined ? { liveCopyAvailable } : {}),
    ...(task.merged ? { merged: task.merged } : {}),
    ...(task.worktree ? { worktree: { ...task.worktree, ...(baseline ? { baseline } : {}) } } : {}),
    ...(contract ? { contract } : {}),
    runs: task.runs,
    notes: task.notes,
    steers: run ? await listSteers(join(root, CREWBOARD_DIR, 'runs', run.runId)) : [],
    events: normalize(raw).slice(-MAX_EVENTS),
    changedFiles: changedPaths,
    files: evidence && !handoffText ? evidence.files : changedPaths.map((path) => {
      const status = changes?.status?.get(path)
      return { path, added: null, deleted: null, ...(status ? { status } : {}) }
    }),
    ...(evidence ? { evidence } : {}),
    ...(workerClaimProjection ? { workerClaimProjection } : {}),
    ...(report ? { report } : {}),
    ...(uncommitted ? { uncommitted } : {}),
    ...(lastDecisionOf(task) ? { lastDecision: lastDecisionOf(task) } : {}),
    ...(into && task.worktree ? { merge: { into, branch: task.worktree.branch, path: task.worktree.path, commands: mergeCommands({ root, taskId: task.id, ...task.worktree, uncommitted: await uncommittedCount(task.worktree.path, exec) }), ...((await detachedAt(root, into, exec)) ? { detached: { root } } : {}) } } : {}),
    ...(baseDrift ? { baseDrift } : {}),
  }
  const acceptedVerdict = task.status === 'accepted' ? task.notes.filter((note) => note.type === 'accept').at(-1)?.verdict?.kind : undefined
  return detail.kind === 'decision' ? detail : { ...detail, verdict: acceptedVerdict === 'result'
    ? { kind: 'result', claim: 'result', facts: changedPaths.length ? [{ code: 'files_changed', count: changedPaths.length, tone: 'ok' }] : [] }
    : acceptedVerdict === 'negative' ? { kind: 'negative', claim: 'negative', why: 'negative', facts: [] }
    : acceptedVerdict === 'disputed' ? { kind: 'disputed', mismatch: 'claim_missing', facts: [] }
    : detail.resultAttestation?.freshness === 'current' && detail.resultAttestation.proof !== undefined
      ? attestedVerdict(detail.resultAttestation.record.verdict, detail.resultAttestation.proof)
      : verdictOf(detail) }
}

/**
 * The verdict of a worker's finished task from its recorded evidence alone (vc1): what the card, Work, Needs you
 * and `attention` show without reading the run's events or the copy. Undefined when the evidence is missing — an
 * older run, or a report the evidence of the last completed run does not hold — rather than a verdict that
 * would read differently from the task panel's.
 */
export async function verdictFromEvidence(root: string, task: Pick<Task, 'id' | 'title' | 'kind' | 'deps' | 'runs' | 'worktree' | 'resultAttestations' | 'status' | 'merged' | 'notes' | 'contract'> & Partial<Pick<Task, 'check'>>): Promise<Verdict | undefined> {
  if (isOwnWork(task.kind)) return undefined
  const acceptedVerdict = task.status === 'accepted' ? task.notes.filter((note) => note.type === 'accept').at(-1)?.verdict?.kind : undefined
  if (acceptedVerdict) {
    const evidence = await readEvidence(root, task.runs.at(-1)?.evidence)
    const facts = evidence?.files.length ? [{ code: 'files_changed' as const, count: evidence.files.length, tone: 'ok' as const }] : []
    if (acceptedVerdict === 'result') return { kind: 'result', claim: 'result', facts }
    if (acceptedVerdict === 'negative') return { kind: 'negative', claim: 'negative', why: 'negative', facts }
    return { kind: 'disputed', mismatch: 'claim_missing', facts }
  }
  const attestation = await inspectAttestation(root, task, nodeExec)
  if (attestation?.freshness === 'current' && attestation.proof !== undefined) return attestedVerdict(attestation.record.verdict, attestation.proof)
  const run = task.runs.at(-1)
  const evidence = await readEvidence(root, run?.evidence)
  if (!run || !evidence) return undefined
  const completed = [...task.runs].reverse().find((r) => r.outcome === 'completed')
  const reportEvidence = !completed || completed.runId === run.runId ? evidence : await readEvidence(root, completed.evidence)
  if (completed && !reportEvidence) return undefined
  const report = completed ? reportEvidence?.report : undefined
  const handoff = run.outcome === 'incomplete' && task.check?.state === 'checked' && task.check.runId === run.runId && task.check.report && task.check.commit
  const handoffPath = handoff ? insideRoot(root, task.check!.report!) : undefined
  const handoffText = handoffPath ? await readFile(handoffPath, 'utf8').catch(() => undefined) : undefined
  const contract = await readContract(root, run.contractPath ?? task.contract)
  const workerClaimProjection = reportEvidence?.finalAnswerState === 'reported' && reportEvidence.finalAnswer?.trim() && contract
    ? projectWorkerCheckClaims(reportEvidence.finalAnswer, reportEvidence.capturedAt, requiredChecks(contract.text))
    : undefined
  return verdictOf({
    id: task.id, title: task.title, kind: task.kind, status: 'in_review', deps: task.deps, dependents: [], runs: task.runs, notes: [], steers: [], events: [],
    changedFiles: evidence.files.map((file) => file.path), evidence, ...(workerClaimProjection ? { workerClaimProjection } : {}),
    ...(handoffText ? { report: { runId: run.runId, text: handoffText, source: 'orchestrator' as const, truncated: false }, check: task.check } : report ? { report } : {}),
    ...(!handoffText && evidence.uncommitted ? { uncommitted: evidence.uncommitted } : {}),
  })
}

/**
 * The orchestrator's report of a root task or a decision (rt1): the stored `--report` file, else — for a
 * root task, whose note is its only account of the work — the `verify --done` note. A decision's note
 * carries options and a recommendation, not a report of work, so alone it makes no report.
 */
async function readOwnReport(root: string, task: Task): Promise<RunReport | undefined> {
  const check = task.check?.state === 'checked' ? task.check : undefined
  if (!check) return undefined
  const abs = check.report ? insideRoot(root, check.report) : undefined
  const stored = abs ? await readFile(abs, 'utf8').catch(() => undefined) : undefined
  const text = stored ?? (task.kind === 'root' ? check.note : undefined)
  if (!text?.trim()) return undefined
  return { ...extractReport('', text, MAX_CONTRACT_BYTES), source: 'orchestrator' }
}

/**
 * The report of the last completed run, taken from the same raw events as the feed. When the completed
 * run is not the last one its events are read separately; a backend error simply leaves the report out. A reply to a
 * direction queued after the report is not the report (vr2).
 */
async function readReport(runs: Run[], lastRunId: string | undefined, lastRaw: RawEvent[], backends: Backends): Promise<RunReport | undefined> {
  const completed = [...runs].reverse().find((r) => r.outcome === 'completed')
  if (!completed) return undefined
  let raw: RawEvent[]
  if (completed.runId === lastRunId) {
    raw = lastRaw
  } else {
    try {
      raw = await (await backends.forAgent(completed.agent, completed.runId)).events(completed.runId)
    } catch {
      return undefined
    }
  }
  const { text } = reportedAnswer(raw)
  return text ? extractReport(completed.runId, text) : undefined
}

/** Diff of one changed file; any file outside the task's change list is refused (no path traversal). */
export async function getTaskDiff(root: string, taskId: string, file: string, exec: Exec): Promise<string> {
  const plan = await loadPlan(root)
  const task = plan.tasks.find((t) => t.id === taskId)
  if (!task) throw new DetailError('unknown_task', { id: taskId })
  if (plan.example) {
    const evidence = await readEvidence(root, task.runs.at(-1)?.evidence)
    if (!evidence?.files.some((item) => item.path === file)) throw new DetailError('unknown_file', { file })
    if (file.endsWith('.png')) return file
    return (await readFile(exampleFilePath(root, taskId, file), 'utf8')).trimEnd().split('\n').map((line) => `+${line}`).join('\n') + '\n'
  }
  if (!task.worktree) throw new DetailError('no_worktree', { id: taskId })
  const wt = task.worktree.path
  const { base, tracked, untracked } = await listChanges(root, wt, exec)
  let out: string
  if (base && tracked.includes(file)) out = (await exec('git', ['-C', wt, 'diff', base, '--', file])).stdout
  else if (untracked.includes(file)) out = (await exec('git', ['-C', wt, 'diff', '--no-index', '--', '/dev/null', file])).stdout
  else throw new DetailError('unknown_file', { file })
  return out.length > MAX_DIFF_CHARS ? `${out.slice(0, MAX_DIFF_CHARS)}\n… (обрезано)` : out
}
