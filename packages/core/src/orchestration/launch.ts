import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { codexQuotaUsedPercent } from '../cost/codex-quota.js'
import type { Exec } from '../exec.js'
import { deriveViews } from '../plan/graph.js'
import type { Plan, Task } from '../plan/schema.js'
import { CREWBOARD_DIR, ExamplePlanError, PlanArchivedError, currentPlanId, updatePlan } from '../plan/store.js'
import { type ContractWarning, contractIsUnfilled, contractWarnings as contractWarningsOf } from '../plan/contract.js'
import { eventNote } from '../plan/notes.js'
import { type AgentProfile, effortCheck } from '../preflight/preflight.js'
import { cachedPreflight } from '../preflight/cache.js'
import { ANTHROPIC_API_KEY_REF, type AnthropicPolicyCode, AnthropicPolicyError, classifyAnthropicRoute, evaluateAnthropicLaunchPolicy } from '../routing/anthropic-policy.js'
import { anthropicPolicyShort } from '../routing/anthropic-policy-text.js'
import { CLASS_LABEL, CLASS_LABEL_RU, classOfTask } from '../routing/routing.js'
import { resolveRouting, type EffectiveRouting } from '../routing/presets.js'
import { type Caller, PresetAuthorityError, assertWorkerChoice, isAutoWorker, presetAllows, presetWorkers } from '../routing/authority.js'
import { DEFAULT_WORKERS, loadRegistry, registryPath } from '../routing/registry.js'
import type { TaskClass } from '../plan/schema.js'
import { canonicalWorkerId } from '../routing/identity.js'
import { loadProfileStore } from '../routing/profile-store.js'
import { PrepareError, outputVars, prepareWorktree, type StepResult } from '../worktree/prepare.js'
import { EMPTY_RECIPE, loadRecipe } from '../worktree/recipe.js'
import { resolveDefaultBase } from '../worktree/default-base.js'
import { checkedOutBranch, uncommittedCount } from '../worktree/merged.js'
import { orchestratorCommits } from './commit-owner.js'
import { classifyFailure } from '../runs/failure.js'
import { mergeCommands } from '../plan/merge.js'
import { type Backends, resolveProfile, workerCommands } from './backends.js'
import { pendingSendBack, sendBackBlock } from './decision.js'
import { type MessageLang, type MessageVars, orchText } from './messages.js'
import { syncPlan } from './sync.js'

export type LaunchErrorCode =
  | 'unknown_task'
  | 'no_runs'
  | 'not_incomplete'
  | 'decision'
  | 'root'
  | 'running'
  | 'orphan_alive'
  | 'blocked'
  | 'unmerged'
  | 'accepted'
  | 'superseded'
  | 'dropped'
  | 'no_contract'
  | 'contract_missing'
  | 'contract_unfilled'
  | 'preflight'
  | 'prepare'
  | 'baseline'
  | 'no_worker'
  | 'disabled'
  | 'outside_preset'
  | 'dirty_copy'
  | 'agent_base'
  | 'not_decision'
  | 'answer_fields'
  | 'prepare_reason'
  | 'decision_conflict'
  | 'decision_closed'
  | 'decision_in_batch'
  /** API-only Claude policy (routing/anthropic-policy.ts): the resolved auth channel is not allowed. */
  | AnthropicPolicyCode

export class LaunchError extends Error {
  constructor(
    readonly code: LaunchErrorCode,
    message: string,
    readonly detail?: string,
    /** Present when the message comes from `orchText(code)`: the same refusal renders in any language. */
    readonly vars?: MessageVars,
    /** A failed command's output (prepare, baseline): the file with all of it, its size and the last lines (tk1). */
    readonly output?: { path: string; bytes: number; tail: string },
  ) {
    super(message)
    this.name = 'LaunchError'
  }
}

export const launchError = (lang: MessageLang | undefined, code: LaunchErrorCode, vars: MessageVars = {}, detail?: string, output?: LaunchError['output']): LaunchError =>
  new LaunchError(code, orchText(lang, code, vars), detail, vars, output)

/** A refusal over a failed step: the message names the step's output file and shows its tail, never the whole output. */
function stepError(lang: MessageLang, code: 'prepare' | 'baseline', vars: MessageVars, step: StepResult | undefined): LaunchError {
  const output = { path: step?.log?.path ?? '', bytes: step?.log?.bytes ?? 0, tail: step?.output ?? '' }
  return launchError(lang, code, { ...vars, ...outputVars(output) }, undefined, step?.log ? output : undefined)
}

