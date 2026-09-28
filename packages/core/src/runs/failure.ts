/**
 * Why an attempt failed, as a code the screen and the CLI say in the reader's language (fo1, B20). The worker's
 * own text rides along as `text`; the code decides what the person is offered next. Browser-safe: the client
 * bundle imports it directly.
 *
 * - `rate_limited` — the worker's account hit its usage limit; `resetsAt` when the worker named it.
 * - `auth_expired` — not logged in, or the token expired; `login` is the command that fixes it.
 * - `interrupted` — the run's supervisor (or the machine) stopped before the run finished.
 * - `disk_full` — no space left on the device.
 * - `setup_failed` — preparing the worktree (the recipe's setup) failed; no worker started.
 * - `baseline_red` — the baseline run was red; the task was not sent to a worker.
 * - `worker_error` — anything else.
 */
export const FAILURE_CODES = ['rate_limited', 'auth_expired', 'interrupted', 'disk_full', 'setup_failed', 'baseline_red', 'worker_error'] as const
export type FailureCode = (typeof FAILURE_CODES)[number]

export type FailureReason =
  | { code: 'rate_limited'; resetsAt?: string }
  | { code: 'auth_expired'; login?: string }
  | { code: 'interrupted'; workerPid?: number; workerStopped?: boolean }
  | { code: 'disk_full' }
  | { code: 'setup_failed'; step?: string; log?: string }
  | { code: 'baseline_red'; step?: string; log?: string }
  | { code: 'worker_error' }

/** The worker families whose failures are told apart; anything else reads like `dsh`. */
export type FailureBackend = 'claude' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'grok' | 'devin' | 'dsh'

const AGENT_PREFIX: readonly Exclude<FailureBackend, 'devin' | 'dsh'>[] = ['claude', 'codex', 'opencode', 'cursor', 'gemini', 'grok']

export const failureBackendOf = (agent: string): FailureBackend =>
  AGENT_PREFIX.find((backend) => agent.startsWith(backend)) ?? (agent === 'devin' || agent.startsWith('devin/') ? 'devin' : 'dsh')

/** The command that logs the worker in again; dsh keeps its keys in its own settings, so it has none. */
export function loginCommand(backend: FailureBackend): string | undefined {
  if (backend === 'claude') return 'claude auth login'
  if (backend === 'codex') return 'codex login'
  if (backend === 'opencode') return 'opencode auth login'
  if (backend === 'cursor') return 'cursor-agent login'
  // Gemini CLI has no login subcommand upstream — signing in happens inside `gemini` (or via GEMINI_API_KEY).
  if (backend === 'gemini') return 'gemini'
  if (backend === 'grok') return 'grok login'
  if (backend === 'devin') return 'devin auth login'
  return undefined
}

const MAX_TEXT = 300
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)

/** `Error: …`, `TypeError: …`, `error[E0433]: …`, `fatal: …`, or a log line at level ERROR. */
const ERROR_LINE = /^(?:[A-Za-z_.]*Error|error|fatal)(?:\[[^\]]*\])?:\s*\S|\bERROR\b/

/**
 * The worker's own `Error:` line — the last one, since a process says what killed it last — instead of the first
 * bytes of its stderr, which are usually a banner or a warning. Absent when no line looks like an error.
 */
export function errorLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i] ?? '')) return clip(lines[i] ?? '')
  return undefined
}

/** What a failed process leaves as its failure text: its `Error:` line, else its last line, else the exit code. */
export function failureTextOf(stderr: string, fallback: string): string {
  const last = stderr.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  return errorLine(stderr) ?? (last ? clip(last) : fallback)
}

const RATE_LIMITED = /usage limit|limit reached|hit your (?:usage )?limit|rate[ _-]?limit|too many requests|(?:status(?: code)?:?|http|error:?) 429\b|quota exceeded|exceeded your current quota/i
const AUTH_EXPIRED = /not logged in|log ?in required|please (?:run \/?login|log ?in|sign in)|\b(?:auth(?:entication)?_error|authentication fails?|authentication failed)\b|invalid (?:api key|x-api-key|bearer token)|(?:oauth |access |refresh )?token (?:has )?(?:expired|could not be refreshed|is invalid)|(?:status(?: code)?:?|http|error:?) 401\b|unauthori[sz]ed|\boauth\b|session (?:has )?expired|credentials? (?:expired|invalid|missing|not found)|auth login|codex login/i
const DISK_FULL = /ENOSPC|no space left on device|disk (?:is )?full/i
const INTERRUPTED = /supervisor (?:exited|stopped)|run's supervisor|stopped by SIG[A-Z]+/i

