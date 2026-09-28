import { LEGACY_RUN_ID, LegacyRunReadOnlyError } from '../runs/legacy-runs.js'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ExamplePlanError, loadPlan } from '../plan/store.js'
import { normalize } from '../runs/normalize.js'
import { type LaunchOptions, type LaunchResult, assertOpenForRun, launchError, launchLang, launchTask } from './launch.js'
import { rejectTask } from './review.js'

export type RelaunchOptions = Omit<LaunchOptions, 'agent' | 'runContext' | 'contract'> & { agent?: string; note?: string; fromStep?: string; noteFrom?: 'human' | 'orchestrator' | 'crewboard' }

const MAX_MESSAGES = 3
const MAX_PROBLEMS = 5

/**
 * A new run in the same worktree: the task contract, then what the previous run said and hit, the step to
 * continue from and the human's note. The task keeps its contract; the launch builds the prompt in the one
 * worker order (`workerPromptText`): rules, contract, then this per-run part.
 */
export async function relaunchTask(o: RelaunchOptions): Promise<LaunchResult> {
  const plan = await loadPlan(o.root, o.planId)
  if (plan.example) throw new ExamplePlanError()
  const task = plan.tasks.find((t) => t.id === o.taskId)
  const lang = launchLang(o)
  if (!task) throw launchError(lang, 'unknown_task', { id: o.taskId })
  // Refused before the previous run is read or a prompt is written.
  assertOpenForRun(task, lang)
  const last = task.runs.at(-1)
  if (!last) throw launchError(lang, 'no_runs', { id: o.taskId })
  if (LEGACY_RUN_ID.test(last.runId)) throw new LegacyRunReadOnlyError()
  if (!task.contract) throw launchError(lang, 'no_contract', { id: task.id })
  await stat(resolve(o.root, task.contract)).catch(() => {
    throw launchError(lang, 'contract_missing', { path: task.contract ?? '' })
  })

  const backend = await o.backends.forAgent(last.agent, last.runId).catch(() => undefined)
  const feed = backend ? normalize(await backend.events(last.runId).catch(() => [])) : []
  const said = feed.filter((e) => e.kind === 'message' || e.kind === 'final').slice(-MAX_MESSAGES)
  const problems = feed.filter((e) => e.kind === 'problem').slice(-MAX_PROBLEMS)
  const context = [
    '<previous_run>',
    `Прошлый запуск: ${last.agent}, итог: ${last.outcome ?? 'не завершён'}.`,
    ...said.map((e) => `Последнее сообщение воркера: ${e.text}`),
    ...problems.map((e) => `Проблема: ${e.text}`),
    ...(o.fromStep ? [`Продолжи с шага: ${o.fromStep}`] : []),
    ...(o.note ? [o.noteFrom === 'orchestrator' ? `Замечания оркестратора по проверке: ${o.note}` : o.noteFrom === 'crewboard' ? o.note : `Указание человека: ${o.note}`] : []),
    'Рабочая копия уже содержит изменения прошлого запуска — продолжай с них, не начинай заново.',
    '</previous_run>',
  ]
  // Without an explicit worker the launch rule decides: the task's assignment, else the previous run's
  // worker while the preset still allows it, else the preset order. Re-running the last worker is not
  // a fresh choice by whoever relaunches, so it never bypasses the preset.
  return launchTask({ ...o, runContext: context.join('\n'), preferWorker: last.agent, continuesWork: true })
}

/** The direction «Continue» gives an incomplete run's successor (bg1). */
export const CONTINUE_DIRECTION =
  'Прошлый запуск закончился, не сдав работу: изменения в рабочей копии не закоммичены, финального отчёта со строкой «Результат:» нет. Доделай задачу в этой копии: длинные проверки запускай в этом же ходе на переднем плане с таймаутом, не в фоне; закоммить работу и закончи финальным отчётом.'

/**
 * «Continue» on a run that ended `incomplete` (bg1): the same relaunch in the same worktree, with a fixed
 * direction to finish and report. Only the task's last run being incomplete makes it one.
 */
export async function continueTask(o: Omit<RelaunchOptions, 'note' | 'noteFrom' | 'fromStep'>): Promise<LaunchResult> {
  const plan = await loadPlan(o.root, o.planId)
  const task = plan.tasks.find((t) => t.id === o.taskId)
  const lang = launchLang(o)
  if (!task) throw launchError(lang, 'unknown_task', { id: o.taskId })
  assertOpenForRun(task, lang)
  if (task.runs.at(-1)?.outcome !== 'incomplete') throw launchError(lang, 'not_incomplete', { id: o.taskId })
  return relaunchTask({ ...o, note: CONTINUE_DIRECTION, noteFrom: 'crewboard' })
}

/**
 * Human-only (wk1, B29): Send back with a reason and start the next run at once — a relaunch in the same worktree,
 * the previous run's worker unless the person picks another. The reason reaches the new run's prompt through the
 * launch (`pendingSendBack`). Checked before anything is written: a decision, a root task or a task without a run
 * has no worker run to repeat. A launch refused after the send back leaves the task sent back, ready to start.
 */
export async function sendBackAndRerun(o: Omit<RelaunchOptions, 'note' | 'noteFrom' | 'fromStep'> & { reason: string }): Promise<LaunchResult> {
  const plan = await loadPlan(o.root, o.planId)
  if (plan.example) throw new ExamplePlanError()
  const task = plan.tasks.find((t) => t.id === o.taskId)
  const lang = launchLang(o)
  if (!task) throw launchError(lang, 'unknown_task', { id: o.taskId })
  if (task.kind === 'decision') throw launchError(lang, 'decision')
  if (task.kind === 'root') throw launchError(lang, 'root', { id: o.taskId })
  assertOpenForRun(task, lang)
  if (task.runs.length === 0) throw launchError(lang, 'no_runs', { id: o.taskId })
  const live = task.runs.at(-1)
  if (live && !live.finishedAt) throw launchError(lang, 'running', { run: live.runId })
  await rejectTask(o.root, o.taskId, o.reason, o.now(), o.planId)
  const { reason: _, ...rest } = o
  return relaunchTask(rest)
}
