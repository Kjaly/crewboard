import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { claudeLimitsPath, latestClaudeWeeklyPct } from '../cost/claude-limits.js'
import { codexQuotaUsedPercent } from '../cost/codex-quota.js'
import type { Exec } from '../exec.js'
import { deriveViews } from '../plan/graph.js'
import { ExamplePlanError, updatePlan } from '../plan/store.js'
import { eventNote } from '../plan/notes.js'
import type { AgentProfile } from '../preflight/preflight.js'
import { cachedPreflight } from '../preflight/cache.js'
import { CLASS_LABEL, CLASS_LABEL_RU, classOfTask } from '../routing/routing.js'
import { resolveRouting, type EffectiveRouting } from '../routing/presets.js'
import { type Caller, PresetAuthorityError, assertWorkerChoice, isAutoWorker, presetAllows } from '../routing/authority.js'
import { canonicalWorkerId } from '../routing/identity.js'
import { loadProfileStore } from '../routing/profile-store.js'
import { PrepareError, prepareWorktree } from '../worktree/prepare.js'
import { EMPTY_RECIPE, loadRecipe } from '../worktree/recipe.js'
import { type Backends, resolveProfile } from './backends.js'
import { type MessageLang, type MessageVars, orchText } from './messages.js'
import { syncPlan } from './sync.js'

export type LaunchErrorCode =
  | 'unknown_task'
  | 'no_runs'
  | 'decision'
  | 'running'
  | 'blocked'
  | 'accepted'
  | 'superseded'
  | 'no_contract'
  | 'contract_missing'
  | 'preflight'
  | 'prepare'
  | 'baseline'
  | 'no_worker'
  | 'disabled'
  | 'outside_preset'

export class LaunchError extends Error {
  constructor(
    readonly code: LaunchErrorCode,
    message: string,
    readonly detail?: string,
    /** Present when the message comes from `orchText(code)`: the same refusal renders in any language. */
    readonly vars?: MessageVars,
  ) {
    super(message)
    this.name = 'LaunchError'
  }
}

export const launchError = (lang: MessageLang | undefined, code: LaunchErrorCode, vars: MessageVars = {}, detail?: string): LaunchError =>
  new LaunchError(code, orchText(lang, code, vars), detail, vars)

export type LaunchOptions = {
  root: string
  taskId: string
  /** Omitted: the repository's current plan. */
  planId?: string
  /**
   * Omitted: the task's own worker (see the launch rule below), else the preset order for the task's
   * class. An explicit value is a re-assignment written back to the task with `caller` as its source;
   * `auto` clears the assignment and lets the preset decide.
   */
  agent?: string
  /** Who asks (routing/authority.ts `callerOf`). Omitted means an agent: the strict side. */
  caller?: Caller
  /** With no assignment, try this worker first when the preset still allows it (a relaunch keeps its worker). */
  preferWorker?: string
  contract?: string
  promptFile?: string
  scope?: string
  skipPreflight?: boolean
  backends: Backends
  exec: Exec
  env: NodeJS.ProcessEnv
  home: string
  now: () => Date
  lang?: 'en' | 'ru'
}
export type LaunchResult = { runId: string; agent: string; worktree: { path: string; branch: string; reused: boolean } }

const exists = (p: string) => stat(p).then(() => true, () => false)

type WorkerOrigin = 'explicit' | 'task' | 'auto'

const isRu = (o: Pick<LaunchOptions, 'lang' | 'env'>): boolean => o.lang === 'ru' || (!o.lang && /^ru(?:[_\-.]|$)/i.test(o.env.LC_ALL || o.env.LANG || ''))
/** The language of a launch's refusals: the caller's choice, else the environment's locale. */
export const launchLang = (o: Pick<LaunchOptions, 'lang' | 'env'>): MessageLang => (isRu(o) ? 'ru' : 'en')

