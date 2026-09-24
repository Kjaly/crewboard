import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CheckError,
  type Exec,
  callerOf,
  type DoneFacts,
  currentPlanId,
  doneFacts,
  finishCheck,
  startOwnWork,
  resolveOrchestratorCheck,
  returnFromCheck,
  setPlanOrchestratorCheck,
  setRepositoryOrchestratorCheck,
  takeCheck,
} from '@crewboard/core'
import { cliT } from '../i18n.js'
import { homeOf, makeBackends, repoRoot } from '../context.js'
import { type Io, UserError, confirmHuman } from '../io.js'

const checkError = (err: unknown, lang: 'en' | 'ru', id: string): unknown =>
  err instanceof CheckError ? new UserError(cliT(lang, `verify.error.${err.code}`, { id }), err.code === 'no_note' ? 2 : 1) : err

/** `orch start <id>`: the orchestrator takes a root task — its own work — in work (rt1). */
export async function cmdStart(argv: string[], io: Io, exec: Exec): Promise<number> {
  const lang = io.lang ?? 'en'
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { plan: { type: 'string' } } })
  const [id] = positionals
  if (!id || positionals.length > 1) throw new UserError(cliT(lang, 'start.usage'), 2)
  const root = await repoRoot(io, exec)
  const by = callerOf({ kind: 'cli', isTTY: io.isTTY }) === 'person' ? 'person' : 'orchestrator'
  try {
    await startOwnWork(root, id, io.now(), { planId: values.plan, by })
  } catch (err) {
    throw checkError(err, lang, id)
  }
  io.out(cliT(lang, 'start.started', { id }))
  return 0
}

/** «Verdict: disputed — a result was claimed, but no files changed · 0 files changed» (B10). */
function verdictLine(lang: 'en' | 'ru', facts: DoneFacts): string {
  const reason = facts.verdict.why ?? facts.verdict.mismatch
  return cliT(lang, 'verify.verdict', {
    kind: cliT(lang, `verify.verdict.${facts.verdict.kind}`),
    reason: reason ? ` — ${cliT(lang, `verify.reason.${reason}`)}` : '',
    files: cliT(lang, 'verify.files', { count: facts.files }),
  })
}

/**
 * `orch verify`: the orchestrator's check between «worker finished» and «waiting for you» (vr1). Agents may
 * take, finish and return a check; only the setting that turns checks off asks a person. On a root task or
 * a decision (rt1) `--done` is the orchestrator's «done», with an optional `--report` markdown file.
 */
export async function cmdVerify(argv: string[], io: Io, exec: Exec): Promise<number> {
  const lang = io.lang ?? 'en'
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { done: { type: 'boolean' }, note: { type: 'string' }, report: { type: 'string' }, return: { type: 'string' }, reopen: { type: 'boolean' }, confirm: { type: 'boolean' }, setting: { type: 'string' }, 'skip-preflight': { type: 'boolean' }, scope: { type: 'string' }, plan: { type: 'string' } } })
  const root = await repoRoot(io, exec)
  if (values.setting !== undefined) return setting(root, values.setting, values.scope, values.plan, io)
  const [id] = positionals
  if (!id || (values.done && values.return !== undefined) || (values.done && !values.note?.trim()) || (!values.done && values.note !== undefined) || (!values.done && values.report !== undefined) || (values.return !== undefined && !values.return.trim()) || (values.reopen && (values.done || values.return !== undefined)) || (values.confirm && !values.done)) throw new UserError(cliT(lang, 'verify.usage'), 2)
  const by = callerOf({ kind: 'cli', isTTY: io.isTTY }) === 'person' ? 'person' : 'orchestrator'
  let report: string | undefined
  if (values.report !== undefined) {
    // Relative to where the command runs, like any file argument.
    const file = resolve(io.cwd, values.report)
    try { report = await readFile(file, 'utf8') } catch { throw new UserError(cliT(lang, 'verify.error.report_unreadable', { file }), 1) }
  }
  try {
    if (values.return !== undefined) {
      const launched = await returnFromCheck({ root, taskId: id, planId: values.plan, findings: values.return, by, skipPreflight: values['skip-preflight'], caller: callerOf({ kind: 'cli', isTTY: io.isTTY }), backends: makeBackends(io, exec, root), exec, env: io.env, home: homeOf(io), now: () => io.now(), lang })
      io.out(cliT(lang, 'verify.returned', { id, runId: launched.runId }))
      return 0
    }
    if (values.done) {
      // The verdict the person will see, before the work goes to them (B10); disputed or empty work needs a yes.
      const facts = await doneFacts(root, id, makeBackends(io, exec, root), exec, values.plan)
      if (facts) io.out(verdictLine(lang, facts))
      if (facts?.needsConfirm && !values.confirm) {
        if (!io.isTTY) throw new UserError(cliT(lang, 'verify.error.unconfirmed', { id }), 1)
        if (!(await confirmHuman(io, cliT(lang, 'verify.confirmQuestion', { id })))) return 1
      }
      const task = await finishCheck(root, id, values.note as string, io.now(), { planId: values.plan, by, ...(report !== undefined ? { report } : {}) })
      io.out(cliT(lang, task.kind === 'root' ? 'verify.ownDone' : task.kind === 'decision' ? 'verify.prepared' : 'verify.checked', { id }))
      return 0
    }
    const task = await takeCheck(root, id, io.now(), { planId: values.plan, by, reopen: values.reopen })
    // A take on checked work changes nothing (B10): it stays with the person until --reopen.
    if (task.check?.state === 'checked') io.out(cliT(lang, 'verify.alreadyChecked', { id, note: task.check.note ?? '' }))
    else io.out(cliT(lang, values.reopen ? 'verify.reopened' : 'verify.taken', { id }))
    return 0
  } catch (err) {
    throw checkError(err, lang, id)
  }
}

async function setting(root: string, value: string, scope: string | undefined, planId: string | undefined, io: Io): Promise<number> {
  const lang = io.lang ?? 'en'
  if (!['on', 'off', 'default'].includes(value) || (scope !== undefined && scope !== 'repo' && scope !== 'plan')) throw new UserError(cliT(lang, 'verify.usage'), 2)
  // Turning checks off lets finished work reach the person unchecked: a person decides that.
  if (value === 'off' && !(await confirmHuman(io, cliT(lang, 'verify.offQuestion')))) return 1
  const next = value === 'default' ? undefined : value === 'on'
  const plan = planId ?? currentPlanId(root)
  if (scope === 'repo') await setRepositoryOrchestratorCheck(root, next)
  else await setPlanOrchestratorCheck(root, plan, next)
  const effective = await resolveOrchestratorCheck(root, plan)
  io.out(cliT(lang, effective.enabled ? 'verify.settingOn' : 'verify.settingOff', { source: cliT(lang, `verify.source.${effective.source}`) }))
  return 0
}
