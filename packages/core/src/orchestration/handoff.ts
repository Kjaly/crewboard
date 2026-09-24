import type { ViewStatus } from '../plan/graph.js'

export type HandoffLang = 'en' | 'ru'

/** The slice of a task the handoff text needs; a `TaskSnapshot` or a stored `Task` can be mapped onto it. */
export type HandoffTask = {
  id: string
  title: string
  status: ViewStatus | string
  kind?: 'implement' | 'review' | 'research' | 'decision'
  worker?: string
  blockedBy?: string[]
}

/**
 * What the person (or the agent acting for them) is looking at: one task, one plan, or one review
 * finding on a task. Commands and ids stay untranslated; only the headings and the human-facing
 * sentences follow `lang`.
 */
export type AgentHandoffTarget =
  | { kind: 'task'; repo: string; planId?: string; task: HandoffTask }
  | { kind: 'finding'; repo: string; planId?: string; task: HandoffTask; finding: string }
  | { kind: 'plan'; repo: string; planId?: string; goal: string; tasks: HandoffTask[] }

type HandoffStrings = {
  repository: string
  plan: string
  task: string
  status: string
  finding: string
  waiting: string
  commands: string
  noTasks: string
  noWait: string
  waits: Record<string, string>
}

const STRINGS: Record<HandoffLang, HandoffStrings> = {
  en: {
    repository: 'Repository',
    plan: 'Plan',
    task: 'Task',
    status: 'Status',
    finding: 'Finding',
    waiting: 'Waiting for the person',
    commands: 'Commands',
    noTasks: 'none',
    noWait: 'nothing — no task is waiting.',
    waits: {
      in_review: 'review the result; the person accepts it or sends it back in dsh or with orch accept / orch reject in their terminal.',
      decision: 'the person makes the decision in dsh or with orch accept / orch reject in their terminal.',
      running: 'nothing yet — a worker is running; steer it if it drifts.',
      blocked: 'nothing — the dependencies must finish first.',
      ready: 'nothing — the task can be started.',
      backlog: 'nothing — the task is parked in the backlog.',
      accepted: 'nothing — the task is accepted.',
      closed: 'nothing — the task is closed without a result.',
      superseded: 'nothing — the task was superseded.',
      unknown: 'check the task status.',
    },
  },
  ru: {
    repository: 'Репозиторий',
    plan: 'План',
    task: 'Задача',
    status: 'Статус',
    finding: 'Замечание',
    waiting: 'Ждёт человека',
    commands: 'Команды',
    noTasks: 'нет',
    noWait: 'ничего — задачи не ждут.',
    waits: {
      in_review: 'проверить результат; принимает или возвращает человек — в dsh или командой orch accept / orch reject в своём терминале.',
      decision: 'решение принимает человек — в dsh или командой orch accept / orch reject в своём терминале.',
      running: 'пока ничего — воркер работает; поправьте, если уходит не туда.',
      blocked: 'ничего — сначала должны завершиться зависимости.',
      ready: 'ничего — задачу можно запускать.',
      backlog: 'ничего — задача отложена в бэклог.',
      accepted: 'ничего — задача принята.',
      closed: 'ничего — задача закрыта без результата.',
      superseded: 'ничего — задача вытеснена.',
      unknown: 'проверьте статус задачи.',
    },
  },
}

const waitsForPerson = (task: HandoffTask): boolean =>
  task.status === 'in_review' || (task.status === 'ready' && task.kind === 'decision')

const actionable = (task: HandoffTask): boolean =>
  task.status === 'running' || waitsForPerson(task) || (task.status === 'ready' && task.kind !== 'decision')

/** `orch events` fits every status; the rest only fit the state the task is actually in. */
function commandsFor(task: HandoffTask, planId?: string): string[] {
  // Every command names the plan outright: the chat this is pasted into may have another plan
  // current, and `orch plan use` would retarget it for everyone — so it is never emitted.
  const plan = planId ? ` --plan ${planId}` : ''
  const commands = [`orch events ${task.id}${plan}`]
  if (task.status === 'backlog') {
    commands.push(`orch task set ${task.id} --status ready${plan}`)
    return commands
  }
  if (task.status === 'running') {
    commands.push(`orch steer ${task.id} --message "…"${plan}`, `orch stop ${task.id}${plan}`)
    return commands
  }
  if (task.status === 'in_review' || (task.status === 'ready' && task.kind === 'decision')) {
    // Accepting and rejecting are the person's (the CLI refuses them without a terminal): the agent
    // gets what it needs to prepare the review, not the verdict.
    commands.push(`orch trace ${task.id} --json${plan}`)
    return commands
  }
  if (task.status === 'ready') {
    commands.push(task.worker ? `orch run ${task.id} -a ${task.worker}${plan}` : `orch run ${task.id}${plan}`)
  }
  return commands
}

function waitReason(task: HandoffTask, s: HandoffStrings): string {
  if (task.status === 'ready' && task.kind === 'decision') return s.waits.decision
  if (task.status === 'blocked' && task.blockedBy?.length) {
    return `${s.waits.blocked} (${task.blockedBy.join(', ')})`
  }
  return s.waits[task.status] ?? s.waits.unknown
}

function actionLines(target: AgentHandoffTarget): string[] {
  if (target.kind === 'plan') {
    const perTask = target.tasks.filter(actionable).flatMap((task) => commandsFor(task, target.planId))
    return [`orch status${target.planId ? ` --plan ${target.planId}` : ''}`, ...perTask]
  }
  return commandsFor(target.task, target.planId)
}

/**
 * Plain text a coding agent can act on: where the work lives, what state it is in, what the person
 * is expected to do, and the exact `orch` commands for that state. Pure — no clipboard or host code.
 */
export function agentHandoff(target: AgentHandoffTarget, lang: HandoffLang = 'en'): string {
  const s = STRINGS[lang]
  const lines: string[] = []
  lines.push(`${s.repository}: ${target.repo}`)
  if (target.kind === 'plan') {
    lines.push(`${s.plan}: ${target.planId ? `${target.planId} — ${target.goal}` : target.goal}`)
    lines.push(`${s.status}: ${target.tasks.length ? target.tasks.map((task) => `${task.id} ${task.status}`).join('; ') : s.noTasks}`)
  } else {
    if (target.planId) lines.push(`${s.plan}: ${target.planId}`)
    lines.push(`${s.task}: ${target.task.id} — ${target.task.title}`)
    lines.push(`${s.status}: ${target.task.status}`)
    if (target.kind === 'finding') lines.push(`${s.finding}: ${target.finding}`)
  }
  const waiting = target.kind === 'plan' ? target.tasks.filter(waitsForPerson) : []
  const waitText = target.kind === 'plan'
    ? waiting.length ? waiting.map((task) => `${task.id} — ${waitReason(task, s)}`).join(' ') : s.noWait
    : waitReason(target.task, s)
  lines.push(`${s.waiting}: ${waitText}`)
  lines.push(`${s.commands}:`)
  // The chat this lands in can be rooted anywhere: the commands first enter the repository.
  lines.push(`  cd "${target.repo}"`)
  const commands = [...new Set(actionLines(target))]
  for (const command of commands) lines.push(`  ${command}`)
  return lines.join('\n')
}
