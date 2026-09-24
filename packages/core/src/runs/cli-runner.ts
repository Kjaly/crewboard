import { type ChildProcess, spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { type SteerRecord, finishSteers, readSteer, steerIdOfMail, transitionSteer } from './steers.js'
import { type BackgroundTask, type Parsed, type RateLimited, type TurnUsage, parseClaudeLine, parseCodexLine } from './cli-parse.js'

export type CliKind = 'claude' | 'codex'
export type CliRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type CliUsage = { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; usd?: number }
export type CliRunState = {
  status: CliRunStatus
  exitCode: number | null
  startedAt: string
  finishedAt?: string
  sessionId?: string
  error?: string
  /** The supervisor: this process. */
  pid: number
  /**
   * The worker process the supervisor runs now (B19). It leads its own process group, so the group outlives a
   * supervisor that dies and can be stopped by its id; cleared when the worker exits.
   */
  workerPid?: number
  /** A run whose supervisor died, as the backend finished it: which worker it found and whether it stopped it. */
  interrupted?: { workerPid?: number; workerStopped: boolean }
  /** Set by the backend when it has asked the orphaned worker's group to stop. */
  stopRequestedAt?: string
  usage: CliUsage
  usageObservedAt?: string
}
export type CliRunnerArgs = { kind: CliKind; runDir: string; cwd: string; promptFile: string; model?: string; command: string; commandArgs?: string[]; background?: BackgroundTiming }
/** How long a Claude run stays open for the worker's own background work (bg1); tests shorten it. */
export type BackgroundTiming = { limitMs?: number; wakeGraceMs?: number; noticeMs?: number }

const MAILBOX_POLL_MS = 250
const STDERR_TAIL = 2000
/** The longest a run waits for background work the worker left running at the end of its turn. */
const BACKGROUND_LIMIT_MS = 60 * 60_000
/** Background work ended but the CLI did not wake the session with it: the runner says it itself. */
const WAKE_GRACE_MS = 30_000
/** A waiting run reports that it still waits, more often than the watch counts it stalled (watch/rules.ts). */
const WAIT_NOTICE_MS = 4 * 60_000

const describeBackground = (tasks: BackgroundTask[]) => tasks.map((t) => t.description || t.id).join('; ')

const paths = (runDir: string) => ({ state: join(runDir, 'state.json'), events: join(runDir, 'events.jsonl'), mailbox: join(runDir, 'mailbox') })

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, file)
}

/** `failure` of a Claude turn that hit the usage limit: the reset time first, then Claude's own words. */
export const rateLimitFailure = (limit: RateLimited, text: string): string =>
  `Claude usage limit reached${limit.type ? ` (${limit.type})` : ''}${limit.resetsAt ? `, resets at ${limit.resetsAt}` : ''}: ${text}`

export async function readCliRunState(runDir: string): Promise<CliRunState | null> {
  try {
    return JSON.parse(await readFile(paths(runDir).state, 'utf8')) as CliRunState
  } catch {
    return null
  }
}

type Mail = { kind: 'steer'; text: string; id?: string; mode: SteerRecord['mode'] } | { kind: 'cancel' }

async function takeMail(runDir: string): Promise<Mail[]> {
  const mailbox = paths(runDir).mailbox
  const names = (await readdir(mailbox).catch(() => [] as string[])).sort()
  const out: Mail[] = []
  for (const name of names) {
    const file = join(mailbox, name)
    const id = steerIdOfMail(name)
    if (name === 'cancel') out.push({ kind: 'cancel' })
    else if (name.startsWith('steer-') && name.endsWith('.md')) out.push({ kind: 'steer', text: await readFile(file, 'utf8'), ...(id ? { id } : {}), mode: (id && (await readSteer(runDir, id))?.mode) || 'auto' })
    else continue
    await rm(file, { force: true })
  }
  return out
}

type Session = {
  emit(type: string, data: unknown): Promise<void>
  onParsed(p: Parsed): void
  /** Records the worker process the run now waits on (undefined once it exited). */
  worker(pid: number | undefined): void
  state: CliRunState
  cancelled: boolean
  failure?: string
}

