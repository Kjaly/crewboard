import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type Attention, CREWBOARD_DIR, type ViewStatus, deriveViews, loadPlan, waitsForHuman } from '@crewboard/core'
import type { OrchestraSnapshot } from '../shared/types.js'
import type { SessionControllerFace } from './dsh.js'

/** One plan ↔ one dsh chat session. Kept in `<root>/.orchestration/chats.json`. */
export type ChatBinding = { sessionId: string; wake: boolean; boundAt: string }
export type ChatBindings = Record<string, ChatBinding>

/** The task slice `openChat` and the waker pass to `taskBrief`. */
export type TaskBrief = { id: string; title: string; status: string; worker?: string; contract?: string }
export type TaskBriefData = { task: TaskBrief; lastEvents: string[] }

export type ChatDeps = {
  sessions: SessionControllerFace
  now: () => Date
  newId: () => string
  readTask?: (root: string, planId: string, taskId: string) => Promise<TaskBriefData | undefined>
}

const chatsFile = (root: string) => join(root, CREWBOARD_DIR, 'chats.json')
const wokenFile = (root: string) => join(root, CREWBOARD_DIR, 'chat-woken.json')

const atomicWrite = async (file: string, text: string): Promise<void> => {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

export async function readChats(root: string): Promise<ChatBindings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(chatsFile(root), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as ChatBindings
  } catch {
    return {}
  }
}

/** Atomic (tmp + rename) so a crash never leaves a half-written binding. */
export async function writeChats(root: string, chats: ChatBindings): Promise<void> {
  await atomicWrite(chatsFile(root), `${JSON.stringify(chats, null, 2)}\n`)
}

async function readWoken(root: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(wokenFile(root), 'utf8'))
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

async function writeWoken(root: string, keys: Set<string>): Promise<void> {
  await atomicWrite(wokenFile(root), `${JSON.stringify([...keys].sort(), null, 2)}\n`)
}

/** Human labels for statuses in prompts (the stored values stay English). */
const STATUS_LABEL: Record<ViewStatus, string> = {
  backlog: 'backlog', ready: 'ready to start', running: 'running', in_review: 'awaiting review', accepted: 'accepted', closed: 'closed without result', blocked: 'waiting', superseded: 'superseded',
}

const statusLabel = (status: string): string => STATUS_LABEL[status as ViewStatus] ?? status

export function briefing(input: { root: string; planId: string; planName: string; goal: string }): string {
  return `You are the orchestrator for plan “${input.planName}” in ${input.root}. Goal: ${input.goal}. Use orchestra_* tools (protocol is in the system prompt). Only a human may accept or send back a task. Start with orchestra_plan and orchestra_attention, then briefly report what needs action.`
}

export function taskBrief(task: TaskBrief, lastEvents: string[]): string {
  const lines = [`Task ${task.id} “${task.title}”.`, `Status: ${statusLabel(task.status)}.`]
  if (task.worker) lines.push(`Worker: ${task.worker}.`)
  if (task.contract) lines.push(`Contract: ${task.contract}.`)
  const events = lastEvents.slice(-5)
  if (events.length > 0) lines.push('Recent events:', ...events.map((e) => `• ${e}`))
  lines.push('Suggest what to do and ask the user.')
  return lines.join('\n')
}

export function wakeMessage(items: { planName: string; taskId: string; title: string; kind: string; message: string }[]): string {
  const lines = items.map((i) => `${i.taskId} «${i.title}» — ${i.kind}: ${i.message}`)
  return [
    '[crewboard] Orchestrator action needed',
    '',
    ...lines,
    '',
    'Follow the protocol. For finished work: check the diff, log, gates and stand, then orch verify <id> --done --note "…" (or --return "findings") so it reaches the human; never accept it yourself.',
  ].join('\n')
}

/** Reads the task from the plan file; the host may inject a richer reader that adds recent events. */
async function defaultReadTask(root: string, planId: string, taskId: string): Promise<TaskBriefData | undefined> {
  const plan = await loadPlan(root, planId).catch(() => undefined)
  const view = plan ? deriveViews(plan).find((v) => v.task.id === taskId) : undefined
  if (!view) return undefined
  const t = view.task
  return {
    task: { id: t.id, title: t.title, status: view.status, ...(t.worker ? { worker: t.worker } : {}), ...(t.contract ? { contract: t.contract } : {}) },
    lastEvents: [],
  }
}

