import { mkdir, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { deriveViews, isOwnWork } from '../plan/graph.js'
import type { Plan, Task } from '../plan/schema.js'
import { eventNote } from '../plan/notes.js'
import { CREWBOARD_DIR, ExamplePlanError, currentPlanId, loadPlan, updatePlan } from '../plan/store.js'
import type { Exec } from '../exec.js'
import { nodeExec } from '../exec.js'
import type { Backends } from './backends.js'
import { getTaskDetail } from './detail.js'
import type { LaunchResult } from './launch.js'
import type { Verdict } from './verdict.js'
import { claimOf, claimLineOf, requiredChecks } from './verdict.js'
import { uncommittedCount } from '../worktree/merged.js'
import { readCrewboardChecks } from '../runs/checks-run.js'
import { readFile } from 'node:fs/promises'
import { type RelaunchOptions, relaunchTask } from './relaunch.js'

/**
 * The orchestrator's check of finished work (vr1): a finished task first goes to the plan's orchestrating
 * agent, and only its «checked» hands the task to the person. Agents may take, finish and return a check;
 * routine accepted work may be closed by the orchestrator after the automatic gates pass (auto-close.ts).
 *
 * Root tasks and decisions (rt1) have no worker run: `start` takes a root task in work, and `verify --done`
 * is the orchestrator's «done» — the root task goes to review, the decision counts as prepared — with an
 * optional markdown report stored beside the plan.
 */

export class CheckError extends Error {
  constructor(
    readonly code: 'unknown_task' | 'not_in_review' | 'no_note' | 'own_work' | 'not_root' | 'not_ready' | 'closed' | 'report_for_worker' | 'handoff_not_ready' | 'attestation_not_ready' | 'attestation_claim_mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'CheckError'
  }
}

export type AttestationVerdict = 'result' | 'negative' | 'disputed'
const attestationReportRef = (planId: string, taskId: string, runId: string) => `${CREWBOARD_DIR}/reports/${planId}/${taskId}-${runId}-attestation.md`

/** Record a separate orchestrator judgement against the current completed run and observed worktree facts. */
export async function attestResult(root: string, taskId: string, verdict: AttestationVerdict, report: string, note: string, now: Date, o: CheckOptions & { by: 'orchestrator' }): Promise<Task> {
  if (!['result', 'negative', 'disputed'].includes(verdict)) throw new CheckError('attestation_not_ready', 'Unknown attestation verdict')
  if (!note.trim() || !report.trim()) throw new CheckError('no_note', 'A report and a short attestation note are required')
  const claimLine = claimLineOf(report)
  const primaryClaim = claimLine ? claimLine.match(/^\s*(?:[-*+•]\s*)?(?:результат|result|ergebnis|résultat|resultat|resultado|risultato|wynik)\s*:\s*(.*)$/iu)?.[1]?.trim().split(/[\s.!?;,]/u, 1)[0]?.toLocaleLowerCase('ru') : undefined
  const compatibleClaim = verdict === 'result' ? claimOf(claimLine) === 'result'
    : verdict === 'negative' ? claimOf(claimLine) === 'negative' || claimOf(claimLine) === 'blocked'
    : primaryClaim === 'disputed' || primaryClaim === 'спорный' || primaryClaim === 'спорно'
  if (!compatibleClaim) throw new CheckError('attestation_claim_mismatch', `The report's primary Result claim does not match verdict=${verdict}`)
  const planId = o.planId ?? currentPlanId(root)
  const before = await loadPlan(root, planId)
  const task = before.tasks.find((item) => item.id === taskId)
  const run = task?.runs.at(-1)
  const wt = task?.worktree?.path
  if (!task || task.kind === 'root' || task.kind === 'decision' || before.tasks.find((item) => item.id === taskId)?.status !== 'in_review' || !run || run.outcome !== 'completed' || !run.finishedAt || !run.evidence || !wt || o.by !== 'orchestrator')
    throw new CheckError('attestation_not_ready', `Only a completed worker run in review can be attested: ${taskId}`)
  const contractPath = run.contractPath ?? task.contract
  if (!contractPath) throw new CheckError('attestation_not_ready', 'The run has no identified contract path')
  const contractAbs = resolve(root, contractPath)
  const contractRel = relative(root, contractAbs)
  if (!contractRel || contractRel.startsWith('..') || isAbsolute(contractRel)) throw new CheckError('attestation_not_ready', 'The run contract path must stay inside the repository')
  const contract = await readFile(contractAbs, 'utf8').catch(() => undefined)
  const revision = contract === undefined ? undefined : createHash('sha256').update(contract).digest('hex')
  if (!contract || !revision) throw new CheckError('attestation_not_ready', 'The current contract revision cannot be identified')
  const headResult = await nodeExec('git', ['-C', wt, 'rev-parse', 'HEAD'])
  const head = headResult.code === 0 ? headResult.stdout.trim() : ''
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new CheckError('attestation_not_ready', 'Cannot identify the current worktree HEAD')
  if (verdict === 'result' && await uncommittedCount(wt, nodeExec) !== 0) throw new CheckError('attestation_not_ready', 'A positive attestation requires a clean committed worktree')
  const required = requiredChecks(contract)
  const assertReceipts = async () => {
    if (verdict !== 'result' || required.length === 0) return
    const receipts = await readCrewboardChecks(root, run.runId)
    if (!receipts || receipts.runId !== run.runId || receipts.worktree !== wt || receipts.commit !== head || receipts.contractPath !== contractPath || receipts.contractRevision !== revision || receipts.checks.length !== required.length || receipts.checks.some((item, index) => item.command !== required[index] || item.exitCode !== 0 || item.timedOut))
      throw new CheckError('attestation_not_ready', 'Positive attestation requires passing current receipts for every mandatory contract check')
  }
  await assertReceipts()
  const storedProof = report.endsWith('\n') ? report : `${report}\n`
  const proofHash = createHash('sha256').update(storedProof).digest('hex')
  const reportHash = proofHash.slice(0, 16)
  const ref = attestationReportRef(planId, taskId, run.runId).replace(/\.md$/, `-${reportHash}-${now.getTime()}-${randomUUID()}.md`)
  await storeReport(root, ref, report)
  const checkedAt = now.toISOString()
  // Refresh every external fact directly before the plan CAS; earlier CLI checks may have gone stale.
  const freshHead = await nodeExec('git', ['-C', wt, 'rev-parse', 'HEAD'])
  const freshContract = await readFile(contractAbs, 'utf8').catch(() => undefined)
  if (freshHead.code !== 0 || freshHead.stdout.trim() !== head || !freshContract || createHash('sha256').update(freshContract).digest('hex') !== revision || (verdict === 'result' && await uncommittedCount(wt, nodeExec) !== 0))
    throw new CheckError('attestation_not_ready', 'HEAD, worktree cleanliness or contract changed during attestation')
  await assertReceipts()
  const saved = await updatePlan(root, (planValue) => {
    const current = planValue.tasks.find((item) => item.id === taskId)
    if (planValue.rev !== before.rev || !current || current.status !== 'in_review' || current.runs.at(-1)?.runId !== run.runId || current.runs.at(-1)?.outcome !== 'completed') throw new CheckError('attestation_not_ready', 'The plan or latest run changed during attestation')
    const attestation = { verdict, report: ref, proofHash, by: 'orchestrator' as const, runId: run.runId, checkedAt, head, contractPath, contractRevision: revision }
    current.resultAttestations ??= []
    current.resultAttestations.push(attestation)
    current.notes.push(eventNote(checkedAt, 'check', { kind: 'result_attested', verdict, report: ref, proofHash: attestation.proofHash, runId: run.runId, head, contractRevision: revision, by: 'orchestrator' }))
    return planValue
  }, 5, planId)
  return saved.tasks.find((item) => item.id === taskId) as Task
}

type CheckOptions = { planId?: string; by?: string }

const ownWorkError = (taskId: string) => new CheckError('own_work', `Task ${taskId} has no worker run: finish it with verify ${taskId} --done --note "…" / У задачи ${taskId} нет запуска воркера: завершите её через verify ${taskId} --done --note "…"`)

function viewOf(plan: Plan, taskId: string) {
  if (plan.example) throw new ExamplePlanError()
  const view = deriveViews(plan).find((v) => v.task.id === taskId)
  if (!view) throw new CheckError('unknown_task', `Unknown task ${taskId} / Нет задачи ${taskId}`)
  return view
}

/** Only finished work in review can be checked: not a running, accepted or never-run task. */
function reviewedTask(plan: Plan, taskId: string): Task {
  const view = viewOf(plan, taskId)
  if (isOwnWork(view.task.kind)) throw ownWorkError(taskId)
  if (view.status !== 'in_review') throw new CheckError('not_in_review', `Task ${taskId} is not waiting for review (${view.status}) / Задача ${taskId} не ждёт проверки (${view.status})`)
  return view.task
}

/**
 * `task set --kind` (rt1): an open task changes kind — a decision that is really the orchestrator's own
 * work becomes `root` without being re-created. Accepted and superseded tasks keep theirs: they were judged
 * as that kind. What belonged to the old kind — «in work by the orchestrator», the orchestrator's «done» on
 * work no worker ran — does not carry over; a root task in review goes back to ready.
 */
export function setTaskKind(task: Task, kind: Task['kind']): void {
  if (task.status === 'accepted' || task.status === 'superseded' || task.status === 'dropped') throw new CheckError('closed', `Task ${task.id} is ${task.status}: the kind of a closed task does not change / Задача ${task.id} — ${task.status}: тип закрытой задачи не меняется`)
  if (task.kind === kind) return
  delete task.started
  if (isOwnWork(task.kind) && task.check && !task.check.runId) delete task.check
  if (task.kind === 'root' && task.status === 'in_review' && task.runs.length === 0) task.status = 'ready'
  task.kind = kind
}

/** Where a root task's or a decision's report is kept, relative to the repository. */
export const ownReportRef = (planId: string, taskId: string) => `${CREWBOARD_DIR}/reports/${planId}/${taskId}.md`
const handoffReportRef = (planId: string, taskId: string, runId: string) => `${CREWBOARD_DIR}/reports/${planId}/${taskId}-${runId}-handoff.md`

/** `crewboard start <id>`: the orchestrator takes a ready root task in work. Starting it again is a no-op. */
export async function startOwnWork(root: string, taskId: string, now: Date, o: CheckOptions = {}): Promise<Task> {
  const saved = await updatePlan(root, (plan) => {
    const view = viewOf(plan, taskId)
    if (view.task.kind !== 'root') throw new CheckError('not_root', `Task ${taskId} is not the orchestrator's own work (kind ${view.task.kind}) / Задача ${taskId} — не собственная работа оркестратора (тип ${view.task.kind})`)
    if (view.status === 'accepted' || view.status === 'closed' || view.status === 'superseded' || view.status === 'dropped') throw new CheckError('closed', `Task ${taskId} is closed (${view.status}) / Задача ${taskId} закрыта (${view.status})`)
    if (view.status === 'running') return plan
    // Accepted but unmerged dependencies are named as such (w1d): the base does not contain their work yet.
    const merge = view.waitingMerge?.length ? `; not merged yet: ${view.waitingMerge.join(', ')}` : ''
    const mergeRu = view.waitingMerge?.length ? `; ещё не слиты: ${view.waitingMerge.join(', ')}` : ''
    if (view.status !== 'ready') throw new CheckError('not_ready', `Task ${taskId} cannot be started (${view.status}${view.blockedBy.length ? `: ${view.blockedBy.join(', ')}` : ''}${merge}) / Задачу ${taskId} нельзя начать (${view.status}${view.blockedBy.length ? `: ${view.blockedBy.join(', ')}` : ''}${mergeRu})`)
    const task = plan.tasks.find((t) => t.id === taskId) as Task
    task.started = { at: now.toISOString(), ...(o.by ? { by: o.by } : {}) }
    task.status = 'ready'
    delete task.check
    task.notes.push(eventNote(now.toISOString(), 'comment', { kind: 'started', ...(o.by ? { by: o.by } : {}) }))
    return plan
  }, 5, o.planId)
  return saved.tasks.find((t) => t.id === taskId) as Task
}

async function storeReport(root: string, ref: string, text: string): Promise<void> {
  const file = join(root, ref)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, text.endsWith('\n') ? text : `${text}\n`)
  await rename(tmp, file)
}