/**
 * Claude Code's older usage-limit answer ends with the reset time as Unix seconds: «Claude AI usage limit
 * reached|1759496400». Other workers name the time in words, which is left in `text`.
 */
function resetOf(text: string): string | undefined {
  const match = /limit reached\|(\d{9,11})\b/i.exec(text)
  if (!match) return undefined
  const at = new Date(Number(match[1]) * 1000)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/**
 * The reason behind a failure text, from what each worker reports (Claude's `result`, Codex's `turn.failed`,
 * Devin's ACP and login check, dsh's runner). Disk and limit first: an out-of-space error often mentions a file
 * that failed to authenticate nothing, and a limit message may mention the account.
 */
export function classifyFailure(backend: FailureBackend, text: string): FailureReason {
  if (DISK_FULL.test(text)) return { code: 'disk_full' }
  if (RATE_LIMITED.test(text)) {
    const resetsAt = resetOf(text)
    return { code: 'rate_limited', ...(resetsAt ? { resetsAt } : {}) }
  }
  if (AUTH_EXPIRED.test(text)) {
    const login = loginCommand(backend)
    return { code: 'auth_expired', ...(login ? { login } : {}) }
  }
  if (INTERRUPTED.test(text)) return { code: 'interrupted' }
  return { code: 'worker_error' }
}

/**
 * A failure as stored on a run in plan.json (`run.failure`): the code with its few parameters, and the text.
 * Flat and optional, so a build that does not know it keeps it as an unknown key.
 */
export type StoredFailure = { reason: FailureCode; text?: string; resetsAt?: string; login?: string; step?: string; log?: string }

export function storeFailure(reason: FailureReason, text?: string): StoredFailure {
  return {
    reason: reason.code,
    ...(text ? { text: clip(text) } : {}),
    ...(reason.code === 'rate_limited' && reason.resetsAt ? { resetsAt: reason.resetsAt } : {}),
    ...(reason.code === 'auth_expired' && reason.login ? { login: reason.login } : {}),
    ...((reason.code === 'setup_failed' || reason.code === 'baseline_red') && reason.step ? { step: reason.step } : {}),
    ...((reason.code === 'setup_failed' || reason.code === 'baseline_red') && reason.log ? { log: reason.log } : {}),
  }
}

export function reasonOfStored(stored: StoredFailure): FailureReason {
  switch (stored.reason) {
    case 'rate_limited': return { code: 'rate_limited', ...(stored.resetsAt ? { resetsAt: stored.resetsAt } : {}) }
    case 'auth_expired': return { code: 'auth_expired', ...(stored.login ? { login: stored.login } : {}) }
    case 'setup_failed':
    case 'baseline_red': return { code: stored.reason, ...(stored.step ? { step: stored.step } : {}), ...(stored.log ? { log: stored.log } : {}) }
    case 'interrupted':
    case 'disk_full':
    case 'worker_error': return { code: stored.reason }
  }
}

/**
 * The one move a failed or unfinished attempt offers (fo1): try again, log in first, look at the saved output,
 * continue the unfinished work, or stop a run that went quiet. The screen and the CLI show the same move.
 */
export type AttemptAction = 'retry' | 'login' | 'show_output' | 'continue' | 'stop'

export function attemptAction(outcome: 'failed' | 'cancelled' | 'incomplete', reason?: FailureReason): AttemptAction {
  if (outcome === 'incomplete') return 'continue'
  if (outcome === 'cancelled' || !reason) return 'retry'
  if (reason.code === 'auth_expired') return 'login'
  if (reason.code === 'setup_failed' || reason.code === 'baseline_red') return 'show_output'
  return 'retry'
}

/**
 * The failure a backend reports for a finished run, from its state file: the reason its runner recorded, else an
 * interrupted supervisor, else one read from the error text. Runs written by older builds carry only the text.
 */
export function stateFailure(backend: FailureBackend, state: { status: string; error?: string; reason?: FailureReason; interrupted?: unknown }): StoredFailure | undefined {
  if (state.status !== 'failed') return undefined
  const reason: FailureReason = state.reason ?? (state.interrupted ? { code: 'interrupted' } : classifyFailure(backend, state.error ?? ''))
  return storeFailure(reason, state.error)
}