/**
 * A closed task starts no run (rp1): read from the stored status, not the view, so an acceptance with a
 * negative verdict (shown as `closed`) is refused like any other.
 */
export function assertOpenForRun(task: Pick<Task, 'id' | 'status'>, lang: MessageLang): void {
  if (task.status === 'accepted') throw launchError(lang, 'accepted', { id: task.id })
  if (task.status === 'superseded') throw launchError(lang, 'superseded', { id: task.id })
  if (task.status === 'dropped') throw launchError(lang, 'dropped', { id: task.id })
}

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
  /** What changes per run (a relaunch's previous run, step and note); it follows the contract in the prompt. */
  runContext?: string
  scope?: string
  skipPreflight?: boolean
  /** A contract still equal to the template skeleton, or with an empty Result or Checks section, refuses the launch (rq1) unless this is set. */
  force?: boolean
  /** The refusal over "no worker" carries every candidate's raw preflight failure, not just the grouped summary (rq1). */
  verbose?: boolean
  /**
   * Start although a dependency is accepted but not merged (w1d). Honoured only for a person (`caller: 'person'`):
   * the copy then starts without that work, which the person chose knowingly.
   */
  allowUnmerged?: boolean
  /**
   * Starting again on a copy with uncommitted changes (fo1): a person's answer — continue with them, or reset the
   * copy to its last commit. Honoured only for a person; without it the launch is refused with `dirty_copy`.
   */
  dirtyCopy?: 'keep' | 'reset'
  /** A relaunch or «Continue» (relaunch.ts): the new run carries the previous one's changes by design, so nothing is asked. */
  continuesWork?: boolean
  /**
   * A new copy's base, chosen on purpose (bs1): honoured only for a person (`caller: 'person'`), like
   * `allowUnmerged`; an agent's request is refused. Ignored for a reused copy, which keeps its own base.
   */
  base?: string
  backends: Backends
  exec: Exec
  env: NodeJS.ProcessEnv
  home: string
  now: () => Date
  lang?: 'en' | 'ru'
}
export type LaunchResult = {
  runId: string
  agent: string
  worktree: { path: string; branch: string; reused: boolean }
  /** Soft contract check (ct1): what the contract lacks, said to the caller; the run starts anyway. */
  contractWarnings?: { codes: ContractWarning[]; path: string }
  /** Workers an automatic pick passed over before this one (nb1); the task feed says the same. */
  skipped?: SkippedWorker[]
  /** The main checkout had a different branch checked out at launch (bs1): the copy still took the default base. */
  baseNotice?: { checkedOut: string; base: string }
}

const exists = (p: string) => stat(p).then(() => true, () => false)

/**
 * What every worker is told, whatever the backend (bg1): a run ends when the worker's turn ends, so work
 * left in the background is lost and a turn that ends «waiting» hands nothing in. Long check output read
 * back into the context stays there for the rest of the run (tk1).
 */
export const WORKER_RULES = `<crewboard_worker_rules>
Nothing wakes you after your turn ends: when you stop, the run is over.
- Run long checks (tests, builds, stress runs) in the foreground in this same turn, with a timeout.
- Run them through \`crewboard slot -- <command>\`: it waits for a free machine-wide slot, so several heavy checks on the same machine take turns instead of starving each other.
- Send long check output to a file and read back only the failing part or the tail.
- Do not start background commands or monitors, and do not end your turn to wait for a notification or to check back later.
- Commit your work on the task branch before your final report.
- End your turn only with your final report.
</crewboard_worker_rules>
`

export const ORCHESTRATOR_COMMIT_RULES = WORKER_RULES.replace(
  '- Commit your work on the task branch before your final report.',
  '- Leave your changes in this task worktree. The orchestrator checks and commits them. Do not run git add or git commit.',
)

/**
 * The one order of every worker prompt, steady part first, since a prompt cache matches from the start (tk1):
 * the rules (the same for every run), the contract (the same for every run of the task), then what changes
 * per run. Nothing per run — a date, a run id — may come before the contract.
 */
export const workerPromptText = (contract: string, runContext?: string): string =>
  `${orchestratorCommits(contract) ? ORCHESTRATOR_COMMIT_RULES : WORKER_RULES}\n${contract.trimEnd()}\n${runContext?.trim() ? `\n${runContext.trim()}\n` : ''}`

