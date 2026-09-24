import { basename } from 'node:path'
import {
  AcpError,
  BackendUnavailableError,
  CheckError,
  DetailError,
  DraftError,
  DraftJobError,
  ExamplePlanError,
  ExampleRunError,
  FilePreviewError,
  isSchemaError,
  LEGACY_PLAN_ID,
  LegacyRunReadOnlyError,
  type Exec,
  LaunchError,
  PlanConflictError,
  PlanCorruptError,
  PlanArchivedError,
  PlanIncompatibleError,
  PlanIdError,
  PlanInvalidError,
  PlanNotFoundError,
  PrepareError,
  PresetAuthorityError,
  ProfileError,
  SpecUploadError,
  nodeExec,
  orchText,
  planIds,
  plansDir,
} from '@crewboard/core'
import { cmdPreflight, cmdWorktree } from './commands/env.js'
import { cmdAccept, cmdChat, cmdInit, cmdPlan, cmdReject, cmdStatus, cmdSupersede, cmdDrop, cmdTask, cmdWorkers } from './commands/plan.js'
import { cmdAttention } from './commands/attention.js'
import { cmdContinue, cmdCost, cmdEvents, cmdRun, cmdSteer, cmdStop, cmdWait } from './commands/runs.js'
import { cmdTrace } from './commands/trace.js'
import { cmdStart, cmdVerify } from './commands/verify.js'
import { cmdPresets, cmdRepo } from './commands/presets.js'
import { warnIfOffScreen } from './commands/repos.js'
import { repoRoot } from './context.js'
import { help } from './help.js'
import { type Io, UserError } from './io.js'
import { cliT, envLang, programName, setProgram } from './i18n.js'

type Command = (argv: string[], io: Io, exec: Exec) => Promise<number>

const COMMANDS: Record<string, Command> = {
  init: cmdInit,
  plan: cmdPlan,
  chat: cmdChat,
  workers: cmdWorkers,
  presets: cmdPresets,
  repo: cmdRepo,
  status: cmdStatus,
  wait: cmdWait,
  task: cmdTask,
  accept: cmdAccept,
  reject: cmdReject,
  supersede: cmdSupersede,
  drop: cmdDrop,
  verify: cmdVerify,
  start: cmdStart,
  run: cmdRun,
  events: cmdEvents,
  trace: cmdTrace,
  steer: cmdSteer,
  continue: cmdContinue,
  stop: cmdStop,
  attention: cmdAttention,
  cost: cmdCost,
  preflight: cmdPreflight,
  worktree: cmdWorktree,
}

/**
 * Every error class the CLI knows prints one line (or one message with its detail) and its exit code; only
 * an unexpected error prints a stack. A refusal carrying its vars is rendered again in the CLI's language.
 */
function describeError(err: unknown, lang: 'en' | 'ru'): { message: string; code: number } {
  const again = (key: string, vars: Record<string, string | number>) => orchText(lang, key, { ...vars, prog: programName() })
  if (err instanceof TypeError && err.message.startsWith('Unknown preset: ')) return { message: cliT(lang, 'presets.unknown', { id: err.message.slice('Unknown preset: '.length) }), code: 1 }
  if (err instanceof UserError) return { message: err.message, code: err.code }
  if (err instanceof PlanIdError) return { message: err.message, code: 1 }
  // An agent asking for a worker outside the preset is a refused request, like a usage error: exit 2.
  if (err instanceof LaunchError) {
    const message = err.vars ? again(err.code, err.vars) : err.message
    return { message: err.detail ? `${err.detail}\n${message}` : message, code: err.code === 'outside_preset' ? 2 : 1 }
  }
  if (err instanceof PresetAuthorityError) return { message: err.message, code: 2 }
  if (err instanceof DetailError) return { message: again(err.code, err.vars), code: 1 }
  if (err instanceof DraftError || err instanceof DraftJobError) return { message: cliT(lang, `draft.error.${err.reason}`, { id: err.id }), code: 1 }
  if (err instanceof BackendUnavailableError) return { message: cliT(lang, 'cli.backendUnavailable', { error: err.message }), code: 1 }
  if (err instanceof LegacyRunReadOnlyError) return { message: cliT(lang, 'cli.legacyReadOnly'), code: 1 }
  if (err instanceof ProfileError) return { message: err.message, code: 1 }
  if (err instanceof PlanIncompatibleError) return { message: cliT(lang, `cli.planIncompatible.${err.mode}`, { file: err.file, details: err.details.slice(0, 3).join(', ') }), code: 1 }
  if (err instanceof PlanArchivedError) return { message: cliT(lang, 'cli.planArchived', { id: err.planId }), code: 1 }
  if (err instanceof PlanCorruptError || err instanceof PlanInvalidError) return { message: err.message, code: 1 }
  if (err instanceof PlanConflictError) return { message: cliT(lang, 'cli.conflict'), code: 1 }
  if (err instanceof CheckError || err instanceof PrepareError || err instanceof ExamplePlanError || err instanceof ExampleRunError || err instanceof SpecUploadError || err instanceof FilePreviewError || err instanceof AcpError) return { message: err.message, code: 1 }
  if (isSchemaError(err)) return { message: cliT(lang, 'cli.invalidPlan', { error: err.message }), code: 1 }
  // node:util parseArgs throws TypeErrors with ERR_PARSE_ARGS_* codes: a usage mistake, not a crash.
  if (err instanceof TypeError && (String((err as NodeJS.ErrnoException).code ?? '').startsWith('ERR_PARSE_ARGS') || /parseArgs|Unknown option/i.test(err.message))) return { message: err.message, code: 2 }
  return { message: err instanceof Error ? (err.stack ?? err.message) : String(err), code: 1 }
}

