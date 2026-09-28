import { parseArgs } from 'node:util'
import { type Exec, type MergeStrategy, type TaskConflict, MergeError, assertAutomaticMerge, checkMarkMerged, checkMerge, listPaths, loadPlan, markMerged, mergeTask, orchText, worktreeConfigPath } from '@crewboard/core'
import { homeOf, repoRoot } from '../context.js'
import { cliT, type Lang, programName } from '../i18n.js'
import { type Io, UserError, confirmHuman } from '../io.js'

/**
 * `merge <id> [--squash|--no-ff] [--yes] [--auto] [--into branch] [--json]` (mg1):
 * a person confirms, or an agent merges accepted work checked on the latest completed run.
 * Every merge checks the branch, clean copies and conflicts before changing Git.
 */
export async function cmdMerge(argv: string[], io: Io, exec: Exec): Promise<number> {
  const lang = io.lang ?? 'en'
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { squash: { type: 'boolean' }, 'no-ff': { type: 'boolean' }, yes: { type: 'boolean' }, auto: { type: 'boolean' }, into: { type: 'string' }, json: { type: 'boolean' }, plan: { type: 'string' } } })
  const [id] = positionals
  if (!id) throw new UserError(cliT(lang, 'merge.usage'), 2)
  if (values.squash && values['no-ff']) throw new UserError(cliT(lang, 'merge.both'), 2)
  const strategy: MergeStrategy = values.squash ? 'squash' : 'no-ff'
  const refuse = (err: unknown): number => {
    if (!(err instanceof MergeError)) throw err
    const message = orchText(lang, `merge.${err.code}`, { ...err.vars, prog: programName() })
    if (values.json) io.out(`${JSON.stringify({ ok: false, error: err.code, message, ...(err.paths ? { paths: err.paths } : {}) }, null, 2)}\n`)
    else io.err(`${message}\n`)
    return 1
  }
  // An accepted task already has a human decision. Automation may perform the mechanical merge only
  // when that decision followed an orchestrator check of this exact completed run.
  if (!io.isTTY && !values.auto) throw new UserError(cliT(lang, 'io.humanOnly'))
  const root = await repoRoot(io, exec)
  if (values.auto) {
    try { await assertAutomaticMerge(root, await loadPlan(root, values.plan), id, exec) } catch (err) { throw new UserError((err as Error).message) }
  }
  let ready: Awaited<ReturnType<typeof checkMerge>>
  try {
    ready = await checkMerge(root, id, { exec, planId: values.plan, now: io.now(), into: values.into })
  } catch (err) {
    return refuse(err)
  }
  if (!values.auto && !values.yes && !(await confirmHuman(io, cliT(lang, 'merge.question', { id, branch: ready.branch, into: ready.into, root, how: cliT(lang, `merge.how.${strategy}`) })))) return 1
  try {
    const result = await mergeTask(root, id, { exec, now: io.now, strategy, planId: values.plan, policyPath: worktreeConfigPath(io.env, homeOf(io)), into: values.into })
    if (values.json) {
      io.out(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
      return 0
    }
    io.out(cliT(lang, 'merge.done', { id, into: result.into, commit: result.commit.slice(0, 12) }))
    io.out(cliT(lang, `merge.copy.${result.copy}`, { reason: result.keptBecause ?? '' }))
    return 0
  } catch (err) {
    return refuse(err)
  }
}

/**
 * `mark-merged <id> --reason "…"` (mk1): a person records accepted work as merged when it reached the base in a way
 * Crewboard cannot see — carried by hand and edited again later, merged in another clone. Nothing in git changes;
 * a detached HEAD is fine. Human only, with a confirmation: without a terminal the command is refused.
 */
export async function cmdMarkMerged(argv: string[], io: Io, exec: Exec): Promise<number> {
  const lang = io.lang ?? 'en'
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { reason: { type: 'string' }, plan: { type: 'string' } } })
  const [id] = positionals
  const reason = values.reason?.trim()
  if (!id || !reason) throw new UserError(cliT(lang, 'markMerged.usage'), 2)
  // An agent is refused before anything is read.
  if (!io.isTTY) throw new UserError(cliT(lang, 'io.humanOnly'))
  const root = await repoRoot(io, exec)
  const ready = await checkMarkMerged(root, id, { exec, planId: values.plan })
  if (!(await confirmHuman(io, cliT(lang, 'markMerged.question', { id, branch: ready.branch, into: ready.into, root, reason })))) return 1
  await markMerged(root, id, reason, { exec, now: io.now(), planId: values.plan })
  io.out(cliT(lang, 'markMerged.done', { id, into: ready.into }))
  return 0
}

/** «conflicts with main in src/a.ts» / «conflicts with task b in src/a.ts». */
export function conflictLine(lang: Lang, conflict: TaskConflict): string {
  return conflict.with === 'base'
    ? cliT(lang, 'status.conflictsBase', { into: conflict.into, paths: listPaths(conflict.paths, 3) })
    : cliT(lang, 'status.conflictsTask', { id: conflict.taskId, paths: listPaths(conflict.paths, 3) })
}

/** The ready Send back text: bring the branch up to date with its base, naming what conflicts. */
export function sendBackText(lang: Lang, conflicts: readonly TaskConflict[], fallbackBase: string): string {
  const into = conflicts.find((c) => c.into)?.into ?? fallbackBase
  const list = conflicts.map((c) => c.with === 'base'
    ? cliT(lang, 'conflicts.itBase', { into: c.into, paths: listPaths(c.paths, 3) })
    : cliT(lang, 'conflicts.itTask', { id: c.taskId, paths: listPaths(c.paths, 3) })).join('; ')
  return cliT(lang, 'conflicts.sendBack', { into, list })
}
