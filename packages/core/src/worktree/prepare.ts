import { cp, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import { type MessageLang, orchText } from '../orchestration/messages.js'
import type { Recipe } from './recipe.js'
import { type BaselineRecord, type WorktreeState, baselineIsCurrent, readWorktreeState, writeWorktreeState } from './state.js'

export type StepResult = { step: string; ok: boolean; durationMs: number; output: string }
/**
 * `baseline` is present when the baseline ran in this call; `record` is the copy's latest baseline,
 * fresh or the green one a reuse relied on.
 */
export type PrepareResult = { path: string; branch: string; reused: boolean; steps: StepResult[]; baseline?: StepResult; record?: BaselineRecord }

export class PrepareError extends Error {
  constructor(
    message: string,
    readonly result: PrepareResult,
  ) {
    super(message)
    this.name = 'PrepareError'
  }
}

/** At most this many paths are named in a refusal; the rest are counted. */
const SHOWN_PATHS = 5

function listPaths(lang: MessageLang | undefined, paths: string[]): string {
  const shown = paths.slice(0, SHOWN_PATHS).join(', ')
  return paths.length > SHOWN_PATHS ? orchText(lang, 'refresh.more', { paths: shown, count: paths.length - SHOWN_PATHS }) : shown
}

/**
 * `git status --porcelain -z`: tracked changes (modified, staged, deleted, renamed) and untracked
 * entries. An untracked directory comes as one `dir/` entry, however many files it holds.
 */
function parseStatus(out: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = []
  const untracked: string[] = []
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    if (xy === '??') untracked.push(path)
    else if (xy !== '!!') tracked.push(path)
    // A rename or copy is followed by its source path.
    if (xy.includes('R') || xy.includes('C')) i++
  }
  return { tracked, untracked }
}

/** An untracked entry collides with an incoming path when it is that path, lies under it or contains it. */
const collides = (untracked: string, incoming: string): boolean => {
  const u = untracked.replace(/\/$/, '')
  return u === incoming || incoming.startsWith(`${u}/`) || u.startsWith(`${incoming}/`)
}

/**
 * Bring a reused worktree up to the repository's current HEAD. A clean fast-forward is silent; a
 * worktree with local work, or a merge that would conflict, is left alone and reported as a step so
 * the caller can see that the copy is behind.
 *
 * Local work that blocks: any change to a tracked file, and untracked paths that the incoming commits
 * (merge-base..base) also touch — a merge would overwrite them. Other untracked files (setup
 * artefacts outside .gitignore, a worker's new files) are carried over untouched by the merge, so
 * they do not block (rf1). Collisions are found up front rather than from git's refusal, whose text
 * is localised; git's own refusal remains the backstop.
 */
