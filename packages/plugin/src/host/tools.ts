import {
  type Backends,
  type DshWorkspace,
  type Plan,
  assertWorkerChoice,
  assignWorker,
  buildRepoSnapshot,
  buildTrajectory,
  PLAN_DRAFT_EXAMPLE,
  PLAN_DRAFT_JSON_SCHEMA,
  advanceDraftJob,
  advanceDraftJobs,
  callerOf,
  classOfTask,
  isAutoWorker,
  loadPresetAuthority,
  checkDraft,
  discardDraftJob,
  doneFacts,
  draftJobAnswer,
  findingsOf,
  launchTask,
  continueTask,
  loadPlan,
  mergeWorkspaces,
  needsYou,
  newTask,
  nodeExec,
  normalize,
  saveDraft,
  steerTask,
  finishCheck,
  startOwnWork,
  setTaskKind,
  TASK_KINDS,
  returnFromCheck,
  takeCheck,
  repairDraftJob,
  summarizeDraftJob,
  stopTask,
  updatePlan,
} from '@crewboard/core'
import { readFile } from 'node:fs/promises'
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

function pickRepo(deps: ToolsDeps, repo: unknown): string {
  const roots = knownRoots(deps)
  if (typeof repo === 'string' && repo) {
    if (!roots.includes(repo)) throw new Error(`repo ${repo} is not a dsh workspace or a configured repo`)
    return repo
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
        const repoMismatch = typeof a.repo === 'string' && a.repo && a.repo !== root
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
      parameters: schema({ job: str('Draft job id (dj-…)'), action: { type: 'string', enum: ['repair', 'discard'] }, agent: str('Worker for the repair run; omit to reuse the job worker') }, ['job', 'action']),
      execute: async (a, call) => {
        const { root } = await target(a, call)
        const id = text(a.job, 'job')
        if (a.action === 'discard') return summarizeDraftJob(await discardDraftJob(root, id, deps.backendsFor(root), deps.now()))
        if (a.action !== 'repair') throw new Error('action must be repair or discard')
        const job = await repairDraftJob({ root, id, backends: deps.backendsFor(root), now: deps.now(), ...(typeof a.agent === 'string' && a.agent ? { agent: a.agent } : {}) })
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
        return planSnapshot(root, planId)
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
          worker: str(hostT(lang(), 'tools.workerParam')),
          contract: str('Contract file path relative to the repo'),
          status: { type: 'string', enum: ['backlog', 'ready', 'accepted', 'rejected'] },
        },
        ['id'],
      ),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const id = text(a.id, 'id')
        if (a.status === 'accepted' || a.status === 'rejected') throw new Error('acceptance is human-only: use the Orchestra panel or "orch accept/reject"')
        if (a.kind !== undefined && !(KINDS as readonly unknown[]).includes(a.kind)) throw new Error(`unknown kind ${String(a.kind)}`)
        // A chat tool is always an agent: it may name only a worker of the effective preset, or `auto`.
        const caller = callerOf({ kind: 'tool' })
        const worker = typeof a.worker === 'string' ? a.worker : undefined
        const authority = worker !== undefined && !isAutoWorker(worker) ? await loadPresetAuthority({ root, planId, env: deps.env, home: deps.home }) : undefined
        const checkWorker = (task: { kind: string; class?: Plan['tasks'][number]['class'] }) => {
          if (authority && worker !== undefined) assertWorkerChoice({ caller, ...authority, taskClass: classOfTask(task), worker, lang: deps.lang?.() ?? 'en' })
        }
        const plan = await updatePlan(root, (p) => {
          const existing = p.tasks.find((t) => t.id === id)
          if (!existing) {
            const task = newTask({
              id,
              title: text(a.title, 'title'),
              kind: (a.kind as (typeof KINDS)[number] | undefined) ?? 'implement',
              lane: typeof a.lane === 'string' ? a.lane : undefined,
              deps: list(a.deps) ?? [],
              contract: typeof a.contract === 'string' ? a.contract : undefined,
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
          if (typeof a.contract === 'string') existing.contract = a.contract
          if (a.status === 'backlog' || a.status === 'ready') existing.status = a.status
          return p
        }, 5, planId)
        await afterWrite(root)
        return plan.tasks.find((t) => t.id === id)
      },
    },
    {
      name: 'orchestra_decision',
      description: 'Add a decision task that only the human can close; tasks depending on it stay blocked until then. It reaches the person only after you prepare it with orchestra_verify action=done (options and a recommendation). For work you do yourself use kind root instead.',
      parameters: schema({ id: str('Task id'), title: str('What the human decides'), deps: { type: 'array', items: { type: 'string' } } }, ['id', 'title']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const id = text(a.id, 'id')
        const plan = await updatePlan(root, (p) => {
          if (p.tasks.some((t) => t.id === id)) throw new Error(`task ${id} already exists`)
          p.tasks.push(newTask({ id, title: text(a.title, 'title'), kind: 'decision', deps: list(a.deps) ?? [] }))
          return p
        }, 5, planId)
        await afterWrite(root)
        return plan.tasks.find((t) => t.id === id)
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
        return result
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
      parameters: schema({ task: str('Task id'), action: { type: 'string', enum: ['start', 'take', 'reopen', 'done', 'return'] }, note: str('done: what you checked (gates, stand, fixes) — on a decision, the options and your recommendation; return: the findings for the worker'), report: str('done on a root task or a decision: path of a markdown report relative to the repo, starting with a "Result:" line'), confirm: { type: 'boolean', description: 'done: mark checked although the verdict is disputed or no file changed' } }, ['task', 'action']),
      execute: async (a, call) => {
        const { root, planId } = await target(a, call)
        const taskId = text(a.task, 'task')
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
          if (facts?.needsConfirm && a.confirm !== true) throw new Error(hostT(lang(), 'tools.doneUnconfirmed', { id: taskId, verdict: JSON.stringify(verdict) }))
          const task = await finishCheck(root, taskId, note, deps.now(), { planId, by: 'orchestrator', ...(report !== undefined ? { report } : {}) })
          await afterWrite(root)
          return { task: taskId, status: task.status, check: task.check, ...(verdict ? { verdict } : {}) }
        }
        if (a.action !== 'return') throw new Error('action must be start, take, reopen, done or return')
        const launched = await returnFromCheck({ root, taskId, planId, findings: text(a.note, 'note'), by: 'orchestrator', caller: callerOf({ kind: 'tool' }), backends: deps.backendsFor(root), exec: nodeExec, env: deps.env, home: deps.home, now: () => deps.now(), lang: deps.lang?.() })
        await afterWrite(root)
        return { task: taskId, returned: true, ...launched }
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