/** The worker prompt of one run, kept beside the plan; a run started in the same millisecond never overwrites another's. */
async function workerPrompt(root: string, taskId: string, contract: string, runContext: string | undefined, now: Date): Promise<string> {
  const dir = join(root, CREWBOARD_DIR, 'prompts')
  await mkdir(dir, { recursive: true })
  const text = workerPromptText(await readFile(contract, 'utf8'), runContext)
  for (let n = 1; ; n++) {
    const file = join(dir, `${taskId}-${now.getTime()}${n > 1 ? `-${n}` : ''}.md`)
    try {
      await writeFile(file, text, { flag: 'wx' })
      return file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

type WorkerOrigin = 'explicit' | 'task' | 'auto'

const isRu = (o: Pick<LaunchOptions, 'lang' | 'env'>): boolean => o.lang === 'ru' || (!o.lang && /^ru(?:[_\-.]|$)/i.test(o.env.LC_ALL || o.env.LANG || ''))
/** The language of a launch's refusals: the caller's choice, else the environment's locale. */
export const launchLang = (o: Pick<LaunchOptions, 'lang' | 'env'>): MessageLang => (isRu(o) ? 'ru' : 'en')

export async function launchTask(o: LaunchOptions): Promise<LaunchResult> {
  const { plan, states } = await syncPlan(o.root, o.backends, o.now(), undefined, o.planId)
  if (plan.example) throw new ExamplePlanError()
  // Refused before a worktree or a worker exists, not at the first plan write after them (B22).
  if (o.planId === undefined && plan.archived) throw new PlanArchivedError(currentPlanId(o.root))
  const view = deriveViews(plan, states).find((v) => v.task.id === o.taskId)
  const lang = launchLang(o)
  if (!view) throw launchError(lang, 'unknown_task', { id: o.taskId })
  if (view.task.kind === 'decision') throw launchError(lang, 'decision')
  if (view.task.kind === 'root') throw launchError(lang, 'root', { id: o.taskId })
  assertOpenForRun(view.task, lang)
  // B19: the supervisor of the last run died but its worker still writes to the copy — one worker per copy.
  const orphan = view.activeRunId ? states[view.activeRunId]?.orphan : undefined
  if (orphan) throw launchError(lang, 'orphan_alive', { run: view.activeRunId ?? '', pid: orphan.workerPid })
  if (view.status === 'running') throw launchError(lang, 'running', { run: view.activeRunId ?? '' })
  if (view.status === 'blocked') {
    // A dependency counts as done only once merged: a copy branched now would not contain its accepted work (w1d).
    const waiting = view.waitingMerge ?? []
    if (waiting.length < view.blockedBy.length) throw launchError(lang, 'blocked', { deps: view.blockedBy.join(', ') })
    if (!(o.allowUnmerged && o.caller === 'person')) throw await unmergedError(o, lang, plan.tasks.filter((task) => waiting.includes(task.id)))
  }

  const contractRel = o.contract ?? view.task.contract
  if (!contractRel) throw launchError(lang, 'no_contract', { id: o.taskId })
  const contract = resolve(o.root, contractRel)
  if (!(await exists(contract))) throw launchError(lang, 'contract_missing', { path: contract })
  const contractBytes = await readFile(contract)
  const contractRevision = createHash('sha256').update(contractBytes).digest('hex')
  const contractContent = contractBytes.toString('utf8')
  // Soft check (ct1): a contract without checks or without the result line still runs, with a warning.
  const contractWarnings = contractWarningsOf(contractContent)
  // Hard check (rq1): a contract still equal to `task add --template`'s skeleton, or with an empty
  // Result or Checks section, refuses outright — a person can start it as is with --force.
  if (!o.force && contractIsUnfilled(contractContent)) throw launchError(lang, 'contract_unfilled', { id: o.taskId, path: contractRel })

  const routing = await resolveRouting(o.root, o.planId, { ...o.env, HOME: o.home })
  const cls = classOfTask(view.task)
  const aliases = (await loadProfileStore({ ...o.env, HOME: o.home }, o.home)).aliases
  const canonical = (id: string) => canonicalWorkerId(id, aliases)
  // The task's own worker comes first and is checked exactly like `-a`: a prohibition, a missing
  // profile or a failed preflight refuses the launch instead of silently falling back to the preset.
  const caller: Caller = o.caller ?? 'agent'
  // bs1: a task's base is chosen on purpose, not caught by accident — only a person may name one with
  // --base; an agent's request is refused outright, cheap, before any work starts.
  if (o.base !== undefined && caller !== 'person') throw launchError(lang, 'agent_base', { id: o.taskId, base: o.base })
  // fo1: a fresh start on a copy the previous run left changes in asks the person first — continue with them, or
  // reset the copy. Before preflight and preparation, so a refusal costs nothing; an agent's answer does not count.
  const copy = view.task.worktree
  if (copy && view.task.runs.length > 0 && !o.continuesWork) {
    const answer = caller === 'person' ? o.dirtyCopy : undefined
    if (answer === 'reset') await resetCopy(copy.path, o.exec)
    else if (answer !== 'keep') {
      const count = await uncommittedCount(copy.path, o.exec)
      if (count) throw launchError(lang, 'dirty_copy', { id: o.taskId, count })
    }
  }
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
  const { profile, skipped } = await chooseWorker(o, routing, cls, aliases, requested ?? preferred, origin)
  // Only a person's choice can land outside the preset; the feed says so, so a hand-picked worker is
  // never mistaken for the preset's decision.
  const outsidePreset = choice === 'person' && !routing.routing[cls].some((id) => canonical(id) === canonical(profile.id))

  const recipe = (await loadRecipe(o.root)) ?? EMPTY_RECIPE
  // The copy is branched from the main checkout's HEAD (prepare.ts); its recorded base is where its work is
  // merged (mg1). A reused copy keeps its base. A new one takes the repository's default base — its
  // origin/HEAD or main/master, overridable per repository and per plan — never whatever the shared main
  // checkout happens to have checked out; a person may choose deliberately with --base (bs1).
  let base: string | undefined
  let baseNotice: { checkedOut: string; base: string } | undefined
  if (view.task.worktree?.base) {
    base = view.task.worktree.base
  } else if (caller === 'person' && o.base) {
    base = o.base
  } else {
    base = (await resolveDefaultBase(o.root, o.exec, { planId: o.planId, plan })).branch
    const checkedOut = await checkedOutBranch(o.root, o.exec)
    if (checkedOut && base && checkedOut !== base) baseNotice = { checkedOut, base }
  }
  let wt: Awaited<ReturnType<typeof prepareWorktree>>
  try {
    wt = await prepareWorktree({ repoRoot: o.root, taskId: o.taskId, title: view.task.title, recipe, scope: o.scope, exec: o.exec, env: o.env, now: o.now, lang })
  } catch (err) {
    // prepare/baseline name the output file and show its last lines; the whole output stays in the file (tk1)
    if (err instanceof PrepareError) {
      const step = err.result.steps.at(-1)
      // The failure stays on the task (fo1): its panel says what happened and shows the saved output.
      await recordLaunchFailure(o, launchFailureOf('setup_failed', o.now(), step, err.step)).catch(() => undefined)
      throw stepError(lang, 'prepare', { error: err.step ? orchText(lang, 'prepare.stepFailed', { step: err.step }) : err.message }, step)
    }
    throw err
  }
  if (wt.baseline && !wt.baseline.ok) {
    // The refused copy stays on the task, so the person sees its red baseline in the panel and in
    // `worktree list`; the next launch reuses it and runs the baseline again (bl1).
    const failure = launchFailureOf('baseline_red', o.now(), wt.baseline, wt.baseline.step)
    await recordLaunchFailure(o, failure, { path: wt.path, branch: wt.branch, ...(base ? { base } : {}) })
    throw stepError(lang, 'baseline', { step: wt.baseline.step }, wt.baseline)
  }

  // Only Codex's subscription quota is sampled before a run. A Claude run goes through the API-only route,
  // so a subscription weekly percentage would be the wrong account's metric: none is recorded (historically
  // recorded quota on older plans is untouched).
  const quotaBeforePct = profile.backend === 'codex-cli' ? await codexQuotaUsedPercent() : undefined
  const backend = await o.backends.forAgent(profile.id)
  const startedAt = o.now().toISOString()
  // The resolved commercial channel of a Claude launch, recorded (without any secret) as run provenance.
  const anthropic = profile.backend === 'claude-code' ? evaluateAnthropicLaunchPolicy(o.env) : undefined
  // A Send back no run has read yet goes into this run's per-run part, whoever starts it (wk1, B29).
  const sendBack = pendingSendBack(view.task)
  const runContext = [o.runContext?.trim(), sendBack ? sendBackBlock(sendBack) : undefined].filter(Boolean).join('\n\n')
  const promptFile = await workerPrompt(o.root, o.taskId, contract, runContext || undefined, o.now())
  let runId: string
  try {
    runId = await backend.launch({ agent: profile.id, promptFile, cwd: wt.path, model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}) })
  } catch (err) {
    // The direct backend enforces the same API-only policy (a draft attempt, any direct caller): render it
    // here as the launch's own bilingual refusal instead of leaking a low-level error.
    if (err instanceof AnthropicPolicyError) throw launchError(lang, err.code, err.vars, err.message)
    throw err
  }
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
    task.worktree = { path: wt.path, branch: wt.branch, ...(base ? { base } : {}) }
    // A worker started: a failed preparation before it is history now (fo1).
    delete task.launchFailure
    // A new run replaces the work the orchestrator was checking: its check starts over when it finishes.
    delete task.check
    const canonicalId = canonicalWorkerId(profile.id, aliases)
    const provider = canonicalId.split('/')[0]
    // A Claude run is API-only now, so its billing mode is `api`; an `authChannel`/`policyRevision` records
    // which verified channel the launch resolved. Codex keeps its subscription default, others stay unknown.
    const billingMode = profile.backend === 'dsh' || profile.backend === 'claude-code' ? 'api' : profile.backend === 'codex-cli' ? 'subscription' : 'unknown'
    task.runs.push({ runId, agent: profile.id, rawAgent: profile.id, canonicalWorkerId: canonicalId, model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}), provider, billingMode, ...(anthropic?.allowed ? { authChannel: anthropic.channel, policyRevision: anthropic.policyRevision } : {}), identityResolution: canonicalId === profile.id ? 'launch_snapshot' : 'alias', attemptIndex: task.runs.length + 1, attemptTrigger: task.runs.length ? 'unknown' : 'initial', contractPath: contractRel, contractRevision, startedAt, workerChoice: choice, ...(quotaBeforePct !== undefined ? { quotaBeforePct } : {}) })
    // The built-in preset has no stored name: the screen names it in the reader's language.
    const preset = routing.preset.builtin ? {} : { preset: routing.preset.label }
    if (stale) {
      task.notes.push(eventNote(startedAt, 'comment', { kind: 'preset_fallback', stale, worker: profile.id, ...preset }))
    }
    if (outsidePreset) {
      task.notes.push(eventNote(startedAt, 'comment', { kind: 'launched_outside_preset', worker: profile.id, ...preset }))
    }
    // A worker the automatic pick passed over is never skipped silently (nb1): «claude/opus skipped: not logged in → codex/…».
    for (const item of skipped) task.notes.push(eventNote(startedAt, 'comment', { kind: 'worker_skipped', skipped: item.id, reason: item.short, worker: profile.id }))
    // Launching is the decision that the task is ready: a returned task or a draft starts as ready,
    // so its finished run lands in review rather than back where it came from.
    if (task.status === 'rejected' || task.status === 'backlog') task.status = 'ready'
    return next
  }, 5, o.planId)
  return { runId, agent: profile.id, worktree: { path: wt.path, branch: wt.branch, reused: wt.reused }, ...(contractWarnings.length ? { contractWarnings: { codes: contractWarnings, path: contractRel } } : {}), ...(skipped.length ? { skipped } : {}), ...(baseNotice ? { baseNotice } : {}) }
}

