import {
  type Backends,
  type DshWorkspace,
  type Plan,
  assertWorkerChoice,
  assignWorker,
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
  draftJobAnswer,
  findingsOf,
  launchTask,
  loadPlan,
  mergeWorkspaces,
  newTask,
  nodeExec,
  normalize,
  saveDraft,
  steerTask,
  finishCheck,
  returnFromCheck,
  takeCheck,
  repairDraftJob,
  summarizeDraftJob,
  stopTask,
  updatePlan,
} from '@crewboard/core'
import type { DshToolDefinition } from './dsh.js'
import type { OrchestraService } from './service.js'
import { hostT, type HostLang } from './i18n.js'

export type ToolSpec = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown>
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

const KINDS = ['implement', 'review', 'research', 'decision'] as const
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
    execute: (args) => spec.execute(args ?? {}),
  }
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: { repo: { type: 'string', description: 'Absolute repository root; optional when one repo is configured.' }, ...properties },
  required,
  additionalProperties: false,
})
const str = (description: string) => ({ type: 'string', description })

function pickRepo(deps: ToolsDeps, repo: unknown): string {
  const roots = [...new Set([...mergeWorkspaces(deps.workspaces?.() ?? [], deps.repos), ...deps.service.repositories()].map((r) => r.root))]
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
  const repoSnapshot = async (repo: unknown) => {
    const root = pickRepo(deps, repo)
    await deps.service.refresh(root)
    const snap = deps.service.snapshot().repos.find((r) => r.root === root)
    if (!snap) throw new Error(`no snapshot for ${root}`)
    return snap
  }
  const afterWrite = async (root: string) => {
    await deps.service.refresh(root)
  }

  const tools: ToolSpec[] = [
    {
      name: 'orchestra_plan_draft',
      description: hostT(deps.lang?.() ?? 'en', 'tools.planDraft', { example: JSON.stringify(PLAN_DRAFT_EXAMPLE) }),
      parameters: schema({ draft: { ...PLAN_DRAFT_JSON_SCHEMA, description: 'PlanDraft JSON' } }, ['draft']),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        try {
          const draft = await saveDraft(root, a.draft)
          return { id: draft.id, findings: checkDraft(draft) }
        } catch (err) {
          const findings = findingsOf(err)
          if (findings) throw new Error(hostT(deps.lang?.() ?? 'en', 'tools.draftRefused', { findings: JSON.stringify(findings) }))
          throw err
        }
      },
    },
    {
      name: 'orchestra_draft_jobs',
      description: hostT(deps.lang?.() ?? 'en', 'tools.draftJobs'),
      parameters: schema({ job: str('Draft job id (dj-…); omit to list') }),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
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
      description: hostT(deps.lang?.() ?? 'en', 'tools.draftJobRepair'),
      parameters: schema({ job: str('Draft job id (dj-…)'), action: { type: 'string', enum: ['repair', 'discard'] }, agent: str('Worker for the repair run; omit to reuse the job worker') }, ['job', 'action']),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
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
      execute: (a) => repoSnapshot(a.repo),
    },
    {
      name: 'orchestra_attention',
      description: 'Return supervision signals that need a reaction: not started, stalled, loop, steer without effect, failed, awaiting review.',
      parameters: schema({}),
      execute: async (a) => (await repoSnapshot(a.repo)).attention,
    },
    {
      name: 'orchestra_events',
      description: 'Return the meaningful event feed (actions, file edits, messages, steers, problems) of the last run of a task.',
      parameters: schema({ task: str('Task id') }, ['task']),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const run = lastRun(await loadPlan(root), text(a.task, 'task'))
        const backend = await deps.backendsFor(root).forAgent(run.agent, run.runId)
        return normalize(await backend.events(run.runId)).slice(-MAX_EVENTS)
      },
    },
    {
      name: 'orchestra_trace',
      description: 'Return the trajectory of the last run of a task: turns, model/tool/input/problem spans and totals.',
      parameters: schema({ task: str('Task id') }, ['task']),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const run = lastRun(await loadPlan(root), text(a.task, 'task'))
        const backend = await deps.backendsFor(root).forAgent(run.agent, run.runId)
        const t = buildTrajectory(await backend.events(run.runId), { startedAt: run.startedAt, finishedAt: run.finishedAt }, deps.now())
        return { ...t, spans: t.spans.slice(-MAX_SPANS) }
      },
    },
    {
      name: 'orchestra_task_upsert',
      description: hostT(deps.lang?.() ?? 'en', 'tools.taskUpsert'),
      parameters: schema(
        {
          id: str('Task id: lowercase letters, digits and dashes'),
          title: str('Title'),
          kind: { type: 'string', enum: [...KINDS] },
          lane: str('Plan stage shown as a lane on the graph'),
          deps: { type: 'array', items: { type: 'string' } },
          worker: str(hostT(deps.lang?.() ?? 'en', 'tools.workerParam')),
          contract: str('Contract file path relative to the repo'),
          status: { type: 'string', enum: ['backlog', 'ready', 'accepted', 'rejected'] },
        },
        ['id'],
      ),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const id = text(a.id, 'id')
        if (a.status === 'accepted' || a.status === 'rejected') throw new Error('acceptance is human-only: use the Orchestra panel or "orch accept/reject"')
        if (a.kind !== undefined && !(KINDS as readonly unknown[]).includes(a.kind)) throw new Error(`unknown kind ${String(a.kind)}`)
        // A chat tool is always an agent: it may name only a worker of the effective preset, or `auto`.
        const caller = callerOf({ kind: 'tool' })
        const worker = typeof a.worker === 'string' ? a.worker : undefined
        const authority = worker !== undefined && !isAutoWorker(worker) ? await loadPresetAuthority({ root, env: deps.env, home: deps.home }) : undefined
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
        })
        await afterWrite(root)
        return plan.tasks.find((t) => t.id === id)
      },
    },
    {
      name: 'orchestra_decision',
      description: 'Add a decision task that only the human can close; tasks depending on it stay blocked until then.',
      parameters: schema({ id: str('Task id'), title: str('What the human decides'), deps: { type: 'array', items: { type: 'string' } } }, ['id', 'title']),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const id = text(a.id, 'id')
        const plan = await updatePlan(root, (p) => {
          if (p.tasks.some((t) => t.id === id)) throw new Error(`task ${id} already exists`)
          p.tasks.push(newTask({ id, title: text(a.title, 'title'), kind: 'decision', deps: list(a.deps) ?? [] }))
          return p
        })
        await afterWrite(root)
        return plan.tasks.find((t) => t.id === id)
      },
    },
    {
      name: 'orchestra_run',
      description: hostT(deps.lang?.() ?? 'en', 'tools.run'),
      parameters: schema({ task: str('Task id'), agent: str(hostT(deps.lang?.() ?? 'en', 'tools.agentParam')), contract: str('Contract path, optional'), scope: str('Baseline scope, optional') }, [
        'task',
      ]),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const result = await launchTask({
          root,
          taskId: text(a.task, 'task'),
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
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const r = await steerTask(root, text(a.task, 'task'), { message: text(a.message, 'message') }, deps.backendsFor(root), deps.now())
        await afterWrite(root)
        return { ...r, notice: hostT(deps.lang?.() ?? 'en', `steer.${r.delivery}`, { ...r, state: r.state ?? '' }) }
      },
    },
    {
      name: 'orchestra_verify',
      description: hostT(deps.lang?.() ?? 'en', 'tools.verify'),
      parameters: schema({ task: str('Task id'), action: { type: 'string', enum: ['take', 'done', 'return'] }, note: str('done: what you checked (gates, stand, fixes); return: the findings for the worker') }, ['task', 'action']),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const taskId = text(a.task, 'task')
        if (a.action === 'take') {
          const task = await takeCheck(root, taskId, deps.now(), { by: 'orchestrator' })
          await afterWrite(root)
          return { task: taskId, check: task.check }
        }
        if (a.action === 'done') {
          const task = await finishCheck(root, taskId, text(a.note, 'note'), deps.now(), { by: 'orchestrator' })
          await afterWrite(root)
          return { task: taskId, check: task.check }
        }
        if (a.action !== 'return') throw new Error('action must be take, done or return')
        const launched = await returnFromCheck({ root, taskId, findings: text(a.note, 'note'), by: 'orchestrator', caller: callerOf({ kind: 'tool' }), backends: deps.backendsFor(root), exec: nodeExec, env: deps.env, home: deps.home, now: () => deps.now(), lang: deps.lang?.() })
        await afterWrite(root)
        return { task: taskId, returned: true, ...launched }
      },
    },
    {
      name: 'orchestra_stop',
      description: 'Stop the running worker of a task (use only to abandon the current direction).',
      parameters: schema({ task: str('Task id') }, ['task']),
      execute: async (a) => {
        const root = pickRepo(deps, a.repo)
        const r = await stopTask(root, text(a.task, 'task'), deps.backendsFor(root))
        await afterWrite(root)
        return r
      },
    },
  ]
  return tools.map((tool) => ({ ...tool, execute: async (...args: Parameters<ToolSpec['execute']>) => toLosslessJson(await tool.execute(...args)) }))
}
