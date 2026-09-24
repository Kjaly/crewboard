import { cliT } from '../i18n.js'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Exec,
  PlanConflictError,
  TASK_CLASSES,
  type TaskView,
  type ViewStatus,
  acceptTask,
  assertWorkerChoice,
  assignWorker,
  callerOf,
  classOfTask,
  isAutoWorker,
  loadPresetAuthority,
  gcAfterAccept,
  worktreeConfigPath,
  getTaskDetail,
  createPlan,
  criticalPath,
  deriveViews,
  ensureGitExclude,
  initPlan,
  isChecking,
  loadPlan,
  listPlans,
  loadRouting,
  newTask,
  planPath,
  profileStorePath,
  readySet,
  rejectTask,
  renamePlan,
  saveRouting,
  setCurrentPlan,
  setPlanArchived,
  supersedeTask,
  updatePlan,
  splitPlan,
  currentPlanId,
} from '@crewboard/core'
import { homeOf, listFlag, makeBackends, repoRoot } from '../context.js'
import { type Io, UserError, confirmHuman } from '../io.js'
import { syncPlan } from './runs.js'
import { cmdPlanPreset } from './presets.js'
import { resolveRouting } from '@crewboard/core'
import { cmdPlanDraft } from './drafts.js'
import { registerPlace } from './repos.js'

const ICON: Record<ViewStatus, string> = { backlog: '·', ready: '○', running: '●', in_review: '◐', accepted: '✓', closed: '✗', blocked: '⏸', superseded: '⊘' }
const KINDS = ['implement', 'review', 'research', 'decision'] as const

export async function cmdInit(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { goal: { type: 'string' } } })
  const root = await repoRoot(io, exec)
  await ensureGitExclude(root, exec)
  try {
    await initPlan(root, values.goal ?? '', io.now())
  } catch (err) {
    if (err instanceof PlanConflictError) throw new UserError(cliT(io.lang ?? 'en', 'plan.exists', { path: planPath(root) }))
    throw err
  }
  io.out(cliT(io.lang ?? 'en', 'plan.created', { path: planPath(root) }))
  await registerPlace(io, exec, root)
  return 0
}

function formatView(v: TaskView, width: number, io: Io): string {
  const extra = [
    v.task.worker,
    v.status === 'blocked' ? cliT(io.lang ?? 'en', 'plan.waiting', { ids: v.blockedBy.join(', ') }) : undefined,
    v.needsHuman ? cliT(io.lang ?? 'en', 'plan.humanDecision') : undefined,
    v.check ? cliT(io.lang ?? 'en', v.check === 'checked' ? 'plan.checked' : 'plan.checking') : undefined,
    v.activeRunId,
  ].filter(Boolean)
  return `${ICON[v.status]} ${v.task.id.padEnd(width)}  ${v.task.title}${extra.length ? ` · ${extra.join(' · ')}` : ''}\n`
}

export async function cmdStatus(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, plan: { type: 'string' } } })
  const root = await repoRoot(io, exec)
  const { plan, states, degraded } = await syncPlan(root, io, makeBackends(io, exec, root), values.plan)
  const views = deriveViews(plan, states)
  const ready = readySet(views)
  const critical = criticalPath(plan)
  const effectiveRouting = await resolveRouting(root, undefined, io.env)
  let chat: { sessionId: string } | undefined
  try { chat = JSON.parse(await readFile(join(root, '.orchestration', 'chats.json'), 'utf8'))[values.plan ?? currentPlanId(root)] } catch { /* no chat bound */ }
  if (values.json) {
    const rows = views.map((v) => ({ id: v.task.id, title: v.task.title, status: v.status, blockedBy: v.blockedBy, needsHuman: v.needsHuman, activeRunId: v.activeRunId ?? null, worker: v.task.worker ?? null, ...(v.check ? { check: v.check, ...(v.task.check?.note ? { checkNote: v.task.check.note } : {}) } : {}) }))
    io.out(`${JSON.stringify({ goal: plan.goal, rev: plan.rev, chat: chat?.sessionId, views: rows, ready, criticalPath: critical, degraded, effectiveRouting }, null, 2)}\n`)
    return 0
  }
  io.out(`${plan.goal || cliT(io.lang ?? 'en', 'plan.statusFallback')} · rev ${plan.rev}${degraded ? cliT(io.lang ?? 'en', 'plan.degraded') : ''}${chat ? cliT(io.lang ?? 'en', 'plan.chatLead', { id: chat.sessionId }) : ''}\n\n`)
  io.out(`${cliT(io.lang ?? 'en', 'presets.active', { label: effectiveRouting.preset.builtin ? cliT(io.lang ?? 'en', 'presets.builtin') : effectiveRouting.preset.label, source: cliT(io.lang ?? 'en', `presets.source.${effectiveRouting.source}`) })}\n`)
  const width = Math.max(4, ...views.map((v) => v.task.id.length))
  for (const v of views) io.out(formatView(v, width, io))
  io.out(`\n${cliT(io.lang ?? 'en', 'status.ready')}: ${ready.length ? ready.join(', ') : '—'}\n${cliT(io.lang ?? 'en', 'status.critical')}: ${critical.length ? critical.join(' → ') : '—'}\n`)
  return 0
}

