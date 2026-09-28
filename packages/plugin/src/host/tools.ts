import {
  type Backends,
  type DshWorkspace,
  type EffectiveRouting,
  type Plan,
  assertWorkerChoice,
  acceptTask,
  answerDecision,
  automaticAcceptance,
  assertAutomaticMerge,
  assignWorker,
  buildRepoSnapshot,
  buildTrajectory,
  PLAN_DRAFT_EXAMPLE,
  PLAN_DRAFT_JSON_SCHEMA,
  advanceDraftJob,
  chooseDraftWorker,
  advanceDraftJobs,
  callerOf,
  classOfTask,
  isAutoWorker,
  loadPresetAuthority,
  checkDraft,
  checkPassed,
  gcAfterAccept,
  ChecksError,
  runContractChecks,
  DetailError,
  discardDraftJob,
  doneFacts,
  draftJobAnswer,
  findingsOf,
  getTaskShow,
  launchTask,
  continueTask,
  loadPlan,
  mergeTask,
  mergeWorkspaces,
  needsYou,
  newTask,
  nodeExec,
  prepareDecision,
  normalize,
  saveDraft,
  steerTask,
  finishCheck,
  attestResult,
  startOwnWork,
  setTaskKind,
  TASK_KINDS,
  returnFromCheck,
  takeCheck,
  takeUncommittedForCheck,
  repairDraftJob,
  summarizeDraftJob,
  stopTask,
  updatePlan,
  worktreeConfigPath,
  TASK_CLASSES,
  contractPathFor,
  contractTemplate,
  decisionTemplate,
  contractWarnings,
  currentPlanId,
  isOwnWork,
  orchText,
  writeNewContract,
} from '@crewboard/core'
import { realpathSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { planOfSession } from './chat.js'
import type { DshToolDefinition } from './dsh.js'
import type { OrchestraService } from './service.js'
import { hostT, type HostLang } from './i18n.js'

/** Who calls a tool: the dsh session, when dsh names it — a chat bound to a plan acts on that plan only (B22). */
export type ToolCall = { sessionId?: string }
export type ToolSpec = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, call?: ToolCall): Promise<unknown>
}
export type ToolsDeps = {
  service: OrchestraService
  repos: string[]
  /** dsh workspaces; together with `repos` they form the list the `repo` argument is checked against. */
  workspaces?(): DshWorkspace[]
  backendsFor(root: string): Backends
  env: NodeJS.ProcessEnv
  home: string
  now(): Date
  lang?: () => HostLang
}

const KINDS = TASK_KINDS

/**
 * What the orchestrator hears about a task's contract after an upsert (ct1): none yet — `run` will refuse it;
 * one without checks or without the result line — a warning, never a refusal.
 */
async function contractNotice(root: string, task: Plan['tasks'][number] | undefined, lang: HostLang): Promise<{ needsContract: true; notice: string } | { warnings: string[] } | Record<string, never>> {
  if (!task || isOwnWork(task.kind)) return {}
  if (!task.contract) return { needsContract: true, notice: orchText(lang, 'no_contract', { id: task.id }) }
  const text = await readFile(resolve(root, task.contract), 'utf8').catch(() => undefined)
  if (text === undefined) return { warnings: [orchText(lang, 'contract_missing', { path: task.contract })] }
  const codes = contractWarnings(text)
  return codes.length ? { warnings: codes.map((code) => orchText(lang, `contract_${code}`, { id: task.id, path: task.contract ?? '' })) } : {}
}
const MAX_SPANS = 150
const MAX_EVENTS = 100

export function toDshTool(spec: ToolSpec): DshToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => spec.execute(args ?? {}, typeof exec?.agent?.id === 'string' ? { sessionId: exec.agent.id } : {}),
  }
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute repository root; optional when one repo is configured.' },
    plan: { type: 'string', description: 'Plan id; optional. A chat bound to a plan always acts on that plan and a different id is refused; otherwise the current plan.' },
    ...properties,
  },
  required,
  additionalProperties: false,
})
const str = (description: string) => ({ type: 'string', description })

