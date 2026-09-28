import { type ChildProcess, spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { type SteerRecord, finishSteers, readSteer, steerIdOfMail, transitionSteer } from './steers.js'
import { type BackgroundTask, type Parsed, type RateLimited, type TurnUsage, opencodeTurnState, parseClaudeLine, parseCodexLine, parseCursorLine, parseGeminiOutput, parseGrokLine, parseOpencodeLine } from './cli-parse.js'
import { type FailureReason, failureTextOf } from './failure.js'
import { uncommittedFiles } from './git-status.js'
import { slotsDir } from '../slots/slots.js'
import { AnthropicPolicyError, assertAnthropicLaunchAllowed, classifyAnthropicRoute } from '../routing/anthropic-policy.js'
import type { Backend } from '../preflight/preflight.js'

/** The preflight backend name of each direct CLI kind, for the resolved-route policy check. */
const CLI_BACKEND: Record<CliKind, Backend> = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build' }

export type CliKind = 'claude' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'grok'
export type CliRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type CliUsage = { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; usd?: number }
export type CliRunState = {
  status: CliRunStatus
  exitCode: number | null
  startedAt: string
  finishedAt?: string
  sessionId?: string
  error?: string
  /**
   * The non-secret auth channel the launch resolved and the policy revision that allowed it: how a new
   * guarded API-key run is told apart from an old child whose credential cannot be verified. Absent on
   * pre-policy runs.
   */
  authChannel?: string
  policyRevision?: string
  /** The supervisor: this process. */
  pid: number
  /**
   * The worker process the supervisor runs now (B19). It leads its own process group, so the group outlives a
   * supervisor that dies and can be stopped by its id; cleared when the worker exits.
   */
  workerPid?: number
  /** A run whose supervisor died, as the backend finished it: which worker it found and whether it stopped it. */
  interrupted?: { workerPid?: number; workerStopped: boolean }
  /** Why a `failed` run failed (fo1), as the runner or the backend read it; absent on runs of older builds. */
  reason?: FailureReason
  /** Set by the backend when it has asked the orphaned worker's group to stop. */
  stopRequestedAt?: string
  usage: CliUsage
  cacheWriteCallsObserved?: number
  cacheWriteCallsTotal?: number
  cacheWriteCallsPartial?: number
  usageObservedAt?: string
}
/**
 * `readOnly` (dr2): Claude runs in plan permission mode, Codex in its read-only sandbox — neither can change `cwd`.
 * `effort` (ef1): Claude's `--effort`, Codex's `model_reasoning_effort`; absent — the CLI's default.
 */
export type CliRunnerArgs = { kind: CliKind; runDir: string; cwd: string; promptFile: string; model?: string; effort?: string; command: string; commandArgs?: string[]; background?: BackgroundTiming; readOnly?: boolean; commitRequired?: boolean; /** Non-secret: the resolved auth channel and policy revision, so a steer can tell a guarded run from an old child. */ authChannel?: string; policyRevision?: string }
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

// Events that end the current answer block, the same set report.ts uses to glue a finished answer back together
// (bg1): a tool call or a runner note starts a new one. Kept here rather than imported, so this small subprocess
// entry does not pull in report.ts's own import of the verdict's multi-language parsing (cm1).
const BREAK_TYPES = new Set(['tool_started', 'tool_completed', 'error', 'failed', 'run_failed', 'steer', 'permission_denied', 'final', 'turn_started'])

/**
 * cm1: a light stand-in for `claimOf` (orchestration/verdict.ts) — the same «Result:»/«Done:» labels, in the same
 * languages, without its full positive/negative/hedge parsing of the value that follows. Good enough to decide
 * whether to nudge mid-run; the sync-level check (orchestration/sync.ts) still reads the final answer with the
 * real one. Kept local rather than imported: `claimOf` alone would triple this subprocess entry's bundle size.
 */
const REPORT_LABEL =
  /^(?:результат|result|ergebnis|résultat|resultat|resultado|risultato|wynik|готово|сделано|выполнено|зроблено|виконано|done|finished|completed|fertig|erledigt|terminé|fait|hecho|listo|terminado|feito|pronto|concluído|fatto|completato|gotowe|zrobione)\s*[:.!]/iu
const looksLikeReport = (text: string): boolean =>
  text
    .split(/\r?\n/)
    .some((line) => REPORT_LABEL.test(line.trim().replace(/^>\s*/, '').replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '')))

