import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RawEvent } from '../runs/raw-event.js'
import { AcpConnection } from './acp.js'
import { finishSteers, steerIdOfMail, transitionSteer } from '../runs/steers.js'

export type DshRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type DshRunState = {
  status: DshRunStatus
  exitCode: number | null
  startedAt: string
  finishedAt?: string
  sessionId?: string
  error?: string
  pid: number
}
export type RunnerArgs = { runDir: string; cwd: string; promptFile: string; model?: string; command: string; args: string[] }

export const DEFAULT_DSH_COMMAND = { command: 'dsh', args: ['--profile', 'acp'] }
const PROVIDER = 'deepseek-official'
const MAILBOX_POLL_MS = 250

export const runPaths = (runDir: string) => ({
  state: join(runDir, 'state.json'),
  events: join(runDir, 'events.jsonl'),
  mailbox: join(runDir, 'mailbox'),
})

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, file)
}

export async function readRunState(runDir: string): Promise<DshRunState | null> {
  try {
    return JSON.parse(await readFile(runPaths(runDir).state, 'utf8')) as DshRunState
  } catch {
    return null
  }
}

export async function readRunEvents(runDir: string): Promise<RawEvent[]> {
  const raw = await readFile(runPaths(runDir).events, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEvent)
}

type Mail = { kind: 'steer'; text: string; id?: string } | { kind: 'cancel' }

/** Takes mailbox items in name order; `cancel` sorts before `steer-*`. */
async function takeMail(mailbox: string): Promise<Mail[]> {
  const names = (await readdir(mailbox).catch(() => [] as string[])).sort()
  const out: Mail[] = []
  for (const name of names) {
    const file = join(mailbox, name)
    if (name === 'cancel') out.push({ kind: 'cancel' })
    else if (name.startsWith('steer-') && name.endsWith('.md')) out.push({ kind: 'steer', text: await readFile(file, 'utf8'), id: steerIdOfMail(name) })
    else continue
    await rm(file, { force: true })
  }
  return out
}

type Update = {
  sessionUpdate?: string
  toolCallId?: unknown
  title?: unknown
  status?: unknown
  rawInput?: unknown
  content?: { text?: string }
  used?: unknown
  size?: unknown
}

export async function runDshRun(args: RunnerArgs, now: () => Date = () => new Date()): Promise<DshRunState> {
  const paths = runPaths(args.runDir)
  await mkdir(paths.mailbox, { recursive: true })
  const state: DshRunState = { status: 'running', exitCode: null, startedAt: now().toISOString(), pid: process.pid }
  await writeJsonAtomic(paths.state, state)

  let writes: Promise<void> = Promise.resolve()
  const emit = (type: string, data: unknown): Promise<void> => {
    const line = `${JSON.stringify({ ts: now().toISOString(), type, backend: 'dsh', data })}\n`
    writes = writes.then(() => appendFile(paths.events, line))
    return writes
  }
  const finish = async (status: DshRunStatus, exitCode: number, error?: string): Promise<DshRunState> => {
    await writes
    Object.assign(state, { status, exitCode, finishedAt: now().toISOString() }, error ? { error } : {})
    await finishSteers(args.runDir, status === 'completed' ? 'run_finished' : status === 'cancelled' ? 'cancelled' : 'run_failed', () => writeJsonAtomic(paths.state, state))
    return state
  }

  const conn = AcpConnection.spawn(args.command, args.args, args.cwd)
  conn.onNotification = (method, params) => {
    if (method !== 'session/update') return
    const u = (params.update ?? {}) as Update
    const callId = String(u.toolCallId ?? '')
    if (u.sessionUpdate === 'tool_call') {
      void emit('tool_started', { tool: String(u.title ?? 'tool'), status: 'running', input: u.rawInput ?? {}, callId })
    } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
      void emit('tool_completed', { tool: String(u.title ?? 'tool'), status: u.status === 'failed' ? 'error' : 'completed', callId, ...(u.content?.text ? { output: u.content.text } : {}) })
    } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
      void emit('answer_delta', u.content.text)
    } else if (u.sessionUpdate === 'usage_update') {
      void emit('usage', { used: Number(u.used ?? 0), size: Number(u.size ?? 0) })
    }
  }
  conn.onRequest = async (method, params) => {
    if (method !== 'session/request_permission') throw new Error(`unsupported client method: ${method}`)
    // Under workspace-write every in-workspace action is already allowed: a permission request means escaping the sandbox.
    await emit('permission_denied', JSON.stringify(params.toolCall ?? {}))
    return { outcome: { outcome: 'selected', optionId: 'reject-once' } }
  }

  try {
    await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const session = await conn.request<{ sessionId: string }>('session/new', { cwd: args.cwd, mcpServers: [] })
    state.sessionId = session.sessionId
    await writeJsonAtomic(paths.state, state)
    if (args.model) {
      await conn.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: JSON.stringify([PROVIDER, args.model]) })
    }

    const queue: { text: string; id?: string }[] = []
    let cancelled = false
    let next: { text: string; id?: string } | undefined = { text: await readFile(args.promptFile, 'utf8') }
    const drainMail = async (interrupt: boolean) => {
      for (const item of await takeMail(paths.mailbox)) {
        if (item.kind === 'cancel') {
          cancelled = true
          await emit('steer', 'остановка по запросу')
        } else {
          queue.push({ text: item.text, ...(item.id ? { id: item.id } : {}) })
          await emit('steer', item.text.trim().slice(0, 200))
        }
        if (interrupt) conn.notify('session/cancel', { sessionId: session.sessionId })
      }
    }

    let turnNo = 0
    while (next !== undefined && !cancelled) {
      turnNo += 1
      await emit('turn_started', { turn: turnNo, text: next.text.trim().slice(0, 200), fullText: next.text })
      const turn = conn.request<{ stopReason: string }>('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: next.text }] })
      if (next.id) await transitionSteer(args.runDir, next.id, 'sent')
      const progress = { settled: false }
      const settledTurn = turn.then(
        () => {
          progress.settled = true
        },
        () => {
          progress.settled = true
        },
      )
      while (!progress.settled) {
        await drainMail(true)
        await Promise.race([settledTurn, new Promise((r) => setTimeout(r, MAILBOX_POLL_MS))])
      }
      const result = await turn
      if (next.id) await transitionSteer(args.runDir, next.id, 'acknowledged')
      await emit('turn_ended', { turn: turnNo, stopReason: result.stopReason })
      await drainMail(false)
      next = queue.shift()
    }

    await conn.request('session/close', { sessionId: session.sessionId }).catch(() => undefined)
    conn.kill()
    return cancelled ? await finish('cancelled', 130) : await finish('completed', 0)
  } catch (err) {
    conn.kill()
    const message = err instanceof Error ? err.message : String(err)
    await emit('run_failed', message)
    return finish('failed', 1, message)
  }
}