const knownRoots = (deps: ToolsDeps): string[] => [...new Set([...mergeWorkspaces(deps.workspaces?.() ?? [], deps.repos), ...deps.service.repositories()].map((r) => r.root))]

/** One spelling per directory: `/tmp/x/` and `/private/tmp/x` name the same repository (op1, ux2:F15). */
const canonical = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}
const sameRoot = (a: string, b: string): boolean => a === b || canonical(a) === canonical(b)

function pickRepo(deps: ToolsDeps, repo: unknown): string {
  const roots = knownRoots(deps)
  if (typeof repo === 'string' && repo) {
    const known = roots.find((root) => sameRoot(root, repo))
    if (!known) throw new Error(`repo ${repo} is not a dsh workspace or a Crewboard repository. Known: ${roots.join(', ') || '(none)'}. To add it, the person runs: crewboard repo add ${canonical(repo)}`)
    return known
  }
  const [only] = roots
  if (roots.length === 1 && only) return only
  throw new Error(`specify repo: one of ${roots.join(', ') || '(none configured)'}`)
}

function lastRun(plan: Plan, taskId: string) {
  const task = plan.tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`no task ${taskId}`)
  const run = task.runs.at(-1)
  if (!run) throw new Error(`task ${taskId} has no runs yet`)
  return run
}

const text = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`${field} is required`)
  return v
}
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)

/**
 * dsh accepts only lossless JSON from a tool (no `undefined`, NaN, Infinity, -0 or class instances) and
 * fails the whole call otherwise. A JSON round trip is the same shape a model would read, so every
 * tool's result passes through it: an optional field left `undefined` drops instead of breaking the tool.
 */
export function toLosslessJson(value: unknown): unknown {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0)) ? (Number.isFinite(v) ? 0 : null) : v)))
}