/**
 * cm1: a worker whose final turn claims a result but leaves its copy dirty is asked, once, to commit before it
 * reports again — the same nudge for Claude and Codex, so the sync-level check (orchestration/sync.ts) reads a
 * commit made after this exact wording the same way it reads one made without ever seeing it.
 */
const commitNudgeText = (uncommitted: number): string =>
  `Your work is not committed: ${uncommitted} files. Commit it on this branch with a message in the repository's convention, then end with your report again.`

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
  /** Set with `failure` when the runner knows more than the text: a rate limit with its reset time. */
  reason?: FailureReason
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
async function driveClaude(args: CliRunnerArgs, s: Session, prompt: string, env: NodeJS.ProcessEnv): Promise<number> {
  // Checked here too, immediately before the worker child exists: a direct `runCliRun` call, a stale args
  // file or an environment that changed since the launch can never put a Claude model behind an unsupported
  // channel. `--bare` alone is not the guard; the policy is.
  assertAnthropicLaunchAllowed(env)
  const child = spawn(
    args.command,
    // `--bare` (docs/en/headless, 2026-09-28): never reads OAuth credentials or the system keychain, so the
    // run can only authenticate with the explicit ANTHROPIC_API_KEY the API-only policy configured. It also
    // keeps host hooks, plugins, MCP servers and CLAUDE.md out of an unattended run.
    [...(args.commandArgs ?? []), '--bare', '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--replay-user-messages', ...(args.readOnly ? ['--permission-mode', 'plan'] : ['--dangerously-skip-permissions']), ...(args.model ? ['--model', args.model] : []), ...(args.effort ? ['--effort', args.effort] : [])],
    { cwd: args.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env },
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
  /** The current turn's answer, glued back from its `answer_delta` chunks (cm1): read once the turn ends. */
  let turnText = ''
  /** cm1: the commit nudge is sent at most once per run. */
  let commitNudgeSent = false
  const turnStarted = (text: string, woken?: true) => {
    started += 1
    busy = true
    turnText = ''
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
          await s.emit('warning', { code: 'stop_after_report' })
          if (!closed) close()
          continue
        }
        s.cancelled = true
        await s.emit('steer', { code: 'stop_requested' })
        // The worker runs in its own process group: stop the commands it started too, not only the CLI itself.
        try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { child.kill('SIGTERM') }
      } else if (closed || s.cancelled) {
        if (m.id) await transitionSteer(args.runDir, m.id, 'abandoned', s.cancelled ? 'cancelled' : 'run_finished')
        await s.emit('warning', { code: 'steer_after_finish' })
      } else if (busy && m.mode === 'queue') held.push(m)
      else await sendSteer(m)
    }
    if (busy || closed || s.cancelled) return
    const next = held.splice(0)
    for (const m of next) await sendSteer(m)
    if (next.length) return
    if (await awaitBackground()) return
    if (await checkCommit()) return
    close()
  }
  /**
   * cm1: the turn that just ended claimed a result but left the copy dirty — asked once to commit and report
   * again, before the run is allowed to close. `false` leaves the close to the caller, whatever the reason.
   */
  const checkCommit = async (): Promise<boolean> => {
    if (args.commitRequired === false || commitNudgeSent || !lastTurnOk || !looksLikeReport(turnText)) return false
    const uncommitted = await uncommittedFiles(args.cwd)
    if (!uncommitted) return false
    commitNudgeSent = true
    await s.emit('commit_nudge', { uncommitted })
    await send(commitNudgeText(uncommitted))
    return true
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
    for (const [type, data] of p.events) {
      if (type === 'answer_delta') turnText += String(data)
      else if (BREAK_TYPES.has(type)) turnText = ''
    }
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
  if (lastTurnError !== undefined && !s.cancelled && !s.failure) {
    s.failure = lastLimit ? rateLimitFailure(lastLimit, lastTurnError) : lastTurnError
    if (lastLimit) s.reason = { code: 'rate_limited', ...(lastLimit.resetsAt ? { resetsAt: lastLimit.resetsAt } : {}) }
  }
  // fo1: the worker's own `Error:` line, not the first bytes of its stderr.
  if (code !== 0 && !s.cancelled && !s.failure) {
    s.failure = failureTextOf(stderr.text, `claude exited with code ${code}`)
  }
  return code
}