/**
 * `verify <id> --done` on a root task or a decision: the root task's work is finished and goes to review,
 * the decision is prepared and may reach the person. A later `--done` replaces the note and the report.
 */
async function finishOwnWork(root: string, taskId: string, note: string, now: Date, o: CheckOptions & { report?: string }): Promise<Task> {
  const planId = o.planId ?? currentPlanId(root)
  const before = viewOf(await loadPlan(root, planId), taskId)
  const ref = o.report !== undefined ? ownReportRef(planId, taskId) : undefined
  const assertOpen = (view: ReturnType<typeof viewOf>) => {
    if (view.status === 'accepted' || view.status === 'closed' || view.status === 'superseded' || view.status === 'dropped') throw new CheckError('closed', `Task ${taskId} is closed (${view.status}) / Задача ${taskId} закрыта (${view.status})`)
    if (view.task.kind === 'root' && view.status !== 'ready' && view.status !== 'running' && view.status !== 'in_review') throw new CheckError('not_ready', `Task ${taskId} cannot be finished (${view.status}${view.blockedBy.length ? `: ${view.blockedBy.join(', ')}` : ''}) / Задачу ${taskId} нельзя завершить (${view.status}${view.blockedBy.length ? `: ${view.blockedBy.join(', ')}` : ''})`)
  }
  assertOpen(before)
  if (ref) await storeReport(root, ref, o.report as string)
  const at = now.toISOString()
  const saved = await updatePlan(root, (plan) => {
    const view = viewOf(plan, taskId)
    assertOpen(view)
    const task = plan.tasks.find((t) => t.id === taskId) as Task
    const report = ref ?? (task.check?.state === 'checked' ? task.check.report : undefined)
    task.check = { state: 'checked', at, ...(o.by ? { by: o.by } : {}), note, ...(report ? { report } : {}) }
    task.notes.push(eventNote(at, 'check', { kind: 'checked', ...(o.by ? { by: o.by } : {}), note }))
    if (task.kind === 'root' && task.status !== 'in_review') {
      task.status = 'in_review'
      task.started ??= { at, ...(o.by ? { by: o.by } : {}) }
      if (!task.reviewIntervals?.some((i) => !i.decidedAt)) {
        task.reviewIntervals ??= []
        task.reviewIntervals.push({ id: `review:${task.id}:${at}`, enteredAt: at, source: 'human', association: 'task_only' })
      }
    }
    return plan
  }, 5, planId)
  return saved.tasks.find((t) => t.id === taskId) as Task
}