type LaunchFailure = NonNullable<Task['launchFailure']>

/** A preparation step that failed, as the task keeps it; a full disk is told apart from a broken recipe. */
function launchFailureOf(reason: 'setup_failed' | 'baseline_red', now: Date, step: StepResult | undefined, label: string | undefined): LaunchFailure {
  const full = step && classifyFailure('dsh', step.output).code === 'disk_full'
  return { at: now.toISOString(), reason: full ? 'disk_full' : reason, ...(label ? { step: label } : {}), ...(step?.log ? { log: step.log.path } : {}), ...(step?.output ? { text: step.output.slice(-300) } : {}) }
}

async function recordLaunchFailure(o: LaunchOptions, failure: LaunchFailure, worktree?: { path: string; branch: string; base?: string }): Promise<void> {
  await updatePlan(o.root, (next) => {
    const task = next.tasks.find((t) => t.id === o.taskId)
    if (task) {
      if (worktree) task.worktree = worktree
      task.launchFailure = failure
    }
    return next
  }, 5, o.planId)
}

/**
 * «Reset the copy» (fo1): back to its last commit — tracked changes discarded, untracked files removed, ignored
 * ones (dependencies, build output) and Crewboard's own files kept. Commits the worker made stay.
 */
async function resetCopy(path: string, exec: Exec): Promise<void> {
  for (const args of [['reset', '--hard', 'HEAD'], ['clean', '-fd', '-e', '.orchestration']]) {
    const r = await exec('git', ['-C', path, ...args])
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${path}: ${r.stderr.trim()}`)
  }
}

/** The refusal names the base and the exact commands that merge each waiting dependency. */
async function unmergedError(o: LaunchOptions, lang: MessageLang, deps: Plan['tasks']): Promise<LaunchError> {
  // bs1: named after the base a copy started now would actually take — the repository's default, never
  // whatever the main checkout happens to have checked out.
  const into = (await resolveDefaultBase(o.root, o.exec, { planId: o.planId })).branch ?? 'HEAD'
  const commands: string[] = []
  for (const dep of deps) {
    if (!dep.worktree) continue
    commands.push(...mergeCommands({ root: o.root, taskId: dep.id, ...dep.worktree, uncommitted: await uncommittedCount(dep.worktree.path, o.exec) }))
  }
  return launchError(lang, 'unmerged', { deps: deps.map((dep) => dep.id).join(', '), into, id: o.taskId, commands: commands.map((line) => `  ${line}`).join('\n') })
}

/** What picking a worker needs of a launch: where, whose machine, whether to skip preflight, and how much detail a refusal carries. */
type ChoiceOptions = Pick<LaunchOptions, 'root' | 'env' | 'home' | 'exec' | 'now' | 'lang' | 'skipPreflight' | 'verbose'>

/** What preflight says about one worker: the failed checks in full, the first one short, and whether its CLI is there. */
type Probe = { failure?: string; short?: string; installed: boolean; policy?: AnthropicPolicyCode; policyVars?: MessageVars }

async function probeWorker(o: ChoiceOptions, profile: AgentProfile): Promise<Probe> {
  // The API-only policy is evaluated before any machine probe and before `--skip-preflight`: that flag skips
  // the machine's checks, never the auth channel. It covers every worker whose resolved backend/model reaches
  // an Anthropic model (not the `claude/…` prefix alone). A refusal starts no worktree and no worker process.
  const route = classifyAnthropicRoute(profile, o.env)
  if (route.applies && !route.allowed) {
    const lang = isRu(o) ? 'ru' : 'en'
    return {
      installed: true,
      policy: route.code,
      policyVars: route.vars,
      failure: `✗ channel: ${orchText(lang, route.code, route.vars)}`,
      short: anthropicPolicyShort(lang, route.code),
    }
  }
  if (o.skipPreflight) {
    // Skipping preflight skips the machine's checks, not the worker's own settings: an effort the CLI rejects never starts (ef1).
    const effort = effortCheck(profile, isRu(o) ? 'ru' : 'en')
    return effort && !effort.ok ? { installed: true, failure: `✗ ${effort.name}: ${effort.detail}${effort.fix ? ` → ${effort.fix}` : ''}`, short: effort.detail } : { installed: true }
  }
  const codexUsedPercent = codexQuotaUsedPercent
  const env = { ...o.env, HOME: o.home }
  const lang = isRu(o) ? 'ru' : 'en'
  const pf = await cachedPreflight(o.root, profile, { exec: o.exec, codexUsedPercent, lang, env, commands: workerCommands(env) }, o.now())
  if (pf.ok) return { installed: true }
  const failed = pf.checks.filter((c) => !c.ok)
  const installed = !failed.some((c) => c.name === 'binary')
  return {
    installed,
    failure: failed.map((c) => `✗ ${c.name}: ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`).join('\n'),
    short: installed ? (failed[0]?.detail ?? '') : orchText(lang, 'skip.notInstalled'),
  }
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
async function chooseWorker(o: ChoiceOptions, routing: EffectiveRouting, cls: ReturnType<typeof classOfTask>, aliases: Record<string, string>, requested: string | undefined, origin: WorkerOrigin): Promise<{ profile: AgentProfile; skipped: SkippedWorker[] }> {
  const canonical = (id: string) => canonicalWorkerId(id, aliases)
  const ru = isRu(o)
  if (requested) {
    const agent = requested
    const disabledReason = Object.entries(routing.disabled).find(([id]) => canonical(id) === canonical(agent))?.[1]
    if (disabledReason !== undefined) throw new LaunchError('disabled', disabledMessage(ru, origin, agent, disabledReason || (ru ? 'причина не указана' : 'no reason given')))
    const dropped = routing.dropped.find((d) => d.id === agent || canonical(d.id) === canonical(agent))
    if (dropped?.reason === 'disabled') throw new LaunchError('disabled', disabledMessage(ru, origin, agent, ''))
    const profile = await resolveProfile(o.env, o.home, agent)
    const probe = await probeWorker(o, profile)
    if (probe.policy) throw launchError(ru ? 'ru' : 'en', probe.policy, probe.policyVars ?? {}, probe.failure)
    if (probe.failure) throw launchError(ru ? 'ru' : 'en', 'preflight', { agent: profile.id }, probe.failure)
    return { profile, skipped: [] }
  }
  const lang = ru ? 'ru' : 'en'
  const tried: string[] = []
  const skipped: SkippedWorker[] = []
  // Installed workers that failed a check, with what to fix (the refusal names them).
  const installed: string[] = []
  // Every backend tried, and whether its CLI was there at all — the refusal groups by this (rq1),
  // instead of naming every model, so a fresh machine with nothing signed in reads as one short block.
  const providerSeen = new Map<AgentProfile['backend'], boolean>()
  // A backend refused by the API-only policy is never reported as «installed but not signed in»: the
  // grouped refusal must not recommend a subscription login (routing/anthropic-policy.ts).
  const policySeen = new Map<AgentProfile['backend'], string>()
  // The built-in preset walks the class order, then every other known worker (nb1).
  for (const id of presetWorkers(routing, cls)) {
    const profile = await resolveProfile(o.env, o.home, id).catch(() => undefined)
    if (!profile) {
      const reason = orchText(lang, 'no_profile')
      tried.push(`✗ ${id}: ${reason}`)
      skipped.push({ id, reason, short: reason })
      continue
    }
    const probe = await probeWorker(o, profile)
    if (!probe.failure) return { profile, skipped }
    tried.push(`✗ ${id}:\n${probe.failure}`)
    skipped.push({ id, reason: probe.failure, short: probe.short ?? '' })
    if (probe.policy) { policySeen.set(profile.backend, probe.short ?? ''); continue }
    if (probe.installed) installed.push(`${id} (${probe.short})`)
    providerSeen.set(profile.backend, (providerSeen.get(profile.backend) ?? false) || probe.installed)
  }
  throw await noWorkerError(o, routing, cls, aliases, lang, installed, tried, providerSeen, policySeen)
}

/** A provider's CLI name and the command that signs it in, for the grouped refusal (rq1). */
const PROVIDER_INFO: Partial<Record<AgentProfile['backend'], { label: string; command: string }>> = {
  'claude-code': { label: 'Claude Code', command: 'claude auth login' },
  'codex-cli': { label: 'Codex', command: 'codex login' },
  'devin-cli': { label: 'Devin', command: 'devin auth login' },
}

/**
 * The refusal's grouped block (rq1): which CLIs are installed but not signed in, with the command that
 * fixes it, which are missing outright, which a policy refused (never shown with a login command), and —
 * separately, since it takes no CLI at all — a DeepSeek key in dsh. Empty when nothing was tried (a custom
 * preset with no fallback and only unresolvable ids).
 */
function groupedNoWorkerText(providerSeen: Map<AgentProfile['backend'], boolean>, policySeen: Map<AgentProfile['backend'], string>, lang: MessageLang): string {
  const notSignedIn: string[] = []
  const notInstalled: string[] = []
  const notReady: string[] = []
  const policyRefused: string[] = []
  let dsh = false
  for (const [backend, installedHere] of providerSeen) {
    if (backend === 'dsh') { dsh = true; continue }
    const info = PROVIDER_INFO[backend]
    if (!info) continue
    const refused = policySeen.get(backend)
    if (refused !== undefined) policyRefused.push(`${info.label} — ${refused}`)
    // Claude is never signed in or out under the API-only policy: an installed but failing CLI (version,
    // --bare) takes the API-config/update next step, never `claude auth login`; a missing one stays missing.
    else if (backend === 'claude-code') {
      if (installedHere) notReady.push(`${info.label} (set ${ANTHROPIC_API_KEY_REF}, or run claude update)`)
      else notInstalled.push(info.label)
    }
    else if (installedHere) notSignedIn.push(`${info.label} (${info.command})`)
    else notInstalled.push(info.label)
  }
  for (const [backend, reason] of policySeen) {
    if (providerSeen.has(backend) || backend === 'dsh') continue
    const info = PROVIDER_INFO[backend]
    if (info) policyRefused.push(`${info.label} — ${reason}`)
  }
  const lines: string[] = []
  if (policyRefused.length) lines.push(orchText(lang, 'no_worker.policyRefused', { list: policyRefused.join(', ') }))
  if (notReady.length) lines.push(orchText(lang, 'no_worker.notReady', { list: notReady.join(', ') }))
  if (notSignedIn.length) lines.push(orchText(lang, 'no_worker.notSignedIn', { list: notSignedIn.join(', ') }))
  if (notInstalled.length) lines.push(orchText(lang, 'no_worker.notInstalled', { list: notInstalled.join(', ') }))
  if (dsh) lines.push(orchText(lang, 'no_worker.dsh'))
  return lines.length ? `\n${lines.join('\n')}` : ''
}

/**
 * «No worker for Code» says what could run it (nb1): installed workers that are ready but outside the preset,
 * or installed ones a check stopped — and the command that routes the class to one of them.
 */
async function noWorkerError(o: ChoiceOptions, routing: EffectiveRouting, cls: TaskClass, aliases: Record<string, string>, lang: MessageLang, installed: string[], tried: string[], providerSeen: Map<AgentProfile['backend'], boolean>, policySeen: Map<AgentProfile['backend'], string>): Promise<LaunchError> {
  const canonical = (id: string) => canonicalWorkerId(id, aliases)
  const walked = presetWorkers(routing, cls)
  const ready: string[] = []
  if (!routing.preset.builtin) {
    const registry = await loadRegistry(registryPath(o.env, o.home)).catch(() => ({ workers: DEFAULT_WORKERS }))
    for (const { id } of registry.workers) {
      if (walked.some((other) => canonical(other) === canonical(id))) continue
      if (Object.keys(routing.disabled).some((other) => canonical(other) === canonical(id))) continue
      const profile = await resolveProfile(o.env, o.home, id).catch(() => undefined)
      if (!profile) continue
      const probe = await probeWorker(o, profile)
      if (!probe.failure) ready.push(id)
      else if (probe.policy) policySeen.set(profile.backend, probe.short ?? '')
      else if (probe.installed) installed.push(`${id} (${probe.short})`)
    }
  }
  const candidates = [...ready.map((id) => orchText(lang, 'no_worker.ready', { id })), ...installed].join(', ') || orchText(lang, 'no_worker.none')
  const first = ready[0] ?? installed[0]?.split(' ')[0]
  // For the built-in preset, `installed` is exactly what `grouped` already summarises by provider, and `ready`
  // is always empty (the loop above only runs for a custom preset) — so the per-model list is verbose-only
  // there (rq1): a fresh machine's refusal is one short grouped block, not one line per model, printed once.
  // A custom preset can name a worker outside itself that already works (`ready`), which `grouped` never
  // covers (it only tracks the preset's own candidates) — that hint stays visible by default.
  const showList = o.verbose || !routing.preset.builtin
  const vars = {
    class: lang === 'ru' ? CLASS_LABEL_RU[cls] : CLASS_LABEL[cls],
    alternatives: showList ? orchText(lang, 'no_worker.list', { candidates }) : '',
    route: `${orchText(lang, 'no_worker.route', { cls, id: first ?? '<worker>' })}`,
    grouped: groupedNoWorkerText(providerSeen, policySeen, lang),
  }
  // Per-model detail (one raw preflight failure per candidate) only with --verbose; the message itself
  // already groups by provider (rq1) — a fresh machine's refusal is one short block, not ten lines.
  return launchError(lang, 'no_worker', vars, o.verbose ? tried.join('\n') || undefined : undefined)
}

/**
 * A preset worker passed over by an automatic pick, and why: its failed preflight checks, one per line, and the
 * first of them in a few words (`short`: «not logged in», «not installed») for the run output and the task note.
 */
export type SkippedWorker = { id: string; reason: string; short: string }
export type DraftWorkerChoice = { agent: string; model: string; origin: 'explicit' | 'auto'; skipped: SkippedWorker[] }

/**
 * The worker of a draft from a spec is picked exactly like a run's (dr2): an explicit worker is checked for
 * a prohibition, a profile and preflight and refused rather than replaced; without one the research
 * preset order is walked and the first worker that passes preflight writes the draft. The skipped workers
 * come back with their reasons, so the screen and the CLI can say why the pick is not the first in line.
 */
export async function chooseDraftWorker(o: ChoiceOptions & { agent?: string }): Promise<DraftWorkerChoice> {
  const routing = await resolveRouting(o.root, undefined, { ...o.env, HOME: o.home })
  const aliases = (await loadProfileStore({ ...o.env, HOME: o.home }, o.home)).aliases
  const explicit = o.agent !== undefined && !isAutoWorker(o.agent) ? o.agent : undefined
  // No --verbose flag for drafts (rq1 only added one to `run`): a refusal here keeps the full per-worker detail.
  const { profile, skipped } = await chooseWorker({ ...o, verbose: true }, routing, 'research', aliases, explicit, explicit === undefined ? 'auto' : 'explicit')
  return { agent: profile.id, model: profile.model, origin: explicit === undefined ? 'auto' : 'explicit', skipped }
}