/** Codex: one `codex exec` process per turn; a steer interrupts the turn and resumes the same thread with the correction. */
async function driveCodex(args: CliRunnerArgs, s: Session, prompt: string, env: NodeJS.ProcessEnv): Promise<number> {
  const queue: { text: string; id?: string }[] = []
  let next: { text: string; id?: string } | undefined = { text: prompt }
  let thread: string | undefined
  let turn = 0
  let code = 0
  let finishing = false
  /** cm1: the commit nudge is sent at most once per run. */
  let commitNudgeSent = false
  while (next !== undefined && !s.cancelled && !s.failure) {
    turn += 1
    await s.emit('turn_started', { turn, text: next.text.trim().slice(0, 200), fullText: next.text })
    /** The current turn's answer, glued back from its `answer_delta` chunks (cm1): read once the turn ends. */
    let turnText = ''
    const model = [...(args.model ? ['-m', args.model] : []), ...(args.effort ? ['-c', `model_reasoning_effort="${args.effort}"`] : [])]
    const sandbox = args.readOnly ? 'read-only' : 'workspace-write'
    // A linked worktree stores its index, objects and refs in the main repository's .git, outside its cwd.
    // The global check queue is outside it too. Grant only those paths when this worker actually owns commits;
    // an orchestrator-commit contract grants the slot directory but keeps Git metadata read-only to the worker.
    const writableRoots: string[] = []
    if (!args.readOnly && basename(args.command) === 'codex' && !args.commandArgs?.length) {
      const checkSlots = slotsDir(process.env, homedir())
      await mkdir(checkSlots, { recursive: true })
      writableRoots.push(checkSlots)
      if (args.commitRequired !== false) {
        try {
          writableRoots.push(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: args.cwd, encoding: 'utf8' }).trim())
        } catch {
          // A non-repository draft has no Git metadata to grant; its normal preflight handles Git errors.
        }
      }
    }
    const writable = writableRoots.flatMap((root) => ['--add-dir', root])
    const cli = thread
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, ...model, thread, next.text]
      : ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, ...model, next.text]
    const child = spawn(args.command, [...(args.commandArgs ?? []), ...writable, ...cli], { cwd: args.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env })
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
      for (const [type, data] of p.events) {
        if (type === 'answer_delta') turnText += String(data)
        else if (BREAK_TYPES.has(type)) turnText = ''
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
          await s.emit('warning', { code: 'stop_after_report' })
          finishing = true
        } else if (m.kind === 'cancel') {
          s.cancelled = true
          await s.emit('steer', { code: 'stop_requested' })
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
      s.failure = turnFailed ?? failureTextOf(stderr.text, `codex exited with code ${code}`)
      break
    }
    // Directions left in the queue stay `queued` and are abandoned when the run finishes.
    next = finishing ? undefined : queue.shift()
    // cm1: about to close with a claimed result but a dirty copy — ask once to commit and report again.
    if (next === undefined && args.commitRequired !== false && !commitNudgeSent && looksLikeReport(turnText)) {
      const uncommitted = await uncommittedFiles(args.cwd)
      if (uncommitted) {
        commitNudgeSent = true
        await s.emit('commit_nudge', { uncommitted })
        next = { text: commitNudgeText(uncommitted) }
      }
    }
  }
  return code
}

/**
 * rb1: the shared shape behind OpenCode, Cursor Agent and Grok CLI — each spawns one process per turn (like Codex),
 * and takes a steer either as an interrupt (kill the turn's process, then continue: OpenCode and Cursor resume the
 * reported session/chat id; Grok has no verified resume flag, so its next turn is a fresh one-shot) or queued for
 * the next turn. Gemini CLI is deliberately driven one-shot: `--output-format json` prints one object at exit
 * (its documented `stream-json` mode is unused — see GEMINI_CONFIG), so it takes `parseFinal` instead of
 * `makeLineParser` and `interruptible: false`, so a steer always waits for the current turn to finish. Adding a
 * fifth CLI of either shape is this table plus a `cli-parse.ts` parser, not a new `driveX` function.
 */