export async function launchTask(o: LaunchOptions): Promise<LaunchResult> {
  const { plan, states } = await syncPlan(o.root, o.backends, o.now(), undefined, o.planId)
  if (plan.example) throw new ExamplePlanError()
  const view = deriveViews(plan, states).find((v) => v.task.id === o.taskId)
  const lang = launchLang(o)
  if (!view) throw launchError(lang, 'unknown_task', { id: o.taskId })
  if (view.task.kind === 'decision') throw launchError(lang, 'decision')
  if (view.status === 'running') throw launchError(lang, 'running', { run: view.activeRunId ?? '' })
  if (view.status === 'blocked') throw launchError(lang, 'blocked', { deps: view.blockedBy.join(', ') })
  if (view.status === 'accepted') throw launchError(lang, 'accepted')
  if (view.status === 'superseded') throw launchError(lang, 'superseded')

  const contractRel = o.contract ?? view.task.contract
  if (!contractRel) throw launchError(lang, 'no_contract')
  const contract = resolve(o.root, contractRel)
  if (!(await exists(contract))) throw launchError(lang, 'contract_missing', { path: contract })
  const contractRevision = createHash('sha256').update(await readFile(contract)).digest('hex')

  const routing = await resolveRouting(o.root, o.planId, { ...o.env, HOME: o.home })
  const cls = classOfTask(view.task)
  const aliases = (await loadProfileStore({ ...o.env, HOME: o.home }, o.home)).aliases
  const canonical = (id: string) => canonicalWorkerId(id, aliases)
  // The task's own worker comes first and is checked exactly like `-a`: a prohibition, a missing
  // profile or a failed preflight refuses the launch instead of silently falling back to the preset.
  const caller: Caller = o.caller ?? 'agent'
  const ru = isRu(o)
  const clearing = isAutoWorker(o.agent)
  const explicit = o.agent !== undefined && !clearing ? o.agent : undefined
  // An agent chooses only inside the preset; a person may pick anyone (the owner's decision, 2026-09-24).
  if (explicit !== undefined) {
    try {
      assertWorkerChoice({ caller, routing, taskClass: cls, worker: explicit, aliases, lang: ru ? 'ru' : 'en' })
    } catch (err) {
      if (err instanceof PresetAuthorityError) throw new LaunchError('outside_preset', err.message)
      throw err
    }
  }
  // Launch rule: a person's assignment runs even outside the preset; an agent's runs only while the
  // current preset still allows it — otherwise the preset order runs and a note says why.
  const assigned = explicit === undefined && !clearing ? view.task.worker : undefined
  const assignedSource = view.task.workerSource ?? 'agent'
  const stale = assigned !== undefined && assignedSource === 'agent' && !presetAllows(routing, cls, assigned, aliases) ? assigned : undefined
  const requested = explicit ?? (stale ? undefined : assigned)
  const preferred = requested === undefined && o.preferWorker && presetAllows(routing, cls, o.preferWorker, aliases) ? o.preferWorker : undefined
  const origin: WorkerOrigin = explicit !== undefined ? 'explicit' : requested !== undefined ? 'task' : 'auto'
  const choice = explicit !== undefined ? caller : requested !== undefined ? assignedSource : 'preset'
  const profile = await chooseWorker(o, routing, cls, aliases, requested ?? preferred, origin)
  // Only a person's choice can land outside the preset; the feed says so, so a hand-picked worker is
  // never mistaken for the preset's decision.
  const outsidePreset = choice === 'person' && !routing.routing[cls].some((id) => canonical(id) === canonical(profile.id))

  const recipe = (await loadRecipe(o.root)) ?? EMPTY_RECIPE
  let wt: Awaited<ReturnType<typeof prepareWorktree>>
  try {
    wt = await prepareWorktree({ repoRoot: o.root, taskId: o.taskId, title: view.task.title, recipe, scope: o.scope, exec: o.exec, env: o.env, now: o.now, lang })
  } catch (err) {
    // prepare/baseline keep the whole text in the message (the cli prints it as before); detail is printed before the message
    if (err instanceof PrepareError) throw launchError(lang, 'prepare', { error: err.message, output: err.result.steps.at(-1)?.output ?? '' })
    throw err
  }
  if (wt.baseline && !wt.baseline.ok) {
    // The refused copy stays on the task, so the person sees its red baseline in the panel and in
    // `worktree list`; the next launch reuses it and runs the baseline again (bl1).
    await updatePlan(o.root, (next) => {
      const task = next.tasks.find((t) => t.id === o.taskId)
      if (task) task.worktree = { path: wt.path, branch: wt.branch }
      return next
    }, 5, o.planId)
    throw launchError(lang, 'baseline', { step: wt.baseline.step, output: wt.baseline.output })
  }

  const quotaBeforePct =
    profile.backend === 'codex-cli'
      ? await codexQuotaUsedPercent()
      : profile.backend === 'claude-code'
        ? await latestClaudeWeeklyPct(claudeLimitsPath(o.env, o.home))
        : undefined
  const backend = await o.backends.forAgent(profile.id)
  const startedAt = o.now().toISOString()
  const runId = await backend.launch({ agent: profile.id, promptFile: o.promptFile ?? contract, cwd: wt.path, model: profile.model })
  await updatePlan(o.root, (next) => {
    const task = next.tasks.find((t) => t.id === o.taskId)
    if (!task) throw launchError(lang, 'unknown_task', { id: o.taskId })
    // Only an explicit `-a` re-assigns the task's worker, with who chose it. `auto` and a stale agent
    // assignment clear it: from now on the preset decides. The preset's own pick is not an assignment —
    // the actual worker of every attempt is in runs[].agent.
    if (explicit !== undefined) {
      task.worker = profile.id
      task.workerSource = caller
    } else if (clearing || stale) {
      delete task.worker
      delete task.workerSource
    }
    task.contract = contractRel
    task.worktree = { path: wt.path, branch: wt.branch }
    // A new run replaces the work the orchestrator was checking: its check starts over when it finishes.
    delete task.check
    const canonicalId = canonicalWorkerId(profile.id, aliases)
    const provider = canonicalId.split('/')[0]
    const billingMode = profile.backend === 'dsh' ? 'api' : profile.backend === 'claude-code' || profile.backend === 'codex-cli' ? 'subscription' : 'unknown'
    task.runs.push({ runId, agent: profile.id, rawAgent: profile.id, canonicalWorkerId: canonicalId, model: profile.model, provider, billingMode, identityResolution: canonicalId === profile.id ? 'launch_snapshot' : 'alias', attemptIndex: task.runs.length + 1, attemptTrigger: task.runs.length ? 'unknown' : 'initial', contractPath: contractRel, contractRevision, startedAt, workerChoice: choice, ...(quotaBeforePct !== undefined ? { quotaBeforePct } : {}) })
    // The built-in preset has no stored name: the screen names it in the reader's language.
    const preset = routing.preset.builtin ? {} : { preset: routing.preset.label }
    if (stale) {
      task.notes.push(eventNote(startedAt, 'comment', { kind: 'preset_fallback', stale, worker: profile.id, ...preset }))
    }
    if (outsidePreset) {
      task.notes.push(eventNote(startedAt, 'comment', { kind: 'launched_outside_preset', worker: profile.id, ...preset }))
    }
    // Launching is the decision that the task is ready: a returned task or a draft starts as ready,
    // so its finished run lands in review rather than back where it came from.
    if (task.status === 'rejected' || task.status === 'backlog') task.status = 'ready'
    return next
  }, 5, o.planId)
  return { runId, agent: profile.id, worktree: { path: wt.path, branch: wt.branch, reused: wt.reused } }
}