export async function cmdTask(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, id, ...rest] = argv
  if ((sub !== 'add' && sub !== 'set') || !id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageTask'), 2)
  const { values } = parseArgs({
    args: rest,
    options: {
      title: { type: 'string' },
      kind: { type: 'string' },
      lane: { type: 'string' },
      deps: { type: 'string' },
      worker: { type: 'string' },
      contract: { type: 'string' },
      status: { type: 'string' },
      class: { type: 'string' },
      backlog: { type: 'boolean' },
      plan: { type: 'string' },
    },
  })
  const root = await repoRoot(io, exec)
  if (values.class !== undefined && !(TASK_CLASSES as readonly string[]).includes(values.class)) {
    throw new UserError(cliT(io.lang ?? 'en', 'plan.badClass', { value: values.class, classes: TASK_CLASSES.join(', ') }), 2)
  }
  const taskClass = values.class as (typeof TASK_CLASSES)[number] | undefined
  // An agent (no interactive terminal) may name only a worker of the effective preset (routing/authority.ts).
  const caller = callerOf({ kind: 'cli', isTTY: io.isTTY })
  const authority = values.worker !== undefined && !isAutoWorker(values.worker) && caller === 'agent'
    ? await loadPresetAuthority({ root, planId: values.plan, env: io.env, home: homeOf(io) })
    : undefined
  const checkWorker = (task: { kind: string; class?: (typeof TASK_CLASSES)[number] }) => {
    if (!authority || values.worker === undefined) return
    try {
      assertWorkerChoice({ caller, ...authority, taskClass: classOfTask(task), worker: values.worker, lang: io.lang ?? 'en' })
    } catch (err) {
      throw new UserError((err as Error).message, 2)
    }
  }

  if (sub === 'add') {
    if (!values.title) throw new UserError(cliT(io.lang ?? 'en', 'plan.needTitle'), 2)
    const kind = values.kind ?? 'implement'
    if (!(KINDS as readonly string[]).includes(kind)) throw new UserError(cliT(io.lang ?? 'en', 'plan.badKind', { kind }), 2)
    await updatePlan(root, (plan) => {
      if (plan.tasks.some((t) => t.id === id)) throw new UserError(cliT(io.lang ?? 'en', 'plan.taskExists', { id }))
      const task = newTask({
        id,
        title: values.title as string,
        kind: kind as (typeof KINDS)[number],
        class: taskClass,
        lane: values.lane,
        deps: listFlag(values.deps),
        contract: values.contract,
        status: values.backlog ? 'backlog' : 'ready',
      })
      checkWorker(task)
      assignWorker(task, values.worker, caller)
      plan.tasks.push(task)
      return plan
    }, 5, values.plan)
    io.out(`+ ${id}\n`)
    return 0
  }

  if (values.status && values.status !== 'backlog' && values.status !== 'ready') {
    throw new UserError(cliT(io.lang ?? 'en', 'plan.statusOnly'), 2)
  }
  await updatePlan(root, (plan) => {
    const task = plan.tasks.find((t) => t.id === id)
    if (!task) throw new UserError(cliT(io.lang ?? 'en', 'plan.noTask', { id }))
    if (values.title) task.title = values.title
    if (values.lane) task.lane = values.lane
    if (values.deps !== undefined) task.deps = listFlag(values.deps)
    if (taskClass) task.class = taskClass
    if (values.worker !== undefined) {
      checkWorker(task)
      assignWorker(task, values.worker, caller)
    }
    if (values.contract) task.contract = values.contract
    if (values.status) task.status = values.status as 'backlog' | 'ready'
    return plan
  }, 5, values.plan)
  io.out(`~ ${id}\n`)
  return 0
}