function exited(child: ChildProcess, stderr: { text: string }): Promise<number> {
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.text = (stderr.text + chunk.toString('utf8')).slice(-STDERR_TAIL)
  })
  return new Promise((resolve) => {
    child.on('error', (err) => {
      stderr.text = `${stderr.text}\n${err.message}`.slice(-STDERR_TAIL)
      resolve(127)
    })
    child.on('close', (code, signal) => resolve(code ?? (signal ? 130 : 1)))
  })
}

/**
 * Claude: one process for the whole run; every direction is another user message on stdin, same session.
 * Claude Code folds a message that arrives mid-turn into the running turn (one `result` for both), so turns cannot be
 * counted: with `--replay-user-messages` a message is taken when it is echoed back, and the session is idle when a
 * `result` arrives with nothing written-but-untaken. At idle a held direction becomes the next turn; with nothing
 * pending stdin closes and the run finishes. A `queue` direction waits for idle; `auto`/`interrupt` join the turn.
 *
 * Background work (bg1). Closing stdin while the session still runs background tasks (a `run_in_background` shell,
 * a monitor, a background subagent) makes the CLI kill them and exit: a worker that ended its turn «waiting for the
 * notification» lost its checks and the run went to review unfinished. So at idle, while `background_tasks_changed`
 * lists any task, stdin stays open: the CLI wakes the session with the task's notification as a new turn, and the run
 * finishes once a turn ends with nothing left in the background. Bounded: if the work outlives the limit, the runner
 * tells the worker to stop waiting and finish (one turn), then closes whatever still runs; if the CLI does not wake
 * the session within a grace period after the work ended, the runner sends the outcome as a turn itself.
 */
