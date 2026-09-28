import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import { type MessageLang, type MessageVars, orchText } from '../orchestration/messages.js'
import { requiredChecks } from '../orchestration/verdict.js'
import { CREWBOARD_DIR, loadPlan } from '../plan/store.js'
import { withSlot } from '../slots/slots.js'
import { outputDir, saveOutput } from '../worktree/output.js'
import { EMPTY_RECIPE, loadRecipe } from '../worktree/recipe.js'

/**
 * One contract check Crewboard ran itself (ck1, B30): the command, how it ended, the last lines and the file with
 * the whole output (tk1). `exitCode` is the shell's; a command stopped by the timeout has `timedOut`.
 */
export type CrewboardCheck = { command: string; exitCode: number; timedOut: boolean; durationMs: number; tail: string; output: string; bytes: number }
/**
 * The checks of a run's contract as Crewboard ran them in the task's copy — a fact of its own next to the worker's
 * claim, kept beside the run's evidence (`checks.json`); a later run of the checks replaces it.
 */
export type CrewboardChecks = {
  version: 1
  runId: string
  by: 'person' | 'orchestrator'
  ranAt: string
  worktree: string
  /** Worktree HEAD when checks ran; used to bind recovered work to the checked commit. */
  commit?: string
  contractPath: string
  contractRevision: string
  timeoutSec: number
  checks: CrewboardCheck[]
}

export const crewboardChecksRef = (runId: string) => `${CREWBOARD_DIR}/runs/${runId}/checks.json`

export class ChecksError extends Error {
  constructor(
    readonly code: 'unknown_task' | 'no_run' | 'running' | 'no_worktree' | 'no_contract' | 'no_checks',
    readonly vars: MessageVars,
  ) {
    super(orchText('en', `checks.${code}`, vars))
    this.name = 'ChecksError'
  }
}

export async function readCrewboardChecks(root: string, runId: string): Promise<CrewboardChecks | undefined> {
  if (!/^run_[a-z0-9-]+$/.test(runId)) return undefined
  try {
    const parsed = JSON.parse(await readFile(join(root, crewboardChecksRef(runId)), 'utf8')) as CrewboardChecks
    return parsed.version === 1 && parsed.runId === runId && Array.isArray(parsed.checks) ? parsed : undefined
  } catch { return undefined }
}

/**
 * Runs the `<checks>` block of the last run's contract in the task's copy (ck1): one command after another, with
 * the recipe's environment and its timeout per command. Only the contract's commands run — nothing from the
 * worker's report. The result goes next to the run's evidence; the verdict is not rewritten, it gains facts.
 */
export async function runContractChecks(opts: {
  root: string
  taskId: string
  planId?: string
  by: 'person' | 'orchestrator'
  exec: Exec
  env?: NodeJS.ProcessEnv
  now?: () => Date
  lang?: MessageLang
  /** Called before each command starts: the CLI says what runs while it runs. */
  onStart?: (command: string, index: number, total: number) => void
  /** Called once per command that has to wait for a machine-wide slot (ql1), with how many hold one. */
  onSlotWaiting?: (ahead: number) => void
}): Promise<CrewboardChecks> {
  const now = opts.now ?? (() => new Date())
  const id = opts.taskId
  const plan = await loadPlan(opts.root, opts.planId)
  const task = plan.tasks.find((item) => item.id === id)
  if (!task) throw new ChecksError('unknown_task', { id })
  const run = task.runs.at(-1)
  if (run && !run.finishedAt) throw new ChecksError('running', { id })
  if (!run?.evidence) throw new ChecksError('no_run', { id })
  const wt = task.worktree?.path
  if (plan.example || !wt || !(await stat(wt).catch(() => undefined))?.isDirectory()) throw new ChecksError('no_worktree', { id })
  const contractPath = run.contractPath ?? task.contract
  const abs = contractPath ? resolve(opts.root, contractPath) : undefined
  const rel = abs ? relative(opts.root, abs) : ''
  const contract = abs && rel && !rel.startsWith('..') && !isAbsolute(rel) ? await readFile(abs, 'utf8').catch(() => undefined) : undefined
  if (!contractPath || contract === undefined) throw new ChecksError('no_contract', { id })
  const commands = requiredChecks(contract)
  if (!commands.length) throw new ChecksError('no_checks', { id, path: contractPath })

  const recipe = (await loadRecipe(opts.root).catch(() => null)) ?? EMPTY_RECIPE
  const rawEnv = opts.env ?? process.env
  const env = { ...rawEnv }
  for (const key of recipe.env.unset) delete env[key]
  const home = rawEnv.HOME ?? homedir()
  const dir = outputDir(opts.root, id)
  const checks: CrewboardCheck[] = []
  const headBefore = await opts.exec('git', ['-C', wt, 'rev-parse', 'HEAD'])
  for (const [i, command] of commands.entries()) {
    opts.onStart?.(command, i, commands.length)
    const started = Date.now()
    // A heavy check takes a machine-wide slot (ql1), like the baseline: this and other checks, baselines
    // and workers running long commands on the same machine take turns instead of all starting at once.
    const r = await withSlot({ env: rawEnv, home, onWaiting: opts.onSlotWaiting }, () => opts.exec('/bin/sh', ['-c', command], { cwd: wt, env, timeoutMs: recipe.timeoutSec * 1000 }))
    const durationMs = Date.now() - started
    const note = r.timedOut ? `\n${orchText(opts.lang, 'prepare.timeout', { seconds: recipe.timeoutSec })}` : ''
    // Each file gets its own name: several checks can finish within one millisecond.
    const saved = await saveOutput(dir, `check-${i + 1}`, `$ ${command}\n${r.stdout}${r.stderr}${note}`, now())
    checks.push({ command, exitCode: r.code, timedOut: r.timedOut, durationMs, tail: saved.tail, output: saved.path, bytes: saved.bytes })
  }
  const head = await opts.exec('git', ['-C', wt, 'rev-parse', 'HEAD'])
  const record: CrewboardChecks = {
    version: 1, runId: run.runId, by: opts.by, ranAt: now().toISOString(), worktree: wt, contractPath,
    contractRevision: createHash('sha256').update(contract).digest('hex'), timeoutSec: recipe.timeoutSec, checks,
    ...(headBefore.code === 0 && head.code === 0 && headBefore.stdout.trim() === head.stdout.trim() && head.stdout.trim() ? { commit: head.stdout.trim() } : {}),
  }
  const file = join(opts.root, crewboardChecksRef(run.runId))
  await mkdir(join(opts.root, CREWBOARD_DIR, 'runs', run.runId), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`)
    await rename(tmp, file)
  } finally { await rm(tmp, { force: true }) }
  return record
}