type TurnCliConfig = {
  /** This turn's argv (model/effort/readOnly/session baked in); `text` is the prompt or steer text. */
  buildArgs(o: { model?: string; effort?: string; readOnly?: boolean; session?: string; text: string; promptFile?: string; cwd?: string }): string[]
  /** A fresh per-turn line parser (OpenCode accumulates tokens/cost across several `step_finish` lines per turn). */
  makeLineParser?(): (line: string) => Parsed
  /** Gemini CLI: one `json` object at exit (its `stream-json` mode is deliberately unused); parse the whole stdout. */
  parseFinal?(stdout: string): Parsed
  /** How `text` reaches the process: a trailing argv word (default), its stdin (Gemini), or `--prompt-file` (Grok). */
  promptVia?: 'arg' | 'stdin' | 'file'
  /** Whether a steer can interrupt the running turn (SIGINT + resume) or must always queue for the next one. */
  interruptible: boolean
  fallbackError: string
}

/**
 * `opencode run`, verified live against 1.18.30 (`opencode run --help`): the positional `message..`, `-m`, `--variant`,
 * `--agent`, `--session`, `--format json`, `--pure`, `--auto` and `--dir` are all real flags. `plan` is the built-in
 * read-only agent, `build` the full one; `--auto` auto-approves what the agent is not denied so nothing waits on a
 * prompt a headless run cannot show (the same flags the porch adapter drove, `backend_run.sh build_cmd_opencode`).
 * `--dir` pins the run to `cwd`: a live check saw opencode resolve its project elsewhere and write files outside it.
 */
const OPENCODE_CONFIG: TurnCliConfig = {
  interruptible: true,
  buildArgs: ({ model, effort, readOnly, session, cwd, text }) => [
    'run',
    '--pure',
    '--agent',
    readOnly ? 'plan' : 'build',
    '--auto',
    ...(model ? ['-m', model] : []),
    ...(effort ? ['--variant', effort] : []),
    ...(session ? ['--session', session] : []),
    ...(cwd ? ['--dir', cwd] : []),
    '--format',
    'json',
    text,
  ],
  makeLineParser: () => {
    const turn = opencodeTurnState()
    return (line) => parseOpencodeLine(line, turn)
  },
  fallbackError: 'opencode exited with code',
}

/**
 * `cursor-agent`, verified live against 2026.01.23 (`cursor-agent --help`): `--print --output-format stream-json`,
 * `--stream-partial-output` (text deltas, not just whole messages), `--mode plan` as its read-only mode, `--force`
 * to allow what is not denied, `--model`, `--resume <chatId>`, the positional prompt. `--approve-mcps` exists only
 * for headless mode — without it a configured MCP server would wait on an approval nothing can give.
 */
const CURSOR_CONFIG: TurnCliConfig = {
  interruptible: true,
  buildArgs: ({ model, readOnly, session, text }) => [
    '--print',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--approve-mcps',
    ...(model ? ['--model', model] : []),
    ...(readOnly ? ['--mode', 'plan'] : ['--force']),
    ...(session ? ['--resume', session] : []),
    text,
  ],
  makeLineParser: () => {
    const tools = new Map<string, string>()
    return (line) => parseCursorLine(line, tools)
  },
  fallbackError: 'cursor-agent exited with code',
}

/**
 * Grok CLI, verified only against the porch adapter's `build_cmd_grok` (itself probed on Grok Build 0.2.112) — the
 * CLI is not installed here. One-shot headless is `--prompt-file <path>` ("Single-turn prompt from a file": the
 * file alone selects non-TUI mode, no `-p` alongside); the read-only half is porch's kernel sandbox plus tool
 * allowlist verbatim. There is no verified resume flag: a steer runs as a fresh turn, never a resumed session.
 */