/** The orchestrator already checked the task's last run: its «checked» stands until a new run or `--reopen`. */
const isChecked = (task: Task): boolean => task.check?.state === 'checked' && task.check.runId === task.runs.at(-1)?.runId

async function writeCheck(root: string, taskId: string, now: Date, o: CheckOptions & { reopen?: boolean }, state: 'checking' | 'checked', note?: string): Promise<Task> {
  const saved = await updatePlan(root, (plan) => {
    reviewedTask(plan, taskId)
    const task = plan.tasks.find((t) => t.id === taskId) as Task
    if (state === 'checking' && !o.reopen && isChecked(task)) return plan
    const runId = task.runs.at(-1)?.runId
    task.check = { state, ...(runId ? { runId } : {}), at: now.toISOString(), ...(o.by ? { by: o.by } : {}), ...(note ? { note } : {}) }
    task.notes.push(eventNote(now.toISOString(), 'check', state === 'checking' ? { kind: 'check_taken', ...(o.by ? { by: o.by } : {}) } : { kind: 'checked', ...(o.by ? { by: o.by } : {}), note: note ?? '' }))
    return plan
  }, 5, o.planId)
  return saved.tasks.find((t) => t.id === taskId) as Task
}

/**
 * `orch verify <id>`: the orchestrator takes the finished task for checking. Taking checked work again is a
 * no-op (B10): the task keeps its «checked» and stays with the person — the returned task says so by its
 * `check.state`. Only `reopen` takes it back from the person's queue.
 */