export function orchestraTools(deps: ToolsDeps): ToolSpec[] {
  const lang = () => deps.lang?.() ?? 'en'
  /**
   * The repository and plan a call acts on (B22). A session bound to a plan (`chats.json`) acts on that
   * plan in its repository: the host adds it to every call, and naming another plan or repository is
   * refused. An unbound call acts on the plan it names, else on the current one — `undefined`, so the
   * store's rules for the current plan (an archived one is not written implicitly) apply.
   */
  const target = async (a: Record<string, unknown>, call?: ToolCall): Promise<{ root: string; planId?: string }> => {
    const asked = typeof a.plan === 'string' && a.plan ? a.plan : undefined
    const sessionId = call?.sessionId
    if (sessionId) {
      for (const root of knownRoots(deps)) {
        const bound = await planOfSession(root, sessionId).catch(() => undefined)
        if (!bound) continue
        const repoMismatch = typeof a.repo === 'string' && a.repo && !sameRoot(a.repo, root)
        if ((asked && asked !== bound) || repoMismatch) throw new Error(hostT(lang(), 'tools.planMismatch', { bound, root, asked: asked ?? bound, repo: repoMismatch ? String(a.repo) : root }))
        return { root, planId: bound }
      }
    }
    return { root: pickRepo(deps, a.repo), ...(asked ? { planId: asked } : {}) }
  }
  /** The plan as the screen models it; the served snapshot when it shows this plan, else one built for it. */
  const planSnapshot = async (root: string, planId?: string) => {
    await deps.service.refresh(root)
    const snap = deps.service.snapshot().repos.find((r) => r.root === root)
    if (!snap) throw new Error(`no snapshot for ${root}`)
    if (planId === undefined || snap.planId === planId) return snap
    return buildRepoSnapshot(root, deps.backendsFor(root), deps.now(), planId)
  }
  /**
   * The snapshot as the chat reads it (op1, ux2:F16): the preset's routing once, as `effectiveRouting.routing` —
   * not again inside `preset` or on every plan of the list; this chat acts on one plan.
   */
  const planAnswer = (snap: Awaited<ReturnType<typeof planSnapshot>>) => {
    const { effectiveRouting, plans, ...rest } = snap as typeof snap & { effectiveRouting?: EffectiveRouting }
    return {
      ...rest,
      ...(plans ? { plans: (plans as Array<(typeof plans)[number] & { effectiveRouting?: EffectiveRouting }>).map(({ effectiveRouting: _routing, ...plan }) => plan) } : {}),
      ...(effectiveRouting ? { effectiveRouting: { ...effectiveRouting, preset: { id: effectiveRouting.preset.id, label: effectiveRouting.preset.label, ...(effectiveRouting.preset.builtin ? { builtin: true } : {}) } } } : {}),
    }
  }
  const afterWrite = async (root: string) => {
    await deps.service.refresh(root)
  }

  const tools: ToolSpec[] = [
    {
      name: 'orchestra_plan_draft',
      description: hostT(lang(), 'tools.planDraft', { example: JSON.stringify(PLAN_DRAFT_EXAMPLE) }),
      parameters: schema({ draft: { ...PLAN_DRAFT_JSON_SCHEMA, description: 'PlanDraft JSON' } }, ['draft']),
      execute: async (a, call) => {
        const { root } = await target(a, call)
        try {
          const draft = await saveDraft(root, a.draft)
          return { id: draft.id, findings: checkDraft(draft) }
        } catch (err) {
          const findings = findingsOf(err)
          if (findings) throw new Error(hostT(lang(), 'tools.draftRefused', { findings: JSON.stringify(findings) }))
          throw err
        }
      },
    },
    {
      name: 'orchestra_draft_jobs',
      description: hostT(lang(), 'tools.draftJobs'),
      parameters: schema({ job: str('Draft job id (dj-…); omit to list') }),
      execute: async (a, call) => {
        const { root } = await target(a, call)
        if (typeof a.job === 'string' && a.job) {
          const job = await advanceDraftJob(root, a.job, deps.backendsFor(root), deps.now())
          const answer = await draftJobAnswer(root, job)
          return { job: summarizeDraftJob(job), ...(answer !== undefined ? { answer } : {}) }
        }
        const jobs = await advanceDraftJobs(root, deps.backendsFor(root), deps.now())
        return jobs.filter((job) => job.status === 'running' || job.status === 'needs_repair' || job.status === 'failed').map(summarizeDraftJob)
      },
    },
    {
      name: 'orchestra_draft_job_repair',
      description: hostT(lang(), 'tools.draftJobRepair'),
      parameters: schema({ job: str('Draft job id (dj-…)'), action: { type: 'string', enum: ['repair', 'discard'] }, agent: str('Worker for the retry; omit to keep a worker the job was given, or to pick again from the research preset when the job picked automatically') }, ['job', 'action']),
      execute: async (a, call) => {
        const { root } = await target(a, call)
        const id = text(a.job, 'job')
        if (a.action === 'discard') return summarizeDraftJob(await discardDraftJob(root, id, deps.backendsFor(root), deps.now()))
        if (a.action !== 'repair') throw new Error('action must be repair or discard')
        // Picked like a run's worker (dr2): a named one must pass preflight; a job whose worker was picked automatically picks again.
        const pick = (agent?: string) => chooseDraftWorker({ root, env: deps.env, home: deps.home, exec: nodeExec, now: () => deps.now(), lang: deps.lang?.() ?? 'en', ...(agent ? { agent } : {}) })
        const agent = typeof a.agent === 'string' && a.agent && a.agent !== 'auto' ? (await pick(a.agent)).agent : undefined
        const job = await repairDraftJob({ root, id, backends: deps.backendsFor(root), now: deps.now(), choose: async () => (await pick()).agent, ...(agent ? { agent } : {}) })
        await afterWrite(root)
        return summarizeDraftJob(job)
      },
    },
    {
      name: 'orchestra_plan',
      description: 'Return the task plan with derived statuses (ready, running, blocked, in_review, accepted), ready set, critical path and attention items.',
      parameters: schema({}),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        return planAnswer(await planSnapshot(root, planId))
      },
    },
    {
      name: 'orchestra_attention',
      description: hostT(lang(), 'tools.attention'),
      parameters: schema({}),
      // The same «Needs you» model as `crewboard attention --json` (B11): reviews, decisions, run alarms, other plans that wait.
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const snap = await planSnapshot(root, planId)
        return needsYou([{ ...snap, hidden: false }], { root, planId: snap.planId })
      },
    },
    {
      name: 'orchestra_task',
      description: hostT(lang(), 'tools.task'),
      parameters: schema({ task: str('Task id') }, ['task']),
      // The same structure as `crewboard task show --json` (ts1): the task panel's detail plus merge state, diffstat and checks.
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        await deps.service.refresh(root)
        try {
          return await getTaskShow(root, text(a.task, 'task'), deps.backendsFor(root), nodeExec, planId)
        } catch (err) {
          if (err instanceof DetailError) throw new Error(orchText(lang(), err.code, err.vars))
          throw err
        }
      },
    },
    {
      name: 'orchestra_events',
      description: 'Return the meaningful event feed (actions, file edits, messages, steers, problems) of the last run of a task.',
      parameters: schema({ task: str('Task id') }, ['task']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const run = lastRun(await loadPlan(root, planId), text(a.task, 'task'))
        const backend = await deps.backendsFor(root).forAgent(run.agent, run.runId)
        return normalize(await backend.events(run.runId)).slice(-MAX_EVENTS)
      },
    },
    {
      name: 'orchestra_trace',
      description: 'Return the trajectory of the last run of a task: turns, model/tool/input/problem spans and totals.',
      parameters: schema({ task: str('Task id') }, ['task']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const run = lastRun(await loadPlan(root, planId), text(a.task, 'task'))
        const backend = await deps.backendsFor(root).forAgent(run.agent, run.runId)
        const t = buildTrajectory(await backend.events(run.runId), { startedAt: run.startedAt, finishedAt: run.finishedAt }, deps.now())
        return { ...t, spans: t.spans.slice(-MAX_SPANS) }
      },
    },
    {
      name: 'orchestra_task_upsert',
      description: hostT(lang(), 'tools.taskUpsert'),
      parameters: schema(
        {
          id: str('Task id: lowercase letters, digits and dashes'),
          title: str('Title'),
          kind: { type: 'string', enum: [...KINDS] },
          lane: str('Plan stage shown as a lane on the graph'),
          deps: { type: 'array', items: { type: 'string' } },
          class: { type: 'string', enum: [...TASK_CLASSES], description: 'Task class: which worker list of the preset runs it' },
          worker: str(hostT(lang(), 'tools.workerParam')),
          contract: str('Contract file path relative to the repo; omit it to have Crewboard write one from `result` and `checks`'),
          context: str('Contract: why the task exists and what it builds on'),
          result: str('Contract: what must be true when the work is done — files, behaviour, where'),
          checks: { type: 'array', items: { type: 'string' }, description: 'Contract: commands a reviewer runs, one per item' },
          outOfScope: { type: 'array', items: { type: 'string' }, description: 'Contract: what the worker must leave alone' },
          sources: { type: 'array', items: { type: 'string' }, description: 'Contract: specification sections or files the task comes from' },
          status: { type: 'string', enum: ['backlog', 'ready'] },
        },
        ['id'],
      ),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const id = text(a.id, 'id')
        if (a.status === 'accepted' || a.status === 'rejected') throw new Error('task_upsert cannot close work: use orchestra_close for routine checked work, or the Crewboard screen for human decisions')
        if (a.kind !== undefined && !(KINDS as readonly unknown[]).includes(a.kind)) throw new Error(`unknown kind ${String(a.kind)}`)
        if (a.class !== undefined && !(TASK_CLASSES as readonly unknown[]).includes(a.class)) throw new Error(`unknown class ${String(a.class)}: ${TASK_CLASSES.join(', ')}`)
        const taskClass = a.class as Plan['tasks'][number]['class']
        // The one contract template (ct1): `result` and `checks` become a contract file when no path is given.
        const brief = typeof a.result === 'string' && a.result.trim() && typeof a.contract !== 'string'
          ? { result: a.result, context: typeof a.context === 'string' ? a.context : undefined, checks: list(a.checks), outOfScope: list(a.outOfScope), sources: list(a.sources) }
          : undefined
        const before = (await loadPlan(root, planId)).tasks.find((t) => t.id === id)
        if (brief && before?.contract) throw new Error(`task ${id} already has a contract (${before.contract}): edit that file, or pass contract to point at another one`)
        const written = brief ? contractPathFor(planId ?? currentPlanId(root), id) : undefined
        if (written && brief) {
          const kind = (a.kind as (typeof KINDS)[number] | undefined) ?? before?.kind ?? 'implement'
          if (isOwnWork(kind)) throw new Error(`a ${kind} task runs no worker and takes no contract`)
          await writeNewContract(root, written, contractTemplate({ goal: typeof a.title === 'string' && a.title.trim() ? a.title : before?.title ?? id, ...brief, lang: deps.lang?.() ?? 'en' }))
        }
        // A chat tool is always an agent: it may name only a worker of the effective preset, or `auto`.
        const caller = callerOf({ kind: 'tool' })
        const worker = typeof a.worker === 'string' ? a.worker : undefined
        const authority = worker !== undefined && !isAutoWorker(worker) ? await loadPresetAuthority({ root, planId, env: deps.env, home: deps.home }) : undefined
        const checkWorker = (task: { kind: string; class?: Plan['tasks'][number]['class'] }) => {
          if (authority && worker !== undefined) assertWorkerChoice({ caller, ...authority, taskClass: classOfTask(task), worker, lang: deps.lang?.() ?? 'en' })
        }
        const contract = typeof a.contract === 'string' ? a.contract : written
        const plan = await updatePlan(root, (p) => {
          const existing = p.tasks.find((t) => t.id === id)
          if (!existing) {
            const task = newTask({
              id,
              title: text(a.title, 'title'),
              kind: (a.kind as (typeof KINDS)[number] | undefined) ?? 'implement',
              class: taskClass,
              lane: typeof a.lane === 'string' ? a.lane : undefined,
              deps: list(a.deps) ?? [],
              contract,
              status: a.status === 'backlog' ? 'backlog' : 'ready',
            })
            checkWorker(task)
            if (worker !== undefined) assignWorker(task, worker, caller)
            p.tasks.push(task)
            return p
          }
          // The same rule as `task set --kind` (rt1): only an open task changes kind.
          if (a.kind !== undefined) setTaskKind(existing, a.kind as (typeof KINDS)[number])
          if (typeof a.title === 'string') existing.title = a.title
          if (typeof a.lane === 'string') existing.lane = a.lane
          if (list(a.deps)) existing.deps = list(a.deps) ?? []
          if (worker !== undefined) {
            checkWorker(existing)
            assignWorker(existing, worker, caller)
          }
          if (taskClass) existing.class = taskClass
          if (contract) existing.contract = contract
          if (a.status === 'backlog' || a.status === 'ready') existing.status = a.status
          return p
        }, 5, planId).catch(async (err: unknown) => {
          // A refused write leaves no contract file behind.
          if (written) await rm(resolve(root, written), { force: true })
          throw err
        })
        await afterWrite(root)
        const task = plan.tasks.find((t) => t.id === id)
        return { ...task, ...(await contractNotice(root, task, lang())) }
      },
    },
    {
      name: 'orchestra_decision',
      description: 'Add a decision task for the person to choose; tasks depending on it stay blocked until answered. `context` and `options` become its brief. Prepare options, your recommendation and consequences with orchestra_verify action=done before asking. If the person already answered in chat, record that answer with orchestra_decision_answer; do not ask for a second panel confirmation. For work you do yourself use kind root instead.',
      parameters: schema({ id: str('Task id'), title: str('What the human decides'), deps: { type: 'array', items: { type: 'string' } }, context: str('Why the question comes up and what depends on the answer'), options: { type: 'array', items: { type: 'string' }, description: 'The choices, one per item' } }, ['id', 'title']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const id = text(a.id, 'id')
        const title = text(a.title, 'title')
        const context = typeof a.context === 'string' && a.context.trim() ? a.context : undefined
        const options = list(a.options)?.filter((option) => option.trim())
        // The brief is the decision's contract (op1, ux2:F17): the panel builds its checklist from it.
        const brief = context || options?.length ? contractPathFor(planId ?? currentPlanId(root), id) : undefined
        if (brief) {
          if ((await loadPlan(root, planId)).tasks.some((t) => t.id === id)) throw new Error(`task ${id} already exists`)
          await writeNewContract(root, brief, decisionTemplate({ goal: title, context, options, lang: lang() }))
        }
        const plan = await updatePlan(root, (p) => {
          if (p.tasks.some((t) => t.id === id)) throw new Error(`task ${id} already exists`)
          p.tasks.push(newTask({ id, title, kind: 'decision', deps: list(a.deps) ?? [], ...(brief ? { contract: brief } : {}) }))
          return p
        }, 5, planId).catch(async (err: unknown) => {
          if (brief) await rm(resolve(root, brief), { force: true })
          throw err
        })
        await afterWrite(root)
        return plan.tasks.find((t) => t.id === id)
      },
    },
    {
      name: 'orchestra_decision_answer',
      description: hostT(lang(), 'tools.decisionAnswer'),
      parameters: schema({
        task: str('Decision task id'),
        answer: str('The answer the person gave, as they gave it'),
        basis: str('Where the person gave it: the chat message or reference this record rests on'),
      }, ['task', 'answer', 'basis']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const answer = text(a.answer, 'answer')
        const basis = text(a.basis, 'basis')
        const { task, repeated } = await answerDecision(root, text(a.task, 'task'), answer, basis, deps.now(), { planId, lang: lang() })
        await afterWrite(root)
        return { task: task.id, status: task.status, answer, basis, ...(repeated ? { alreadyRecorded: true } : {}) }
      },
    },
    {
      name: 'orchestra_decision_prepare',
      description: hostT(lang(), 'tools.decisionPrepare'),
      parameters: schema({
        task: str('Decision task id'),
        reason: str('The person\'s instruction — why the question goes back to preparation'),
      }, ['task', 'reason']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const task = await prepareDecision(root, text(a.task, 'task'), text(a.reason, 'reason'), deps.now(), { planId, lang: lang(), by: 'orchestrator' })
        await afterWrite(root)
        return { task: task.id, status: task.status, note: 'prepare it again with orchestra_verify action=done: options, your recommendation, consequences' }
      },
    },
    {
      name: 'orchestra_run',
      description: hostT(lang(), 'tools.run'),
      parameters: schema({ task: str('Task id'), agent: str(hostT(lang(), 'tools.agentParam')), contract: str('Contract path, optional'), scope: str('Baseline scope, optional') }, [
        'task',
      ]),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const taskId = text(a.task, 'task')
        // A run that ended unfinished (bg1) is continued with the direction to finish and report, not started over.
        const incomplete = !a.agent && !a.contract && (await loadPlan(root, planId)).tasks.find((t) => t.id === taskId)?.runs.at(-1)?.outcome === 'incomplete'
        if (incomplete) {
          const continued = await continueTask({ root, taskId, planId, caller: callerOf({ kind: 'tool' }), backends: deps.backendsFor(root), exec: nodeExec, env: deps.env, home: deps.home, now: () => deps.now(), lang: deps.lang?.() })
          await afterWrite(root)
          return { ...continued, continued: true }
        }
        const result = await launchTask({
          root,
          taskId,
          planId,
          ...(typeof a.agent === 'string' && a.agent ? { agent: a.agent } : {}),
          caller: callerOf({ kind: 'tool' }),
          contract: typeof a.contract === 'string' ? a.contract : undefined,
          scope: typeof a.scope === 'string' ? a.scope : undefined,
          backends: deps.backendsFor(root),
          exec: nodeExec,
          env: deps.env,
          home: deps.home,
          now: () => deps.now(),
          lang: deps.lang?.(),
        })
        await afterWrite(root)
        const { contractWarnings, ...launched } = result
        return contractWarnings ? { ...launched, warnings: contractWarnings.codes.map((code) => orchText(lang(), `contract_${code}`, { id: taskId, path: contractWarnings.path })) } : launched
      },
    },
    {
      name: 'orchestra_steer',
      description: 'Send a self-contained correction to the running worker of a task.',
      parameters: schema({ task: str('Task id'), message: str('Correction') }, ['task', 'message']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const r = await steerTask(root, text(a.task, 'task'), { message: text(a.message, 'message') }, deps.backendsFor(root), deps.now(), planId)
        await afterWrite(root)
        return { ...r, notice: hostT(lang(), `steer.${r.delivery}`, { ...r, state: r.state ?? '' }) }
      },
    },
    {
      name: 'orchestra_verify',
      description: hostT(lang(), 'tools.verify'),
      parameters: schema({ task: str('Task id'), action: { type: 'string', enum: ['start', 'take', 'takeover', 'reopen', 'done', 'attest', 'return', 'checks'] }, verdict: { type: 'string', enum: ['result', 'negative', 'disputed'], description: 'attest: explicit independent result judgement' }, note: str('done: what you checked (gates, stand, fixes); takeover: why the incomplete copy is preserved; attest: concise independent review summary; return: findings'), report: str('done: report path; attest: proof report path in the repository'), confirm: { type: 'boolean', description: 'done: mark checked although the verdict is disputed or no file changed' } }, ['task', 'action']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const taskId = text(a.task, 'task')
        if (a.action === 'attest') {
          if (typeof a.verdict !== 'string' || !['result', 'negative', 'disputed'].includes(a.verdict) || typeof a.report !== 'string' || !a.report) throw new Error('attest requires verdict=result|negative|disputed and a report path')
          const file = resolve(root, a.report)
          const rel = relative(root, file)
          if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('report must be a file inside the repo')
          const proof = await readFile(file, 'utf8')
          const task = await attestResult(root, taskId, a.verdict as 'result' | 'negative' | 'disputed', proof, text(a.note, 'note'), deps.now(), { planId, by: 'orchestrator' })
          await afterWrite(root)
          return { task: taskId, attestation: task.resultAttestations?.at(-1) }
        }
        if (a.action === 'takeover') {
          const task = await takeUncommittedForCheck(root, taskId, text(a.note, 'note'), deps.now(), { planId, by: 'orchestrator' })
          await afterWrite(root)
          return { task: taskId, check: task.check }
        }
        if (a.action === 'start') {
          const task = await startOwnWork(root, taskId, deps.now(), { planId, by: 'orchestrator' })
          await afterWrite(root)
          return { task: taskId, started: task.started }
        }
        if (a.action === 'take' || a.action === 'reopen') {
          const task = await takeCheck(root, taskId, deps.now(), { planId, by: 'orchestrator', reopen: a.action === 'reopen' })
          await afterWrite(root)
          // Taking checked work again changes nothing (B10): it stays with the person until action=reopen.
          if (task.check?.state === 'checked') return { task: taskId, check: task.check, alreadyChecked: true, notice: hostT(lang(), 'tools.alreadyChecked', { id: taskId }) }
          return { task: taskId, check: task.check }
        }
        if (a.action === 'done') {
          let report: string | undefined
          if (typeof a.report === 'string' && a.report) {
            const file = resolve(root, a.report)
            const rel = relative(root, file)
            if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('report must be a file inside the repo')
            report = await readFile(file, 'utf8')
          }
          const note = text(a.note, 'note')
          // The verdict the person will see (B10): disputed or empty work is marked checked only on purpose.
          const facts = await doneFacts(root, taskId, deps.backendsFor(root), nodeExec, planId)
          const verdict = facts && { kind: facts.verdict.kind, ...(facts.verdict.mismatch ? { mismatch: facts.verdict.mismatch } : {}), ...(facts.verdict.why ? { why: facts.verdict.why } : {}), files: facts.files }
          if (facts?.needsConfirm && a.confirm !== true && report === undefined) throw new Error(hostT(lang(), 'tools.doneUnconfirmed', { id: taskId, verdict: JSON.stringify(verdict) }))
          const task = await finishCheck(root, taskId, note, deps.now(), { planId, by: 'orchestrator', ...(report !== undefined ? { report } : {}) })
          await afterWrite(root)
          const finalFacts = report !== undefined && facts ? await doneFacts(root, taskId, deps.backendsFor(root), nodeExec, planId) : facts
          const finalVerdict = finalFacts && { kind: finalFacts.verdict.kind, ...(finalFacts.verdict.mismatch ? { mismatch: finalFacts.verdict.mismatch } : {}), ...(finalFacts.verdict.why ? { why: finalFacts.verdict.why } : {}), files: finalFacts.files }
          return { task: taskId, status: task.status, check: task.check, ...(finalVerdict ? { verdict: finalVerdict } : {}) }
        }
        if (a.action === 'checks') {
          // Crewboard runs the contract's <checks> in the copy (ck1), a fact next to the worker's claim.
          const record = await runContractChecks({ root, taskId, planId, by: 'orchestrator', exec: nodeExec, env: deps.env, now: () => deps.now(), lang: lang() }).catch((err: unknown) => {
            if (err instanceof ChecksError) throw new Error(orchText(lang(), `checks.${err.code}`, err.vars))
            throw err
          })
          await afterWrite(root)
          const checks = record.checks.map(({ command, exitCode, timedOut, durationMs, output, tail }) => ({ command, passed: checkPassed({ exitCode, timedOut }), exitCode, ...(timedOut ? { timedOut } : {}), durationMs, output, ...(checkPassed({ exitCode, timedOut }) ? {} : { tail }) }))
          return { task: taskId, runId: record.runId, passed: checks.filter((c) => c.passed).length, total: checks.length, checks }
        }
        if (a.action !== 'return') throw new Error('action must be start, take, reopen, done, return or checks')
        const launched = await returnFromCheck({ root, taskId, planId, findings: text(a.note, 'note'), by: 'orchestrator', caller: callerOf({ kind: 'tool' }), backends: deps.backendsFor(root), exec: nodeExec, env: deps.env, home: deps.home, now: () => deps.now(), lang: deps.lang?.() })
        await afterWrite(root)
        return { task: taskId, returned: true, ...launched }
      },
    },
    {
      name: 'orchestra_close',
      description: 'Automatically accept and merge routine checked work. A completed run with a positive verdict, no dirty files or conflicts, and all listed contract checks green is required. Decisions, root work, disputed results, and contracts with <human_review> stay with the person. Use action=merge to finish a previously accepted task. If the recorded base is wrong, pass the checked-out plan branch as into.',
      parameters: schema({ task: str('Task id'), action: { type: 'string', enum: ['accept', 'merge', 'both'] }, into: str('Optional target branch when the recorded task base is wrong') }, ['task']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const id = text(a.task, 'task')
        const action = a.action ?? 'both'
        if (action !== 'accept' && action !== 'merge' && action !== 'both') throw new Error('action must be accept, merge or both')
        const result: Record<string, unknown> = { task: id }
        if (action !== 'merge') {
          const ready = await automaticAcceptance(root, id, deps.backendsFor(root), nodeExec, planId, typeof a.into === 'string' ? a.into : undefined)
          await acceptTask(root, id, deps.now(), ready.verdict, ready.evidence, planId, ready.runId)
          await gcAfterAccept(root, [id], { exec: nodeExec, now: deps.now, policyPath: worktreeConfigPath(deps.env, deps.home), planId })
          result.accepted = true
          await afterWrite(root)
        }
        if (action !== 'accept') {
          await assertAutomaticMerge(root, await loadPlan(root, planId), id, nodeExec)
          const merge = await mergeTask(root, id, { exec: nodeExec, now: deps.now, planId, policyPath: worktreeConfigPath(deps.env, deps.home), ...(typeof a.into === 'string' && a.into ? { into: a.into } : {}) })
          result.merged = { into: merge.into, commit: merge.commit, strategy: merge.strategy, copy: merge.copy }
          await afterWrite(root)
        }
        return result
      },
    },
    {
      name: 'orchestra_stop',
      description: 'Stop the running worker of a task (use only to abandon the current direction).',
      parameters: schema({ task: str('Task id') }, ['task']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const r = await stopTask(root, text(a.task, 'task'), deps.backendsFor(root), planId)
        await afterWrite(root)
        return r
      },
    },
  ]
  return tools.map((tool) => ({ ...tool, execute: async (...args: Parameters<ToolSpec['execute']>) => toLosslessJson(await tool.execute(...args)) }))
}