const GROK_CONFIG: TurnCliConfig = {
  interruptible: true,
  promptVia: 'file',
  buildArgs: ({ model, effort, readOnly, promptFile }) => [
    ...(readOnly
      ? ['--sandbox', 'read-only', '--no-plan', '--tools', 'read_file,grep,list_dir,run_terminal_cmd,web_search,web_fetch', '--disallowed-tools', 'search_replace,write,Agent', '--no-subagents', '--no-memory']
      : ['--always-approve']),
    ...(model ? ['-m', model] : []),
    ...(effort ? ['--reasoning-effort', effort] : []),
    '--output-format',
    'streaming-json',
    '--verbatim',
    '--prompt-file',
    promptFile ?? '',
  ],
  makeLineParser: () => parseGrokLine,
  fallbackError: 'grok exited with code',
}

/**
 * Gemini CLI, verified only against current docs (google-gemini/gemini-cli `docs/cli/cli-reference.md`:
 * `--approval-mode` choices including `plan`, `--output-format` choices `text`/`json`/`stream-json`) and
 * upstream source — the CLI is not installed here. The prompt goes on stdin: `isHeadlessMode`
 * (packages/core/src/utils/headless.ts) treats a non-TTY stdin/stdout as headless and `gemini.tsx` then reads
 * piped stdin into `input` — the documented `cat file | gemini` shape; `-p` would force the same mode through
 * argv, but the prompt already lives in a file. `--output-format json` prints one object at exit; `stream-json`
 * exists upstream too (init/message/tool_use/result lines with a `session_id` that `-r` resumes) and is
 * deliberately unused — one object is the smallest contract to keep honest against a CLI nobody here can run.
 * `plan` is docs-verified only, so a draft gets a detached worktree instead of trusting it (cli-backend
 * `readOnlyLaunch`). `-e none` and an empty `--allowed-mcp-server-names` keep extensions and MCP servers out of
 * a headless run (porch's hardening).
 */
const GEMINI_CONFIG: TurnCliConfig = {
  interruptible: false,
  promptVia: 'stdin',
  buildArgs: ({ model, readOnly }) => ['--output-format', 'json', '--approval-mode', readOnly ? 'plan' : 'yolo', '-e', 'none', '--allowed-mcp-server-names', '', ...(model ? ['--model', model] : [])],
  parseFinal: parseGeminiOutput,
  fallbackError: 'gemini exited with code',
}

const TURN_CLI_CONFIG: Partial<Record<CliKind, TurnCliConfig>> = { opencode: OPENCODE_CONFIG, cursor: CURSOR_CONFIG, grok: GROK_CONFIG, gemini: GEMINI_CONFIG }