export async function takeCheck(root: string, taskId: string, now: Date, o: CheckOptions & { reopen?: boolean } = {}): Promise<Task> {
  if (!o.reopen) {
    const task = reviewedTask(await loadPlan(root, o.planId), taskId)
    if (isChecked(task)) return task
  }
  return writeCheck(root, taskId, now, o, 'checking')
}

/**
 * An older run can finish with a report and preserved files but be marked incomplete solely because the
 * runner asked for a worker commit or failed to extract a claim from a substantive answer. The orchestrator
 * may take that preserved copy without launching a second worker. The run stays incomplete, and the check
 * stays `checking`: neither completion nor human acceptance is implied. A positive orchestrator report,
 * a clean committed copy and the normal gates are still required before closure.
 */
export async function takeUncommittedForCheck(root: string, taskId: string, note: string, now: Date, o: CheckOptions = {}): Promise<Task> {
  if (!note.trim()) throw new CheckError('no_note', 'A reason for taking the copy is required / Нужна причина передачи копии оркестратору')
  const saved = await updatePlan(root, (plan) => {
    const view = viewOf(plan, taskId)
    const task = view.task
    const run = task.runs.at(-1)
    if (view.status !== 'ready' || run?.outcome !== 'incomplete' || (run.incomplete?.reason !== 'left_uncommitted' && run.incomplete?.reason !== 'no_claim') || !run.evidence || !run.incomplete.uncommitted)
      throw new CheckError('not_ready', `Task ${taskId} has no preserved incomplete run with uncommitted work to take / У задачи ${taskId} нет сохранённого незавершённого запуска с незакоммиченной работой`)
    const at = now.toISOString()
    task.status = 'in_review'
    task.check = { state: 'checking', runId: run.runId, at, ...(o.by ? { by: o.by } : {}), note: note.trim() }
    task.reviewIntervals ??= []
    task.reviewIntervals.push({ id: `review:${run.runId}:${at}`, enteredAt: at, runId: run.runId, source: 'human', association: 'exact' })
    task.notes.push(eventNote(at, 'check', { kind: 'check_taken', ...(o.by ? { by: o.by } : {}) }))
    return plan
  }, 5, o.planId)
  return saved.tasks.find((task) => task.id === taskId) as Task
}

