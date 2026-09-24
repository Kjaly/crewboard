import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Plan } from '../plan/schema.js'
import { planIds } from '../plan/plans.js'
import { eventNote } from '../plan/notes.js'
import { CREWBOARD_DIR, currentPlanId, loadPlan, updatePlan } from '../plan/store.js'

/** «Orchestrator checks finished work» (vr1): per plan, else per repository, else on while the plan has a chat. */

export type CheckSettingSource = 'plan' | 'repository' | 'chat' | 'default'
/** `plan` and `repository` are the stored values, absent when not set — the settings screen shows them. */
export type CheckSetting = { enabled: boolean; source: CheckSettingSource; plan?: boolean; repository?: boolean }

export const repositorySettingsPath = (root: string) => join(root, CREWBOARD_DIR, 'settings.json')

type RepositorySettings = { orchestratorCheck?: boolean }

async function readRepositorySettings(root: string): Promise<RepositorySettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(repositorySettingsPath(root), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RepositorySettings : {}
  } catch {
    return {}
  }
}

async function hasChat(root: string, planId: string): Promise<boolean> {
  try {
    const chats: unknown = JSON.parse(await readFile(join(root, CREWBOARD_DIR, 'chats.json'), 'utf8'))
    return !!chats && typeof chats === 'object' && planId in chats
  } catch {
    return false
  }
}

/** The plan's own setting, else the repository's, else on while the plan has an orchestrator chat. */
export async function resolveOrchestratorCheck(root: string, planId: string = currentPlanId(root), plan?: Pick<Plan, 'orchestratorCheck'>): Promise<CheckSetting> {
  const own = (plan ?? await loadPlan(root, planId).catch(() => undefined))?.orchestratorCheck
  const repository = (await readRepositorySettings(root)).orchestratorCheck
  const stored = { ...(own !== undefined ? { plan: own } : {}), ...(typeof repository === 'boolean' ? { repository } : {}) }
  if (own !== undefined) return { enabled: own, source: 'plan', ...stored }
  if (typeof repository === 'boolean') return { enabled: repository, source: 'repository', ...stored }
  return (await hasChat(root, planId)) ? { enabled: true, source: 'chat', ...stored } : { enabled: false, source: 'default', ...stored }
}

/** `undefined` clears the repository setting (back to «on while the plan has a chat»). */
export async function setRepositoryOrchestratorCheck(root: string, value: boolean | undefined): Promise<void> {
  const file = repositorySettingsPath(root)
  const current = await readRepositorySettings(root)
  const next: RepositorySettings = { ...current }
  if (value === undefined) delete next.orchestratorCheck
  else next.orchestratorCheck = value
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`)
  await rename(tmp, file)
  for (const planId of await planIds(root).catch(() => [] as string[])) await releaseChecks(root, planId)
}

/** `undefined` clears the plan's own setting (back to the repository's). */
export async function setPlanOrchestratorCheck(root: string, planId: string | undefined, value: boolean | undefined): Promise<void> {
  await updatePlan(root, (plan) => {
    if (value === undefined) delete plan.orchestratorCheck
    else plan.orchestratorCheck = value
    return plan
  }, 5, planId)
  await releaseChecks(root, planId ?? currentPlanId(root))
}

/**
 * With the setting off, finished work goes straight to the person — including work that was waiting for a
 * check when it was turned off; otherwise it would stay hidden from the person's lists.
 */
async function releaseChecks(root: string, planId: string): Promise<void> {
  const plan = await loadPlan(root, planId).catch(() => undefined)
  if (!plan || plan.example || !plan.tasks.some((t) => t.check?.state === 'pending' || t.check?.state === 'checking')) return
  if ((await resolveOrchestratorCheck(root, planId, plan)).enabled) return
  const at = new Date().toISOString()
  await updatePlan(root, (next) => {
    for (const task of next.tasks) {
      if (task.check?.state !== 'pending' && task.check?.state !== 'checking') continue
      delete task.check
      task.notes.push(eventNote(at, 'check', { kind: 'check_skipped' }))
    }
    return next
  }, 5, planId)
}
