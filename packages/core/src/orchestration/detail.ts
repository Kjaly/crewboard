import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import { type ViewStatus, deriveViews } from '../plan/graph.js'
import type { Note, Run, Task } from '../plan/schema.js'
import { loadPlan } from '../plan/store.js'
import type { RawEvent } from '../runs/raw-event.js'
import { type NormEvent, normalize } from '../runs/normalize.js'
import { type RunReport, extractReport, finalMessage } from '../runs/report.js'
import { readEvidence, type RunEvidence } from '../runs/evidence.js'
import type { Backends } from './backends.js'
import { verdictOf, type Verdict } from './verdict.js'
import { backendsForPlan } from '../runs/example-backend.js'
import { exampleFilePath } from '../plan/example.js'
import { listSteers, type SteerRecord } from '../runs/steers.js'
import { join } from 'node:path'
import { CREWBOARD_DIR } from '../plan/store.js'
import { type MessageVars, orchText } from './messages.js'
import { type BaselineRecord, readWorktreeState } from '../worktree/state.js'

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
  status: ViewStatus
  lane?: string
  deps: string[]
  dependents: string[]
  worker?: string
  /** `baseline` is the copy's last baseline run (worktree/state.ts); absent when none is on record. */
  worktree?: { path: string; branch: string; baseline?: BaselineRecord }
  contract?: { path: string; text: string; truncated: boolean }
  runs: Run[]
  notes: Note[]
  steers: SteerRecord[]
  events: NormEvent[]
  changedFiles: string[]
  report?: RunReport
  evidence?: RunEvidence
  verdict: Verdict
  example?: boolean
}

type Changes = { base?: string; tracked: string[]; untracked: string[] }

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
  return { path: rel, text: buf.subarray(0, MAX_CONTRACT_BYTES).toString('utf8'), truncated: buf.length > MAX_CONTRACT_BYTES }
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
    exec('git', ['-C', wt, 'diff', '--name-only', base]),
    exec('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard']),
  ])
  return {
    base,
    tracked: tracked.code === 0 ? lines(tracked.stdout) : [],
    untracked: untracked.code === 0 ? lines(untracked.stdout) : [],
  }
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
  let raw: RawEvent[] = []
  if (run && !evidence) {
    try {
      const backend = await source.forAgent(run.agent, run.runId)
      raw = await backend.events(run.runId)
    } catch {
      raw = []
    }
  }
  // Example runs keep their synthetic events even with evidence, so the feed shows what the worker did.
  if (run && evidence && plan.example) raw = await (await source.forAgent(run.agent, run.runId)).events(run.runId)
  const completed = [...task.runs].reverse().find((r) => r.outcome === 'completed')
  const reportEvidence = completed?.runId === run?.runId ? evidence : await readEvidence(root, completed?.evidence)
  const report = reportEvidence ? reportEvidence.report : await readReport(task.runs, run?.runId, raw, source)
  const changes = evidence ? undefined : task.worktree ? await listChanges(root, task.worktree.path, exec) : { tracked: [], untracked: [] }
  const contract = await readContract(root, task.contract)
  const baseline = task.worktree && (await exists(task.worktree.path)) ? (await readWorktreeState(task.worktree.path))?.baseline : undefined
  const detail: Omit<TaskDetail, 'verdict'> = {
    id: task.id,
    ...(plan.example ? { example: true } : {}),
    title: task.title,
    kind: task.kind,
    status: view.status,
    ...(task.lane ? { lane: task.lane } : {}),
    deps: task.deps,
    dependents: plan.tasks.filter((t) => t.deps.includes(task.id)).map((t) => t.id),
    ...(task.worker ? { worker: task.worker } : {}),
    ...(task.worktree ? { worktree: { ...task.worktree, ...(baseline ? { baseline } : {}) } } : {}),
    ...(contract ? { contract } : {}),
    runs: task.runs,
    notes: task.notes,
    steers: run ? await listSteers(join(root, CREWBOARD_DIR, 'runs', run.runId)) : [],
    events: normalize(raw).slice(-MAX_EVENTS),
    changedFiles: evidence ? evidence.files.map((file) => file.path) : [...new Set([...(changes?.tracked ?? []), ...(changes?.untracked ?? [])])].sort(),
    ...(evidence ? { evidence } : {}),
    ...(report ? { report } : {}),
  }
  return { ...detail, verdict: verdictOf(detail) }
}

/**
 * The report of the last completed run, taken from the same raw events as the feed. When the completed
 * run is not the last one its events are read separately; a backend error simply leaves the report out.
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
  const text = finalMessage(raw)
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