async function driveClaude(args: CliRunnerArgs, s: Session, prompt: string): Promise<number> {
  const child = spawn(
    args.command,
    [...(args.commandArgs ?? []), '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--replay-user-messages', '--dangerously-skip-permissions', ...(args.model ? ['--model', args.model] : [])],
    { cwd: args.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  )
  s.worker(child.pid)
  const stderr = { text: '' }
  const done = exited(child, stderr)
  child.stdin?.on('error', () => {})
  const tools = new Map<string, string>()
  let started = 0
  let ended = 0
  let closed = false
  let busy = false
  let lastTurnOk = false
  /** Why the last turn failed (`is_error`), and the limit it hit if Claude rejected it on a rate limit. */
  let lastTurnError: string | undefined
  let lastLimit: RateLimited | undefined
  let limit: RateLimited | undefined
  const untaken: { text: string; id?: string }[] = []
  const held: { text: string; id?: string }[] = []
  const acknowledgements: Promise<unknown>[] = []
  const limitMs = args.background?.limitMs ?? BACKGROUND_LIMIT_MS
  const wakeGraceMs = args.background?.wakeGraceMs ?? WAKE_GRACE_MS
  const noticeMs = args.background?.noticeMs ?? WAIT_NOTICE_MS
  let background: BackgroundTask[] = []
  /** What ended in the background since the last turn: the text of a runner-sent follow-up. */
  const endedInBackground: string[] = []
  let waitingSince: number | undefined
  let lastNotice = 0
  let quietSince: number | undefined
  let limitSent = false
  const turnStarted = (text: string, woken?: true) => {
    started += 1
    busy = true
    return s.emit('turn_started', { turn: started, text: text.trim().slice(0, 200), fullText: text, ...(woken ? { woken } : {}) })
  }
  const send = async (text: string, id?: string) => {
    if (!child.pid || !child.stdin?.writable) return false
    await turnStarted(text)
    untaken.push({ text, ...(id ? { id } : {}) })
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
    if (id) await transitionSteer(args.runDir, id, 'sent')
    return true
  }
  const sendSteer = async (m: { text: string; id?: string }) => {
    await s.emit('steer', m.text.trim().slice(0, 200))
    return send(m.text, m.id)
  }
  const close = () => {
    closed = true
    child.stdin?.end()
  }
  // The poll timer and the end of a turn both drain the mailbox: serialize so no steer is taken twice.
  let draining: Promise<void> = Promise.resolve()
  const drain = () => {
    draining = draining.then(drainOnce, drainOnce)
    return draining
  }
  const drainOnce = async () => {
    for (const m of await takeMail(args.runDir)) {
      if (m.kind === 'cancel') {
        // While background work runs the last answer was «waiting», not a report: a stop is a real stop.
        if (!busy && lastTurnOk && waitingSince === undefined) {
          // The worker has already given its final report: stopping now finishes the run, it does not discard it.
          await s.emit('warning', 'остановка после финального отчёта: запуск завершается как выполненный')
          if (!closed) close()
          continue
        }
        s.cancelled = true
        await s.emit('steer', 'остановка по запросу')
        // The worker runs in its own process group: stop the commands it started too, not only the CLI itself.
        try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { child.kill('SIGTERM') }
      } else if (closed || s.cancelled) {
        if (m.id) await transitionSteer(args.runDir, m.id, 'abandoned', s.cancelled ? 'cancelled' : 'run_finished')
        await s.emit('warning', 'поправка пришла после завершения запуска и не доставлена')
      } else if (busy && m.mode === 'queue') held.push(m)
      else await sendSteer(m)
    }
    if (busy || closed || s.cancelled) return
    const next = held.splice(0)
    for (const m of next) await sendSteer(m)
    if (!next.length && !(await awaitBackground())) close()
  }
  /** At idle: true while the run stays open for background work (see above), false when it may finish. */
  const awaitBackground = async (): Promise<boolean> => {
    const now = Date.now()
    if (background.length) {
      quietSince = undefined
      waitingSince ??= now
      if (!lastNotice || now - lastNotice >= noticeMs) {
        lastNotice = now
        await s.emit('background_wait', { tasks: background, minutes: Math.floor((now - waitingSince) / 60_000) })
      }
      if (now - waitingSince < limitMs) return true
      if (limitSent) {
        await s.emit('background_abandoned', { tasks: background })
        return false
      }
      limitSent = true
      await send(
        `Your background work is still running after ${Math.round(limitMs / 60_000)} min: ${describeBackground(background)}. Stop it, or run what you need in the foreground with a timeout, then finish the task and give your final report now. Nothing will wake you after this turn.`,
      )
      return true
    }
    if (waitingSince === undefined) return false
    // The work ended while the session idled: the CLI wakes the session with its notification.
    quietSince ??= now
    if (now - quietSince < wakeGraceMs) return true
    quietSince = undefined
    await send(`Your background work has finished: ${endedInBackground.join('; ') || 'no outcome reported'}. Continue the task and finish it with your final report.`)
    return true
  }
  const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
  rl.on('line', (line) => {
    const p = parseClaudeLine(line, tools)
    if (p.rateLimited) limit = p.rateLimited
    if (p.background) background = p.background
    if (p.backgroundDone) endedInBackground.push(p.backgroundDone.summary || `${p.backgroundDone.id}: ${p.backgroundDone.status}`)
    // The CLI woke the idle session with a background notification: a turn the runner did not send.
    if (!busy && !closed && waitingSince !== undefined && p.events.some(([type]) => type === 'answer_delta' || type === 'tool_started')) void turnStarted(endedInBackground.join('; ') || 'background work finished', true)
    s.onParsed(p)
    if (p.replay !== undefined && untaken.length) {
      // A replay may carry several folded messages; an unrecognised one stands for the oldest.
      const hit = untaken.filter((u) => p.replay?.includes(u.text.trim()))
      for (const u of hit.length ? hit : [untaken[0] as { text: string; id?: string }]) {
        untaken.splice(untaken.indexOf(u), 1)
        if (u.id) acknowledgements.push(transitionSteer(args.runDir, u.id, 'acknowledged'))
      }
    }
    if (!p.turnEnd) return
    ended += 1
    lastTurnOk = !p.turnEnd.failed
    lastTurnError = p.turnEnd.failed ? (p.turnEnd.error ?? 'turn failed') : undefined
    lastLimit = p.turnEnd.failed ? limit : undefined
    limit = undefined
    endedInBackground.length = 0
    quietSince = undefined
    if (background.length) waitingSince ??= Date.now()
    else {
      waitingSince = undefined
      lastNotice = 0
    }
    if (!untaken.length) busy = false
    void s.emit('turn_ended', { turn: ended, stopReason: p.turnEnd.stopReason })
    void drain()
  })
  await send(prompt)
  const timer = setInterval(() => void drain(), MAILBOX_POLL_MS)
  const code = await done
  s.worker(undefined)
  clearInterval(timer)
  closed = true
  await draining
  await Promise.all(acknowledgements)
  // B01: Claude ends a turn that hit the usage limit or an API error with exit code 0; the last `result` decides.
  if (lastTurnError !== undefined && !s.cancelled && !s.failure) s.failure = lastLimit ? rateLimitFailure(lastLimit, lastTurnError) : lastTurnError
  if (code !== 0 && !s.cancelled && !s.failure) s.failure = stderr.text.trim() || `claude exited with code ${code}`
  return code
}

/** Codex: one `codex exec` process per turn; a steer interrupts the turn and resumes the same thread with the correction. */
async function driveCodex(args: CliRunnerArgs, s: Session, prompt: string): Promise<number> {
  const queue: { text: string; id?: string }[] = []
  let next: { text: string; id?: string } | undefined = { text: prompt }
  let thread: string | undefined
  let turn = 0
  let code = 0
  let finishing = false
  while (next !== undefined && !s.cancelled && !s.failure) {
    turn += 1
    await s.emit('turn_started', { turn, text: next.text.trim().slice(0, 200), fullText: next.text })
    const model = args.model ? ['-m', args.model] : []
    const cli = thread
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', ...model, thread, next.text]
      : ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', ...model, next.text]
    const child = spawn(args.command, [...(args.commandArgs ?? []), ...cli], { cwd: args.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    s.worker(child.pid)
    const steerId = next.id
    let acknowledged = false
    const acknowledgements: Promise<unknown>[] = []
    const stderr = { text: '' }
    const done = exited(child, stderr)
    let interrupted = false
    // A direction interrupts only a process that has reported its thread: one killed while still booting leaves no
    // thread to resume, and the correction would run as a fresh `exec` without the task.
    let threadReported = false
    let interruptOnThread = false
    const interrupt = () => { interrupted = true; child.kill('SIGINT') }
    let turnFailed: string | undefined
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    rl.on('line', (line) => {
      const p = parseCodexLine(line)
      if (p.sessionId) {
        thread = p.sessionId
        threadReported = true
        if (steerId && !acknowledged) { acknowledged = true; acknowledgements.push(transitionSteer(args.runDir, steerId, 'acknowledged')) }
        if (interruptOnThread) { interruptOnThread = false; interrupt() }
      }
      s.onParsed(p)
      if (p.turnEnd) {
        void s.emit('turn_ended', { turn, stopReason: p.turnEnd.stopReason })
        if (p.turnEnd.failed) turnFailed = p.turnEnd.error ?? 'turn failed'
      }
    })
    // Only now that `close` and stdout are listened to: a process that exits during this await would otherwise have its
    // output flushed and its `close` missed, and the run would wait forever.
    if (steerId && child.pid) await transitionSteer(args.runDir, steerId, 'sent')
    // A `queue` direction waits for the turn to end; any other direction or a cancel interrupts it.
    const collect = async (running: boolean) => {
      for (const m of await takeMail(args.runDir)) {
        if (m.kind === 'cancel' && !running && code === 0 && !turnFailed) {
          // The turn that just ended was the final report: stopping now finishes the run, it does not discard it.
          await s.emit('warning', 'остановка после финального отчёта: запуск завершается как выполненный')
          finishing = true
        } else if (m.kind === 'cancel') {
          s.cancelled = true
          await s.emit('steer', 'остановка по запросу')
          if (running) child.kill('SIGINT')
        } else {
          queue.push({ text: m.text, ...(m.id ? { id: m.id } : {}) })
          await s.emit('steer', m.text.trim().slice(0, 200))
          if (m.mode === 'queue' || !running) continue
          if (threadReported) interrupt()
          else interruptOnThread = true
        }
      }
    }
    let draining: Promise<void> = Promise.resolve()
    const timer = setInterval(() => {
      draining = draining.then(() => collect(true))
    }, MAILBOX_POLL_MS)
    code = await done
    s.worker(undefined)
    clearInterval(timer)
    await draining
    // A direction that arrived as the turn ended is still undelivered: it becomes the next turn.
    await collect(false)
    await Promise.all(acknowledgements)
    if (s.cancelled) break
    if (!interrupted && (code !== 0 || turnFailed)) {
      s.failure = turnFailed ?? (stderr.text.trim() || `codex exited with code ${code}`)
      break
    }
    // Directions left in the queue stay `queued` and are abandoned when the run finishes.
    next = finishing ? undefined : queue.shift()
  }
  return code
}

export async function runCliRun(args: CliRunnerArgs, now: () => Date = () => new Date()): Promise<CliRunState> {
  const p = paths(args.runDir)
  await mkdir(p.mailbox, { recursive: true })
  const state: CliRunState = {
    status: 'running',
    exitCode: null,
    startedAt: now().toISOString(),
    pid: process.pid,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }
  await writeJsonAtomic(p.state, state)
  let writes: Promise<void> = Promise.resolve()
  const add = (u: TurnUsage) => {
    state.usage.calls += 1
    state.usage.inputTokens += u.input
    state.usage.outputTokens += u.output
    state.usage.cacheReadTokens += u.cacheRead
    state.usage.cacheWriteTokens += u.cacheWrite
    state.usage.reasoningTokens += u.reasoning
  }
  const s: Session = {
    state,
    cancelled: false,
    emit(type, data) {
      const line = `${JSON.stringify({ ts: now().toISOString(), type, backend: args.kind, data })}\n`
      writes = writes.then(() => appendFile(p.events, line))
      return writes
    },
    worker(pid) {
      if (pid === undefined) delete state.workerPid
      else state.workerPid = pid
      writes = writes.then(() => writeJsonAtomic(p.state, state))
    },
    onParsed(parsed) {
      for (const [type, data] of parsed.events) void s.emit(type, data)
      if (parsed.sessionId && state.sessionId !== parsed.sessionId) {
        state.sessionId = parsed.sessionId
        writes = writes.then(() => writeJsonAtomic(p.state, state))
      }
      if (parsed.turnEnd) {
        add(parsed.turnEnd.usage)
        state.usageObservedAt = now().toISOString()
        if (parsed.turnEnd.usdTotal !== undefined) state.usage.usd = parsed.turnEnd.usdTotal
        writes = writes.then(() => writeJsonAtomic(p.state, state))
      }
    },
  }

  let code: number
  try {
    const prompt = await readFile(args.promptFile, 'utf8')
    code = args.kind === 'claude' ? await driveClaude(args, s, prompt) : await driveCodex(args, s, prompt)
  } catch (err) {
    s.failure = err instanceof Error ? err.message : String(err)
    code = 1
  }
  if (s.failure && !s.cancelled) await s.emit('run_failed', s.failure)
  await writes
  const status: CliRunStatus = s.cancelled ? 'cancelled' : s.failure ? 'failed' : 'completed'
  Object.assign(state, { status, exitCode: s.cancelled ? 130 : s.failure ? code || 1 : 0, finishedAt: now().toISOString() }, s.failure && !s.cancelled ? { error: s.failure } : {})
  await finishSteers(args.runDir, status === 'completed' ? 'run_finished' : status === 'cancelled' ? 'cancelled' : 'run_failed', () => writeJsonAtomic(p.state, state))
  return state
}