export async function cmdAccept(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { plan: { type: 'string' } } })
  const [id] = positionals
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageAccept'), 2)
  const root = await repoRoot(io, exec)
  const detail = await getTaskDetail(root, id, makeBackends(io, exec, root), exec, values.plan)
  const verdict = detail.verdict
  // Accepting before the orchestrator finished checking is allowed, but said out loud (vr1).
  const view = deriveViews(await loadPlan(root, values.plan)).find((v) => v.task.id === id)
  const unchecked = isChecking(view?.check) ? `${cliT(io.lang ?? 'en', 'plan.acceptUnchecked', { id })}\n` : ''
  const question = unchecked + (verdict.kind === 'negative'
    ? cliT(io.lang ?? 'en', 'plan.acceptNegative', { id, reason: verdict.why ? ` ${verdict.why}.` : '' })
    : verdict.kind === 'disputed'
      ? cliT(io.lang ?? 'en', 'plan.acceptDisputed', { id, mismatch: verdict.mismatch ?? cliT(io.lang ?? 'en', 'plan.factsMismatch') })
      : cliT(io.lang ?? 'en', 'plan.acceptQuestion', { id }))
  if (!(await confirmHuman(io, question))) {
    io.out(`${cliT(io.lang ?? 'en', 'plan.cancelled')}\n`)
    return 1
  }
  await acceptTask(root, id, io.now(), verdict, undefined, values.plan)
  const cleanup = await gcAfterAccept(root, [id], { exec, now: io.now, policyPath: worktreeConfigPath(io.env, homeOf(io)), planId: values.plan })
  io.out(cliT(io.lang ?? 'en', 'plan.accepted', { id }))
  if (cleanup.removed.includes(id)) io.out(`${cliT(io.lang ?? 'en', 'plan.copyRemoved')}\n`)
  return 0
}

export async function cmdReject(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { reason: { type: 'string' }, plan: { type: 'string' } } })
  if (!id || !values.reason) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageReject'), 2)
  const root = await repoRoot(io, exec)
  if (!(await confirmHuman(io, cliT(io.lang ?? 'en', 'plan.rejectQuestion', { id, reason: values.reason })))) {
    io.out(`${cliT(io.lang ?? 'en', 'plan.cancelled')}\n`)
    return 1
  }
  await rejectTask(root, id, values.reason, io.now(), values.plan)
  io.out(cliT(io.lang ?? 'en', 'plan.rejected', { id }))
  return 0
}

export async function cmdSupersede(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { by: { type: 'string' }, plan: { type: 'string' } } })
  if (!id || !values.by) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageSupersede'), 2)
  const root = await repoRoot(io, exec)
  if (!(await confirmHuman(io, cliT(io.lang ?? 'en', 'plan.supersedeQuestion', { id, by: values.by })))) {
    io.out(`${cliT(io.lang ?? 'en', 'plan.cancelled')}\n`)
    return 1
  }
  await supersedeTask(root, id, values.by, io.now(), values.plan)
  io.out(cliT(io.lang ?? 'en', 'plan.superseded', { id, by: values.by }))
  return 0
}


export async function cmdPlan(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, ...rest] = argv
  if (!sub) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
  if (sub === 'preset') return cmdPlanPreset(rest, io, exec)
  if (sub === 'draft' || sub === 'drafts' || sub === 'approve' || sub === 'discard') return cmdPlanDraft(argv, io, exec)
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { goal: { type: 'string' }, from: { type: 'string' }, tasks: { type: 'string' } } })
  const id = positionals[0]
  const root = await repoRoot(io, exec)
  switch (sub) {
    case 'split': {
      if (!id || !values.from || !values.goal || !values.tasks) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      const result = await splitPlan(root, values.from, { id, goal: values.goal, tasks: values.tasks.split(',').map((task) => task.trim()).filter(Boolean) })
      io.out(cliT(io.lang ?? 'en', 'plan.split', { id, moved: result.moved.join(', '), kept: result.kept.join(', ') || cliT(io.lang ?? 'en', 'plan.noTasks') }))
      return 0
    }
    case 'list': {
      const plans = await listPlans(root)
      if (plans.length === 0) io.out(`${cliT(io.lang ?? 'en', 'plan.noPlans')}\n`)
      for (const p of plans) io.out(`${p.current ? '●' : p.archived ? '·' : '○'} ${p.id.padEnd(22)} ${p.goal}${p.archived ? cliT(io.lang ?? 'en', 'plan.archivedLabel') : ''}${cliT(io.lang ?? 'en', 'plan.taskCount', { count: p.taskCount })}\n`)
      return 0
    }
    case 'new':
      if (!id || !values.goal) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await createPlan(root, id, values.goal, io.now())
      io.out(cliT(io.lang ?? 'en', 'plan.new', { id }))
      await registerPlace(io, exec, root)
      return 0
    case 'use':
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await setCurrentPlan(root, id)
      io.out(cliT(io.lang ?? 'en', 'plan.current', { id }))
      return 0
    case 'archive':
    case 'unarchive':
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await setPlanArchived(root, id, sub === 'archive')
      io.out(sub === 'archive' ? cliT(io.lang ?? 'en', 'plan.archived', { id }) : cliT(io.lang ?? 'en', 'plan.unarchived', { id }))
      return 0
    case 'rename':
      if (!id || !values.goal) throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
      await renamePlan(root, id, values.goal)
      io.out(`✎ ${id}: ${values.goal}\n`)
      return 0
    default:
      throw new UserError(cliT(io.lang ?? 'en', 'plan.usagePlan'), 2)
  }
}