async function preflightFailure(o: LaunchOptions, profile: AgentProfile): Promise<string | undefined> {
  if (o.skipPreflight) return undefined
  const codexUsedPercent = codexQuotaUsedPercent
  const pf = await cachedPreflight(o.root, profile, { exec: o.exec, codexUsedPercent, lang: isRu(o) ? 'ru' : 'en' }, o.now())
  if (pf.ok) return undefined
  return pf.checks
    .filter((c) => !c.ok)
    .map((c) => `✗ ${c.name}: ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`)
    .join('\n')
}

function disabledMessage(ru: boolean, origin: WorkerOrigin, agent: string, reason: string): string {
  const who = origin === 'task' ? (ru ? `Воркер задачи ${agent}` : `Task worker ${agent}`) : ru ? `Воркер ${agent}` : `Worker ${agent}`
  const suffix = reason ? `: ${reason}` : ''
  return ru ? `${who} отключён на этой машине${suffix}` : `${who} is disabled on this machine${suffix}`
}

/**
 * The task's own worker and an explicit `-a` are checked identically (prohibition, profile, preflight)
 * and refused rather than re-routed. Only an unset task worker walks the class's preset order.
 */
async function chooseWorker(o: LaunchOptions, routing: EffectiveRouting, cls: ReturnType<typeof classOfTask>, aliases: Record<string, string>, requested: string | undefined, origin: WorkerOrigin): Promise<AgentProfile> {
  const canonical = (id: string) => canonicalWorkerId(id, aliases)
  const ru = isRu(o)
  if (requested) {
    const agent = requested
    const disabledReason = Object.entries(routing.disabled).find(([id]) => canonical(id) === canonical(agent))?.[1]
    if (disabledReason !== undefined) throw new LaunchError('disabled', disabledMessage(ru, origin, agent, disabledReason || (ru ? 'причина не указана' : 'no reason given')))
    const dropped = routing.dropped.find((d) => d.id === agent || canonical(d.id) === canonical(agent))
    if (dropped?.reason === 'disabled') throw new LaunchError('disabled', disabledMessage(ru, origin, agent, ''))
    const profile = await resolveProfile(o.env, o.home, agent)
    const failure = await preflightFailure(o, profile)
    if (failure) throw launchError(ru ? 'ru' : 'en', 'preflight', { agent: profile.id }, failure)
    return profile
  }
  const tried: string[] = []
  for (const id of routing.routing[cls]) {
    const profile = await resolveProfile(o.env, o.home, id).catch(() => undefined)
    if (!profile) {
      tried.push(`✗ ${id}: ${orchText(ru ? 'ru' : 'en', 'no_profile')}`)
      continue
    }
    const failure = await preflightFailure(o, profile)
    if (!failure) return profile
    tried.push(`✗ ${id}:\n${failure}`)
  }
  throw new LaunchError('no_worker', ru ? `Для класса «${CLASS_LABEL_RU[cls]}» нет доступного воркера — включите или добавьте воркера в настройках оркестрации.` : `No worker is available for “${CLASS_LABEL[cls]}”. Enable or add a worker in Orchestra settings.`, tried.join('\n') || undefined)
}