/** A missing plan id means something else than an empty repository: name it and list what exists. */
async function describeMissingPlan(err: PlanNotFoundError, io: Io, exec: Exec, lang: 'en' | 'ru'): Promise<{ message: string; code: number }> {
  try {
    const root = await repoRoot(io, exec)
    const ids = await planIds(root)
    if (ids.length > 0) {
      const requested = err.file.startsWith(`${plansDir(root)}/`) ? basename(err.file, '.json') : LEGACY_PLAN_ID
      return { message: cliT(lang, 'cli.planUnknown', { id: requested, list: ids.join(', ') }), code: 1 }
    }
  } catch {
    /* Not a repository or the plan store is unreadable — the bare init hint still applies. */
  }
  return { message: cliT(lang, 'cli.noPlan'), code: 1 }
}

export async function run(argv: string[], io: Io, exec: Exec = nodeExec): Promise<number> {
  setProgram(io.program ?? 'crewboard')
  let lang = envLang(io.env)
  const args = [...argv]
  for (let i = 0; i < args.length; i++) if (args[i] === '--lang') {
    const selected = args[i + 1]
    if (selected !== 'ru' && selected !== 'en') { io.err(`${cliT(lang, 'cli.lang')}\n`); return 2 }
    lang = selected
    args.splice(i, 2); i--
  }
  io.lang = lang
  const [name, ...rest] = args
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    io.out(help(lang))
    return 0
  }
  const command = COMMANDS[name]
  if (!command) {
    io.err(`${cliT(lang, 'cli.unknown', { name })}\n\n${help(lang)}`)
    return 2
  }
  let code: number
  try {
    code = await command(rest, io, exec)
  } catch (err) {
    const described = err instanceof PlanNotFoundError ? await describeMissingPlan(err, io, exec, lang) : describeError(err, lang)
    io.err(`${name === 'run' ? runRefusal(err, described.message, rest[0], lang) : described.message}\n`)
    code = described.code
  }
  // Once per command, after its own output: the plan it worked on is in a place the screen does not show.
  if (!OFF_PLAN_COMMANDS.has(name)) await warnIfOffScreen(io, exec)
  return code
}

/**
 * A refused `run` ends with one line that says the task was not started and why. The reason used to come
 * first and a red baseline's test output after it, so `crewboard run t | tail -1` showed a blank line and
 * the orchestrator took the refusal for a silent exit (sy1 and bg1, 2026-09-24).
 */
function runRefusal(err: unknown, message: string, id: string | undefined, lang: 'en' | 'ru'): string {
  const text = message.trimEnd()
  const lines = text.split('\n')
  if (!id || lines.length < 2) return text
  // A launch refusal's own sentence (after any preflight detail); otherwise the message's first line.
  const reason = err instanceof LaunchError && err.detail && text.startsWith(err.detail) ? (text.slice(err.detail.length).trim().split('\n')[0] ?? '') : (lines[0] ?? '')
  if (lines.at(-1) === reason) return text
  return `${text}\n${cliT(lang, 'runs.notStarted', { id, reason })}`
}

/** Commands that do not work on a plan: they never carry the «not on screen» warning. */
const OFF_PLAN_COMMANDS = new Set(['repo', 'presets', 'workers', 'preflight'])
