import { parseArgs } from 'node:util'
import {
  CheckError,
  type Exec,
  callerOf,
  currentPlanId,
  finishCheck,
  resolveOrchestratorCheck,
  returnFromCheck,
  setPlanOrchestratorCheck,
  setRepositoryOrchestratorCheck,
  takeCheck,
} from '@crewboard/core'
import { cliT } from '../i18n.js'
import { homeOf, makeBackends, repoRoot } from '../context.js'
import { type Io, UserError, confirmHuman } from '../io.js'

/**
 * `orch verify`: the orchestrator's check between «worker finished» and «waiting for you» (vr1). Agents may
 * take, finish and return a check; only the setting that turns checks off asks a person.
 */
export async function cmdVerify(argv: string[], io: Io, exec: Exec): Promise<number> {
  const lang = io.lang ?? 'en'
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { done: { type: 'boolean' }, note: { type: 'string' }, return: { type: 'string' }, setting: { type: 'string' }, 'skip-preflight': { type: 'boolean' }, scope: { type: 'string' }, plan: { type: 'string' } } })
  const root = await repoRoot(io, exec)
  if (values.setting !== undefined) return setting(root, values.setting, values.scope, values.plan, io)
  const [id] = positionals
  if (!id || (values.done && values.return !== undefined) || (values.done && !values.note?.trim()) || (!values.done && values.note !== undefined) || (values.return !== undefined && !values.return.trim())) throw new UserError(cliT(lang, 'verify.usage'), 2)
  const by = callerOf({ kind: 'cli', isTTY: io.isTTY }) === 'person' ? 'person' : 'orchestrator'
  try {
    if (values.return !== undefined) {
      const launched = await returnFromCheck({ root, taskId: id, planId: values.plan, findings: values.return, by, skipPreflight: values['skip-preflight'], caller: callerOf({ kind: 'cli', isTTY: io.isTTY }), backends: makeBackends(io, exec, root), exec, env: io.env, home: homeOf(io), now: () => io.now(), lang })
      io.out(cliT(lang, 'verify.returned', { id, runId: launched.runId }))
      return 0
    }
    if (values.done) {
      await finishCheck(root, id, values.note as string, io.now(), { planId: values.plan, by })
      io.out(cliT(lang, 'verify.checked', { id }))
      return 0
    }
    await takeCheck(root, id, io.now(), { planId: values.plan, by })
    io.out(cliT(lang, 'verify.taken', { id }))
    return 0
  } catch (err) {
    if (err instanceof CheckError) throw new UserError(cliT(lang, `verify.error.${err.code}`, { id }), err.code === 'no_note' ? 2 : 1)
    throw err
  }
}

async function setting(root: string, value: string, scope: string | undefined, planId: string | undefined, io: Io): Promise<number> {
  const lang = io.lang ?? 'en'
  if (!['on', 'off', 'default'].includes(value) || (scope !== undefined && scope !== 'repo' && scope !== 'plan')) throw new UserError(cliT(lang, 'verify.usage'), 2)
  // Turning checks off lets finished work reach the person unchecked: a person decides that.
  if (value === 'off' && !(await confirmHuman(io, cliT(lang, 'verify.offQuestion')))) {
    io.out(`${cliT(lang, 'plan.cancelled')}\n`)
    return 1
  }
  const next = value === 'default' ? undefined : value === 'on'
  const plan = planId ?? currentPlanId(root)
  if (scope === 'repo') await setRepositoryOrchestratorCheck(root, next)
  else await setPlanOrchestratorCheck(root, plan, next)
  const effective = await resolveOrchestratorCheck(root, plan)
  io.out(cliT(lang, effective.enabled ? 'verify.settingOn' : 'verify.settingOff', { source: cliT(lang, `verify.source.${effective.source}`) }))
  return 0
}