async function say(deps: ChatDeps, sessionId: string, text: string): Promise<void> {
  await deps.sessions.prompt({ requestId: deps.newId(), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
}

/**
 * Reuses the plan's session when it still exists, otherwise creates one and sends the briefing.
 * A `taskId` always adds the task brief (existing chat included).
 */
export async function openChat(deps: ChatDeps, req: { root: string; planId: string; taskId?: string; prompt?: string }): Promise<{ sessionId: string; created: boolean }> {
  const chats = await readChats(req.root)
  const bound = chats[req.planId]
  let sessionId: string
  let created = false
  if (bound && (await deps.sessions.inspect(bound.sessionId).then(() => true, () => false))) {
    sessionId = bound.sessionId
  } else {
    const fresh = await deps.sessions.create({ cwd: req.root })
    sessionId = fresh.sessionId
    created = true
    await writeChats(req.root, { ...chats, [req.planId]: { sessionId, wake: true, boundAt: deps.now().toISOString() } })
    const plan = await loadPlan(req.root, req.planId).catch(() => undefined)
    const goal = plan?.goal ?? ''
    await say(deps, sessionId, briefing({ root: req.root, planId: req.planId, planName: goal || req.planId, goal }))
  }
  if (req.prompt) await say(deps, sessionId, req.prompt)
  if (req.taskId) {
    const read = deps.readTask ?? defaultReadTask
    const info = await read(req.root, req.planId, req.taskId).catch(() => undefined)
    if (info) await say(deps, sessionId, taskBrief(info.task, info.lastEvents))
  }
  return { sessionId, created }
}

export class ChatBindingError extends Error {
  constructor(
    readonly code: 'no_chat' | 'unknown_session',
    message: string,
  ) {
    super(message)
    this.name = 'ChatBindingError'
  }
}

/** Bind an existing right-pane session instead of creating one. */
export async function planOfSession(root: string, sessionId: string): Promise<string | undefined> {
  return Object.entries(await readChats(root)).find(([, binding]) => binding.sessionId === sessionId)?.[0]
}

export async function unbindChat(root: string, planId: string): Promise<void> {
  const chats = await readChats(root)
  delete chats[planId]
  await writeChats(root, chats)
}

export async function bindChat(deps: ChatDeps, req: { root: string; planId: string; sessionId: string }): Promise<{ binding: ChatBinding; replaced?: { planId?: string; sessionId?: string } }> {
  await deps.sessions.inspect(req.sessionId).catch(() => {
    throw new ChatBindingError('unknown_session', `Session not found: ${req.sessionId}`)
  })
  const chats = await readChats(req.root)
  const binding: ChatBinding = { sessionId: req.sessionId, wake: true, boundAt: deps.now().toISOString() }
  const replaced: { planId?: string; sessionId?: string } = {}
  const previousForPlan = chats[req.planId]
  if (previousForPlan && previousForPlan.sessionId !== req.sessionId) replaced.sessionId = previousForPlan.sessionId
  for (const [planId, oldBinding] of Object.entries(chats)) {
    if (planId !== req.planId && oldBinding.sessionId === req.sessionId) replaced.planId = planId
  }
  const next = { ...chats }
  delete next[req.planId]
  for (const [planId, oldBinding] of Object.entries(next)) if (oldBinding.sessionId === req.sessionId) delete next[planId]
  next[req.planId] = binding
  await writeChats(req.root, next)
  const plan = await loadPlan(req.root, req.planId).catch(() => undefined)
  const goal = plan?.goal ?? ''
  await say(deps, req.sessionId, briefing({ root: req.root, planId: req.planId, planName: goal || req.planId, goal }))
  return { binding, ...(Object.keys(replaced).length ? { replaced } : {}) }
}

export async function setWake(root: string, planId: string, wake: boolean): Promise<ChatBinding> {
  const chats = await readChats(root)
  const bound = chats[planId]
  if (!bound) throw new ChatBindingError('no_chat', `Plan ${planId} has no bound chat`)
  const next: ChatBinding = { ...bound, wake }
  chats[planId] = next
  await writeChats(root, chats)
  return next
}

type WakeItem = { key: string; root: string; planId: string; planName: string; taskId: string; title: string; kind: string; message: string }
type PendingPlan = { root: string; planId: string; planName: string; items: WakeItem[] }

/**
 * Mirrors `createAttentionNotifier`: the first snapshot is a baseline. New attention items are
 * batched per plan inside `windowMs` and sent as one `queue` prompt; sent keys (`runId:kind`) land
 * in `chat-woken.json` and survive restarts. A failed prompt keeps its key out of the file, so the
 * next snapshot retries it.
 */
export function createChatWaker(deps: ChatDeps & { windowMs?: number; schedule?: (fn: () => void, ms: number) => unknown }): (s: OrchestraSnapshot) => void {
  const windowMs = deps.windowMs ?? 5000
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  let baseline: Set<string> | undefined
  const woken = new Set<string>()
  const pending = new Map<string, PendingPlan>()
  let timer: unknown
  let flushing: Promise<void> = Promise.resolve()

  const collect = (snapshot: OrchestraSnapshot): WakeItem[] => {
    const out: WakeItem[] = []
    for (const repo of snapshot.repos) {
      const titleOf = (taskId: string) => repo.tasks.find((t) => t.id === taskId)?.title ?? taskId
      const push = (planId: string, planName: string, list: Attention[]) => {
        for (const a of list) out.push({ key: `${a.runId}:${a.kind}`, root: repo.root, planId, planName, taskId: a.taskId, title: titleOf(a.taskId), kind: a.kind, message: a.message })
      }
      push(repo.planId ?? 'main', repo.goal, repo.attention)
      for (const plan of (repo.plans ?? []).filter((p) => !p.current)) push(plan.id, plan.goal, plan.attention)
      // Waiting for the human is not an alarm, but the chat still has to hear about it: the
      // orchestrator's job is to check the work and ask for acceptance.
      for (const task of repo.tasks) {
        // The orchestrator's own cue (vr1): finished work waits for its check, not for the human yet.
        if (task.status === 'in_review' && task.check === 'pending') {
          out.push({ key: `${task.lastRunId ?? task.id}:check`, root: repo.root, planId: repo.planId ?? 'main', planName: repo.goal, taskId: task.id, title: task.title, kind: 'check_due', message: `Run finished — check it: orch verify ${task.id}, then --done --note "…" or --return "findings"` })
          continue
        }
        // Checked by the orchestrator itself: nothing new for it to hear.
        if (task.check === 'checked') continue
        const waiting = waitsForHuman(task)
        if (!waiting) continue
        out.push({
          key: `${task.lastRunId ?? task.id}:waiting`,
          root: repo.root,
          planId: repo.planId ?? 'main',
          planName: repo.goal,
          taskId: task.id,
          title: task.title,
          kind: 'awaiting_review',
          message: task.kind === 'decision' ? 'Decision needs a human' : 'Run finished and awaits review',
        })
      }
    }
    return out
  }

  const titleFor = async (item: WakeItem): Promise<string> => {
    if (item.title !== item.taskId || !deps.readTask) return item.title
    const info = await deps.readTask(item.root, item.planId, item.taskId).catch(() => undefined)
    return info?.task.title ?? item.taskId
  }

  const flush = async (): Promise<void> => {
    timer = undefined
    const batch = [...pending.values()]
    pending.clear()
    if (batch.length === 0) return
    const byRoot = new Map<string, PendingPlan[]>()
    for (const plan of batch) byRoot.set(plan.root, [...(byRoot.get(plan.root) ?? []), plan])
    for (const [root, plans] of byRoot) {
      const chats = await readChats(root)
      const persisted = await readWoken(root)
      const known = new Set([...persisted, ...woken])
      const sent: string[] = []
      for (const plan of plans) {
        const binding = chats[plan.planId]
        if (!binding?.wake) continue
        const fresh = plan.items.filter((i) => !known.has(i.key))
        if (fresh.length === 0) continue
        const lines = await Promise.all(fresh.map(async (i) => ({ planName: plan.planName, taskId: i.taskId, title: await titleFor(i), kind: i.kind, message: i.message })))
        try {
          await say(deps, binding.sessionId, wakeMessage(lines))
          for (const item of fresh) {
            woken.add(item.key)
            sent.push(item.key)
          }
        } catch {
          // Swallowed on purpose: with the key unwritten the next snapshot retries the batch.
        }
      }
      if (sent.length > 0) await writeWoken(root, new Set([...persisted, ...sent])).catch(() => {})
    }
  }

  const flushFn = (): Promise<void> => {
    flushing = flushing.then(() => flush()).catch(() => {})
    return flushing
  }

  return (snapshot) => {
    const items = collect(snapshot)
    const keys = new Set(items.map((i) => i.key))
    if (!baseline) {
      baseline = keys
      return
    }
    const fresh = items.filter((i) => !baseline!.has(i.key) && !woken.has(i.key))
    if (fresh.length === 0) return
    for (const item of fresh) {
      const id = `${item.root}\u0000${item.planId}`
      const plan = pending.get(id) ?? { root: item.root, planId: item.planId, planName: item.planName, items: [] }
      if (!plan.items.some((x) => x.key === item.key)) plan.items.push(item)
      pending.set(id, plan)
    }
    if (timer === undefined) timer = schedule(flushFn, windowMs)
  }
}