/** rb1: OpenCode / Cursor Agent / Grok CLI / Gemini CLI, driven from the shared per-turn-process shape above. */
async function driveTurnCli(args: CliRunnerArgs, s: Session, prompt: string, cfg: TurnCliConfig, env: NodeJS.ProcessEnv): Promise<number> {
  const queue: { text: string; id?: string }[] = []
  let next: { text: string; id?: string } | undefined = { text: prompt }
  let session: string | undefined
  let turn = 0
  let code = 0
  let finishing = false
  /** Each turn is its own process: `turnEnd.usdTotal` is that turn's cost — the run's total is the sum. */
  let usdTotal = 0
  /** cm1: the commit nudge is sent at most once per run. */
  let commitNudgeSent = false
  while (next !== undefined && !s.cancelled && !s.failure) {
    turn += 1
    await s.emit('turn_started', { turn, text: next.text.trim().slice(0, 200), fullText: next.text })
    /** The current turn's answer, glued back from its `answer_delta` chunks (cm1): read once the turn ends. */
    let turnText = ''
    // `file` delivery (Grok `--prompt-file`): each turn's text goes to its own file inside the run dir.
    const promptFile = cfg.promptVia === 'file' ? join(args.runDir, `turn-${turn}.prompt.txt`) : undefined
    if (promptFile) await writeFile(promptFile, next.text)
    const cli = cfg.buildArgs({ model: args.model, effort: args.effort, readOnly: args.readOnly, session, text: next.text, cwd: args.cwd, ...(promptFile ? { promptFile } : {}) })
    const child = spawn(args.command, [...(args.commandArgs ?? []), ...cli], { cwd: args.cwd, stdio: [cfg.promptVia === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true, env })
    if (cfg.promptVia === 'stdin') child.stdin?.end(next.text)
    s.worker(child.pid)
    const steerId = next.id
    let acknowledged = false
    const acknowledgements: Promise<unknown>[] = []
    const stderr = { text: '' }
    const done = exited(child, stderr)
    let interrupted = false
    // A direction interrupts only a turn whose session is known — one killed while still booting leaves nothing to
    // resume, and the correction would run as a fresh turn without the original task. `session` is already set on a
    // resumed turn; `turnReported` tracks this turn's own first session line, which is what acknowledges a steer.
    let turnReported = false
    let interruptOnSession = false
    const interrupt = () => {
      interrupted = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGINT')
        else child.kill('SIGINT')
      } catch {
        child.kill('SIGINT')
      }
    }
    let turnFailed: string | undefined
    let stdoutBuf = ''
    const onSession = () => {
      if (turnReported) return
      turnReported = true
      if (steerId && !acknowledged) {
        acknowledged = true
        acknowledgements.push(transitionSteer(args.runDir, steerId, 'acknowledged'))
      }
      if (interruptOnSession) {
        interruptOnSession = false
        interrupt()
      }
    }
    const take = (p: Parsed) => {
      if (p.sessionId) {
        session = p.sessionId
        onSession()
      }
      for (const [type, data] of p.events) {
        if (type === 'answer_delta') turnText += String(data)
        else if (BREAK_TYPES.has(type)) turnText = ''
      }
      if (p.turnEnd?.usdTotal !== undefined) {
        usdTotal += p.turnEnd.usdTotal
        p.turnEnd.usdTotal = usdTotal
      }
      s.onParsed(p)
      if (p.turnEnd) {
        void s.emit('turn_ended', { turn, stopReason: p.turnEnd.stopReason })
        if (p.turnEnd.failed && turnFailed === undefined) turnFailed = p.turnEnd.error ?? 'turn failed'
      }
    }
    if (cfg.parseFinal) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8')
      })
    } else {
      const parseLine = (cfg.makeLineParser ?? (() => () => ({ events: [] }) as Parsed))()
      const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
      rl.on('line', (line) => take(parseLine(line)))
    }
    // Only now that stdout is listened to: a process that exits during this await would otherwise have its output
    // flushed and its `close` missed, and the run would wait forever.
    if (steerId && child.pid) await transitionSteer(args.runDir, steerId, 'sent')
    // A `queue` direction, or any direction on a non-interruptible CLI (Gemini), waits for the turn to end; any
    // other direction or a cancel interrupts an interruptible one.
    const collect = async (running: boolean) => {
      for (const m of await takeMail(args.runDir)) {
        if (m.kind === 'cancel' && !running && code === 0 && !turnFailed) {
          // The turn that just ended was the final report: stopping now finishes the run, it does not discard it.
          await s.emit('warning', { code: 'stop_after_report' })
          finishing = true
        } else if (m.kind === 'cancel') {
          s.cancelled = true
          await s.emit('steer', { code: 'stop_requested' })
          if (running) {
            if (cfg.interruptible) {
              try {
                if (child.pid) process.kill(-child.pid, 'SIGTERM')
                else child.kill('SIGTERM')
              } catch {
                child.kill('SIGTERM')
              }
            } else child.kill('SIGTERM')
          }
        } else {
          queue.push({ text: m.text, ...(m.id ? { id: m.id } : {}) })
          await s.emit('steer', m.text.trim().slice(0, 200))
          if (!cfg.interruptible || m.mode === 'queue' || !running) continue
          if (turnReported || session) interrupt()
          else interruptOnSession = true
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
    if (cfg.parseFinal) take(cfg.parseFinal(stdoutBuf))
    // A direction that arrived as the turn ended is still undelivered: it becomes the next turn.
    await collect(false)
    await Promise.all(acknowledgements)
    if (s.cancelled) break
    if (!interrupted && (code !== 0 || turnFailed)) {
      s.failure = turnFailed ?? failureTextOf(stderr.text, `${cfg.fallbackError} ${code}`)
      break
    }
    // Directions left in the queue stay `queued` and are abandoned when the run finishes.
    next = finishing ? undefined : queue.shift()
    // cm1: about to close with a claimed result but a dirty copy — ask once to commit and report again.
    if (next === undefined && args.commitRequired !== false && !commitNudgeSent && looksLikeReport(turnText)) {
      const uncommitted = await uncommittedFiles(args.cwd)
      if (uncommitted) {
        commitNudgeSent = true
        await s.emit('commit_nudge', { uncommitted })
        next = { text: commitNudgeText(uncommitted) }
      }
    }
  }
  return code
}

export async function runCliRun(args: CliRunnerArgs, now: () => Date = () => new Date(), env: NodeJS.ProcessEnv = process.env): Promise<CliRunState> {
  const p = paths(args.runDir)
  await mkdir(p.mailbox, { recursive: true })
  // A direct call or a stale args file must not put an Anthropic model behind an unsupported channel even
  // before any state exists: the resolved route is evaluated here, and a refusal records a typed
  // setup/policy failure (never `auth_expired`, whose advice is a subscription login) without spawning a
  // worker. `driveClaude` checks the environment again immediately before the child exists.
  const route = classifyAnthropicRoute({ backend: CLI_BACKEND[args.kind], model: args.model ?? '', id: '' }, env, args.commandArgs ?? [])
  const refusal = route.applies && !route.allowed ? route : undefined
  const state: CliRunState = {
    status: refusal ? 'failed' : 'running',
    exitCode: refusal ? 1 : null,
    startedAt: now().toISOString(),
    pid: process.pid,
    ...(args.authChannel ? { authChannel: args.authChannel } : {}),
    ...(args.policyRevision ? { policyRevision: args.policyRevision } : {}),
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    ...(refusal ? { error: new AnthropicPolicyError(refusal.code, refusal.vars).message, reason: { code: 'setup_failed' as const }, finishedAt: now().toISOString() } : {}),
  }
  await writeJsonAtomic(p.state, state)
  if (refusal) return state
  let writes: Promise<void> = Promise.resolve()
  const add = (u: TurnUsage) => {
    state.usage.calls += 1
    state.usage.inputTokens += u.input
    state.usage.outputTokens += u.output
    state.usage.cacheReadTokens += u.cacheRead
    if (u.cacheWrite !== undefined) {
      state.usage.cacheWriteTokens += u.cacheWrite
      state.cacheWriteCallsObserved = (state.cacheWriteCallsObserved ?? 0) + 1
    }
    if (u.cacheWritePartial) state.cacheWriteCallsPartial = (state.cacheWriteCallsPartial ?? 0) + 1
    state.cacheWriteCallsTotal = (state.cacheWriteCallsTotal ?? 0) + 1
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
    const turnCli = TURN_CLI_CONFIG[args.kind]
    code = args.kind === 'claude' ? await driveClaude(args, s, prompt, env) : turnCli ? await driveTurnCli(args, s, prompt, turnCli, env) : await driveCodex(args, s, prompt, env)
  } catch (err) {
    s.failure = err instanceof Error ? err.message : String(err)
    // A policy refusal that raced the environment keeps the same typed setup failure, never auth_expired.
    if (err instanceof AnthropicPolicyError) s.reason = { code: 'setup_failed' }
    code = 1
  }
  if (s.failure && !s.cancelled) await s.emit('run_failed', s.failure)
  await writes
  const status: CliRunStatus = s.cancelled ? 'cancelled' : s.failure ? 'failed' : 'completed'
  // A reason the runner knows (a rate limit with its reset) is kept; any other is read from `error` by the backend (fo1).
  Object.assign(state, { status, exitCode: s.cancelled ? 130 : s.failure ? code || 1 : 0, finishedAt: now().toISOString() }, s.failure && !s.cancelled ? { error: s.failure, ...(s.reason ? { reason: s.reason } : {}) } : {})
  await finishSteers(args.runDir, status === 'completed' ? 'run_finished' : status === 'cancelled' ? 'cancelled' : 'run_failed', () => writeJsonAtomic(p.state, state))
  return state
}
