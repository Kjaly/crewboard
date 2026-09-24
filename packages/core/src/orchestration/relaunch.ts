import { LEGACY_RUN_ID, LegacyRunReadOnlyError } from '../runs/legacy-runs.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ExamplePlanError, CREWBOARD_DIR, loadPlan } from '../plan/store.js'
import { normalize } from '../runs/normalize.js'
import { type LaunchOptions, type LaunchResult, launchError, launchLang, launchTask } from './launch.js'

export type RelaunchOptions = Omit<LaunchOptions, 'agent' | 'promptFile' | 'contract'> & { agent?: string; note?: string; fromStep?: string; noteFrom?: 'human' | 'orchestrator' }

const MAX_MESSAGES = 3
const MAX_PROBLEMS = 5

/**
 * A new run in the same worktree: the task contract, then what the previous run said and hit, the step to
 * continue from and the human's note. The task keeps its contract; the combined prompt lives in .orchestration/relaunch.
 */
export async function relaunchTask(o: RelaunchOptions): Promise<LaunchResult> {
  const plan = await loadPlan(o.root, o.planId)
  if (plan.example) throw new ExamplePlanError()
  const task = plan.tasks.find((t) => t.id === o.taskId)
  const lang = launchLang(o)
  if (!task) throw launchError(lang, 'unknown_task', { id: o.taskId })
  const last = task.runs.at(-1)
  if (!last) throw launchError(lang, 'no_runs', { id: o.taskId })
  if (LEGACY_RUN_ID.test(last.runId)) throw new LegacyRunReadOnlyError()
  if (!task.contract) throw launchError(lang, 'no_contract')
  const contract = await readFile(resolve(o.root, task.contract), 'utf8').catch(() => {
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
    ...(o.note ? [o.noteFrom === 'orchestrator' ? `Замечания оркестратора по проверке: ${o.note}` : `Указание человека: ${o.note}`] : []),
    'Рабочая копия уже содержит изменения прошлого запуска — продолжай с них, не начинай заново.',
    '</previous_run>',
  ]
  const dir = join(o.root, CREWBOARD_DIR, 'relaunch')
  await mkdir(dir, { recursive: true })
  const promptFile = join(dir, `${o.taskId}-${o.now().getTime()}.md`)
  await writeFile(promptFile, `${contract.trimEnd()}\n\n${context.join('\n')}\n`)
  // Without an explicit worker the launch rule decides: the task's assignment, else the previous run's
  // worker while the preset still allows it, else the preset order. Re-running the last worker is not
  // a fresh choice by whoever relaunches, so it never bypasses the preset.
  return launchTask({ ...o, promptFile, preferWorker: last.agent })
}