async function refreshFromBase(base: string, path: string, exec: Exec, lang: MessageLang | undefined): Promise<StepResult | undefined> {
  const started = Date.now()
  const behind = await exec('git', ['-C', path, 'merge-base', '--is-ancestor', base, 'HEAD'])
  if (behind.code === 0) return undefined
  const step = (ok: boolean, output: string): StepResult => ({ step: orchText(lang, 'refresh.step', { base: base.slice(0, 7) }), ok, durationMs: Date.now() - started, output })
  const status = await exec('git', ['-C', path, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  if (status.code !== 0) return step(false, tail(status.stderr))
  const { tracked, untracked } = parseStatus(status.stdout)
  if (tracked.length) return step(false, orchText(lang, 'refresh.local', { paths: listPaths(lang, tracked) }))
  if (untracked.length) {
    const incoming = await exec('git', ['-C', path, 'diff', '--name-only', '-z', `HEAD...${base}`])
    if (incoming.code !== 0) return step(false, tail(incoming.stderr))
    const paths = incoming.stdout.split('\0').filter(Boolean)
    const blocked = untracked.filter((u) => paths.some((p) => collides(u, p)))
    if (blocked.length) return step(false, orchText(lang, 'refresh.untracked', { paths: listPaths(lang, blocked) }))
  }
  const merged = await exec('git', ['-C', path, 'merge', '--ff-only', base])
  if (merged.code === 0) return step(true, tail(merged.stdout))
  const merge = await exec('git', ['-C', path, 'merge', base, '--no-edit'])
  if (merge.code === 0) return step(true, tail(merge.stdout))
  // A conflicted merge would leave the worker a half-merged copy: undo it. The tree was clean before,
  // so the abort restores exactly the worker's commit, and untracked files are not touched.
  await exec('git', ['-C', path, 'merge', '--abort'])
  return step(false, orchText(lang, 'refresh.conflict', { base: base.slice(0, 7), output: tail(merge.stdout + merge.stderr).trim() }))
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'task'
}

export function worktreeLocation(repoRoot: string, taskId: string, title: string): { path: string; branch: string } {
  return {
    path: resolve(dirname(repoRoot), `${basename(repoRoot)}-orch-${taskId}`),
    branch: `orch/${taskId}-${slugify(title)}`,
  }
}

const exists = (p: string) => stat(p).then(() => true, () => false)
const tail = (s: string) => s.slice(-2000)

async function revParse(dir: string, exec: Exec): Promise<string | undefined> {
  const r = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : undefined
}

export async function prepareWorktree(opts: {
  repoRoot: string
  taskId: string
  title: string
  recipe: Recipe
  scope?: string
  exec: Exec
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Language of the refresh step's label and refusal. */
  lang?: MessageLang
}): Promise<PrepareResult> {
  const { path, branch } = worktreeLocation(opts.repoRoot, opts.taskId, opts.title)
  const now = opts.now ?? (() => new Date())
  const repoHead = await revParse(opts.repoRoot, opts.exec)
  const reused = await exists(path)
  const result: PrepareResult = { path, branch, reused, steps: [] }
  let state: WorktreeState = {}
  if (reused) {
    // A reused worktree keeps the commit it was branched from: a task relaunched after its plan or
    // contract changed would otherwise read yesterday's instructions (observed 2026-09-22, task m1).
    const refresh = repoHead ? await refreshFromBase(repoHead, path, opts.exec, opts.lang) : undefined
    if (refresh) result.steps.push(refresh)
    state = (await readWorktreeState(path)) ?? {}
  } else {
    const add = await opts.exec('git', ['-C', opts.repoRoot, 'worktree', 'add', '-b', branch, path, 'HEAD'])
    if (add.code !== 0) throw new PrepareError(`git worktree add failed: ${add.stderr.trim()}`, result)
  }

  const env = { ...(opts.env ?? process.env) }
  for (const key of opts.recipe.env.unset) delete env[key]
  const timeoutMs = opts.recipe.timeoutSec * 1000

  const shell = async (cmd: string): Promise<StepResult> => {
    const started = Date.now()
    const r = await opts.exec('/bin/sh', ['-c', cmd], { cwd: path, env, timeoutMs })
    const note = r.timedOut ? `\n[таймаут ${opts.recipe.timeoutSec} с]` : ''
    return { step: cmd, ok: r.code === 0 && !r.timedOut, durationMs: Date.now() - started, output: tail(r.stdout + r.stderr) + note }
  }

  // A reused copy whose setup never finished (it failed, or an older version made the copy and left no
  // record) runs it now: the baseline below must not judge a half-prepared copy.
  if (!state.setup?.ok) {
    for (const step of opts.recipe.setup) {
      if (typeof step === 'string') {
        const r = await shell(step)
        result.steps.push(r)
        if (!r.ok) throw new PrepareError(`шаг рецепта упал: ${step}`, result)
        continue
      }
      const started = Date.now()
      const label = `copy ${step.copy}`
      try {
        await cp(join(opts.repoRoot, step.copy), join(path, step.copy), { recursive: true })
        result.steps.push({ step: label, ok: true, durationMs: Date.now() - started, output: '' })
      } catch (err) {
        result.steps.push({ step: label, ok: false, durationMs: Date.now() - started, output: String(err) })
        throw new PrepareError(`шаг рецепта упал: ${label}`, result)
      }
    }
    state = { ...state, setup: { ok: true, at: now().toISOString() } }
    await writeWorktreeState(path, state)
  }

  if (!opts.recipe.baseline) return result
  const command = opts.recipe.baseline.replaceAll('{scope}', opts.scope ?? '')
  // The base the copy stands on: the repository HEAD when the copy contains it, else unknown (a copy
  // with local changes that could not be brought forward), and an unknown base always reruns.
  const base = repoHead && (await opts.exec('git', ['-C', path, 'merge-base', '--is-ancestor', repoHead, 'HEAD'])).code === 0 ? repoHead : undefined
  if (reused && baselineIsCurrent(state.baseline, command, base)) {
    result.record = state.baseline
    return result
  }
  result.baseline = await shell(command)
  const commit = (await revParse(path, opts.exec)) ?? ''
  result.record = { commit, ...(base ? { base } : {}), command, ok: result.baseline.ok, at: now().toISOString() }
  await writeWorktreeState(path, { ...state, baseline: result.record })
  return result
}
