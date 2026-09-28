import type { Exec } from '../exec.js'
import { readRepositorySettings, writeRepositorySettings } from '../orchestration/check-setting.js'
import type { Plan } from '../plan/schema.js'
import { currentPlanId, loadPlan, updatePlan } from '../plan/store.js'
import { checkedOutBranch } from './merged.js'

/**
 * The base a launch takes when a task has none recorded yet (bs1): its `origin/HEAD`, else `main` or
 * `master`, else — for a repository with neither — whatever is checked out, the only thing left to go on.
 * Never chosen *because* a person happens to have that branch out; that is exactly the accident this
 * guards against (a shared main checkout mid-review of an unrelated branch).
 */
export async function repoDefaultBranch(root: string, exec: Exec): Promise<string | undefined> {
  const origin = await exec('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const remote = origin.code === 0 ? origin.stdout.trim().replace(/^origin\//, '') : ''
  const refExists = async (name: string) => (await exec('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0
  for (const name of [remote, 'main', 'master']) if (name && (await refExists(name))) return name
  return checkedOutBranch(root, exec)
}

export type DefaultBaseSource = 'plan' | 'repository' | 'default'
/** `plan` and `repository` are the stored overrides, absent when not set — the settings screen shows them. */
export type DefaultBaseSetting = { branch: string | undefined; source: DefaultBaseSource; plan?: string; repository?: string }

/**
 * The base a launch uses for a task with no base of its own yet: the plan's own override, else the
 * repository's, else the repository's own default (`repoDefaultBranch`). A reused copy keeps the base it
 * already has (`prepare.ts`) — this only decides a *new* one.
 */
export async function resolveDefaultBase(root: string, exec: Exec, opts: { planId?: string; plan?: Pick<Plan, 'defaultBase'> } = {}): Promise<DefaultBaseSetting> {
  const plan = opts.plan ?? (await loadPlan(root, opts.planId).catch(() => undefined))
  const own = plan?.defaultBase
  const repository = (await readRepositorySettings(root)).defaultBase
  const stored = { ...(own ? { plan: own } : {}), ...(repository ? { repository } : {}) }
  if (own) return { branch: own, source: 'plan', ...stored }
  if (repository) return { branch: repository, source: 'repository', ...stored }
  return { branch: await repoDefaultBranch(root, exec), source: 'default', ...stored }
}

export const getRepositoryDefaultBase = async (root: string): Promise<string | undefined> => (await readRepositorySettings(root)).defaultBase

/** `undefined` clears the repository override (back to the repository's own default). */
export async function setRepositoryDefaultBase(root: string, value: string | undefined): Promise<void> {
  await writeRepositorySettings(root, (current) => {
    const next = { ...current }
    if (value === undefined) delete next.defaultBase
    else next.defaultBase = value
    return next
  })
}

/** `undefined` clears the plan's own override (back to the repository's). */
export async function setPlanDefaultBase(root: string, planId: string | undefined, value: string | undefined): Promise<void> {
  await updatePlan(root, (plan) => {
    if (value === undefined) delete plan.defaultBase
    else plan.defaultBase = value
    return plan
  }, 5, planId ?? currentPlanId(root))
}