/** What `verify --done` shows before a worker's task goes to the person (B10): the verdict and the changed files. */
export type DoneFacts = { verdict: Verdict; files: number; needsConfirm: boolean }

/**
 * The facts behind a worker's finished task, read the way the review screen reads them. `needsConfirm` —
 * the verdict is disputed or no file changed: marking it checked is then a deliberate choice. Work with no
 * worker run (a root task, a decision) and tasks not waiting for a check have none: `undefined`.
 */
export async function doneFacts(root: string, taskId: string, backends: Backends, exec: Exec, planId?: string): Promise<DoneFacts | undefined> {
  const view = deriveViews(await loadPlan(root, planId)).find((v) => v.task.id === taskId)
  if (!view || isOwnWork(view.task.kind) || view.status !== 'in_review') return undefined
  const detail = await getTaskDetail(root, taskId, backends, exec, planId)
  // Own work (decisions, root tasks) returned above; a worker's task always carries a verdict (w1b makes it optional).
  if (!detail.verdict) return undefined
  const files = detail.changedFiles.length
  return { verdict: detail.verdict, files, needsConfirm: detail.verdict.kind === 'disputed' || files === 0 }
}

/**
 * `orch verify <id> --done --note [--report]`: checked; the task now waits for the person, with the note
 * above the buttons. On a root task or a decision it is the orchestrator's «done» (rt1), `report` the
 * markdown text of its report; a worker's report is its own final answer, so `report` is refused there.
 */