export async function cmdChat(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, plan] = argv
  if (sub !== 'unbind' || !plan) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageChat'), 2)
  const root = await repoRoot(io, exec)
  const file = join(root, '.orchestration', 'chats.json')
  let chats: Record<string, unknown> = {}
  try { chats = JSON.parse(await readFile(file, 'utf8')) } catch { /* no bindings yet */ }
  delete chats[plan]
  await (await import('node:fs/promises')).writeFile(file, `${JSON.stringify(chats, null, 2)}\n`)
  io.out(cliT(io.lang ?? 'en', 'plan.chatUnbound', { plan }))
  return 0
}


export async function cmdWorkers(argv: string[], io: Io, _exec: Exec): Promise<number> {
  const [sub = 'list', ...rest] = argv
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, kind: { type: 'string' }, model: { type: 'string' }, label: { type: 'string' }, billing: { type: 'string' }, transport: { type: 'string' }, effort: { type: 'string' } } })
  const path = profileStorePath(io.env, homeOf(io))
  const routing = await loadRouting(path, io.env, homeOf(io))
  const { registryPath, loadRegistry, saveWorker, saveWorkerProfile, removeWorker } = await import('@crewboard/core')
  const workersFile = registryPath(io.env, homeOf(io))
  switch (sub) {
    case 'list': {
      const registry = await loadRegistry(workersFile)
      io.out(`${cliT(io.lang ?? 'en', 'plan.registry')}\n`)
      for (const w of registry.workers) io.out(`  ${w.id} — ${w.label} (${w.kind}${w.model ? `, ${w.model}` : ''})\n`)
      for (const cls of TASK_CLASSES) {
        io.out(`${cliT(io.lang ?? 'en', `plan.class.${cls}`)} (${cls}):\n`)
        routing.classes[cls].forEach((id, i) => {
          const off = routing.disabled[id]
          io.out(`  ${i + 1}. ${id}${off !== undefined ? cliT(io.lang ?? 'en', 'plan.disabledReason', { reason: off || cliT(io.lang ?? 'en', 'plan.noReason') }) : ''}\n`)
        })
      }
      return 0
    }
    case 'add': {
      const id = positionals[0]
      const kind = values.kind
      if (!id || !kind || !values.label || !['dsh', 'claude', 'codex', 'devin'].includes(kind)) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageAddWorker'), 2)
      const entry: import('@crewboard/core').WorkerEntry = { id, kind: kind as import('@crewboard/core').WorkerKind, ...(values.model ? { model: values.model } : {}), ...(values.transport ? { transport: values.transport as import('@crewboard/core').Transport } : {}), ...(values.effort ? { effort: values.effort } : {}), label: values.label, billing: (values.billing ?? (kind === 'codex' || kind === 'claude' ? 'подписка' : kind === 'devin' ? 'промо' : 'API')) as import('@crewboard/core').WorkerEntry['billing'] }
      await saveWorkerProfile(io.env, homeOf(io), entry)
      await saveWorker(workersFile, entry)
      io.out(cliT(io.lang ?? 'en', 'plan.workerSaved', { id }))
      return 0
    }
    case 'rm': {
      const id = positionals[0]
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageRemoveWorker'), 2)
      const { removed } = await removeWorker(workersFile, path, id, io.env, homeOf(io))
      io.out(cliT(io.lang ?? 'en', 'plan.workerRemoved', { workers: removed.join(', ') }))
      return 0
    }
    case 'disable': {
      const id = positionals[0]
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
      await saveRouting(path, { ...routing, disabled: { ...routing.disabled, [id]: values.reason ?? '' } }, io.env, homeOf(io))
      io.out(cliT(io.lang ?? 'en', 'plan.workerDisabled', { id, reason: values.reason ? `: ${values.reason}` : '' }))
      return 0
    }
    case 'enable': {
      const id = positionals[0]
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
      const disabled = { ...routing.disabled }
      delete disabled[id]
      await saveRouting(path, { ...routing, disabled }, io.env, homeOf(io))
      io.out(cliT(io.lang ?? 'en', 'plan.workerEnabled', { id }))
      return 0
    }
    case 'route': {
      const [cls, list] = positionals
      if (!cls || !list || !(TASK_CLASSES as readonly string[]).includes(cls)) throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
      const ids = list.split(',').map((s) => s.trim()).filter(Boolean)
      await saveRouting(path, { ...routing, classes: { ...routing.classes, [cls]: ids } }, io.env, homeOf(io))
      io.out(`→ ${cliT(io.lang ?? 'en', `plan.class.${cls}`)}: ${ids.join(' → ')}\n`)
      return 0
    }
    default:
      throw new UserError(cliT(io.lang ?? 'en', 'plan.usageWorkers'), 2)
  }
}