export async function finishCheck(root: string, taskId: string, note: string, now: Date, o: CheckOptions & { report?: string } = {}): Promise<Task> {
  if (!note.trim()) throw new CheckError('no_note', 'A short summary of the check is required / Нужна короткая сводка проверки')
  const view = viewOf(await loadPlan(root, o.planId), taskId)
  if (isOwnWork(view.task.kind)) return finishOwnWork(root, taskId, note.trim(), now, o)
  if (o.report !== undefined) {
    const task = view.task
    const run = task.runs.at(-1)
    const copy = task.worktree?.path
    if (run?.outcome !== 'incomplete' || (run.incomplete?.reason !== 'left_uncommitted' && run.incomplete?.reason !== 'no_claim') || !run.evidence || !run.incomplete.uncommitted || task.check?.state !== 'checking' || task.check.runId !== run.runId || !copy)
      throw new CheckError('report_for_worker', `Only a preserved uncommitted run can receive an orchestrator final report / Только сохранённый незакоммиченный запуск может получить итоговый отчёт оркестратора`)
    if (claimOf(o.report) !== 'result' || await uncommittedCount(copy, nodeExec) !== 0)
      throw new CheckError('handoff_not_ready', `A positive report and a clean committed copy are required / Нужны положительный отчёт и чистая закоммиченная копия`)
    const head = await nodeExec('git', ['-C', copy, 'rev-parse', 'HEAD'])
    if (head.code !== 0 || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())) throw new CheckError('handoff_not_ready', 'Cannot identify the checked commit / Не удалось определить проверенный коммит')
    const planId = o.planId ?? currentPlanId(root)
    const ref = handoffReportRef(planId, taskId, run.runId)
    await storeReport(root, ref, o.report)
    const saved = await updatePlan(root, (plan) => {
      const current = reviewedTask(plan, taskId)
      if (current.runs.at(-1)?.runId !== run.runId || current.check?.state !== 'checking') throw new CheckError('handoff_not_ready', 'The run changed during finalization / Запуск изменился во время завершения')
      current.check = { state: 'checked', runId: run.runId, at: now.toISOString(), ...(o.by ? { by: o.by } : {}), note: note.trim(), report: ref, commit: head.stdout.trim() }
      current.notes.push(eventNote(now.toISOString(), 'check', { kind: 'checked', ...(o.by ? { by: o.by } : {}), note: note.trim() }))
      return plan
    }, 5, o.planId)
    return saved.tasks.find((task) => task.id === taskId) as Task
  }
  return writeCheck(root, taskId, now, o, 'checked', note.trim())
}

/**
 * `orch verify <id> --return "…"`: back to the worker with the findings — the relaunch path in the same
 * worktree. The finished run's review interval closes as reopened, so Review does not count the wait as the person's.
 */
export async function returnFromCheck(o: Omit<RelaunchOptions, 'note'> & { findings: string; by?: string }): Promise<LaunchResult> {
  const findings = o.findings.trim()
  if (!findings) throw new CheckError('no_note', 'The findings are required / Нужны замечания')
  const before = await loadPlan(o.root, o.planId)
  const returned = reviewedTask(before, o.taskId).runs.at(-1)?.runId
  const launched = await relaunchTask({ ...o, note: findings, noteFrom: 'orchestrator' })
  const at = o.now().toISOString()
  await updatePlan(o.root, (plan) => {
    const task = plan.tasks.find((t) => t.id === o.taskId)
    if (!task) return plan
    task.notes.push(eventNote(at, 'check', { kind: 'check_returned', ...(o.by ? { by: o.by } : {}), findings }))
    const open = task.reviewIntervals?.find((i) => !i.decidedAt && i.runId === returned)
    if (open) { open.decidedAt = at; open.decision = 'reopened'; open.reason = `orchestrator: ${findings}` }
    return plan
  }, 5, o.planId)
  return launched
}
