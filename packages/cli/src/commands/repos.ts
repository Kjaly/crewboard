import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type Exec,
  type RepositoryRef,
  RepoPathError,
  addRegisteredRepo,
  discoverWorktreeRepos,
  expandHome,
  isTaskWorktree,
  listWorktrees,
  listedRepositories,
  planIds,
  readRepoRegistry,
  removeRegisteredRepo,
  resolveRepoPath,
  screenVisibility,
} from '@crewboard/core'
import { homeOf } from '../context.js'
import { cliT } from '../i18n.js'
import { type Io, UserError } from '../io.js'

const language = (io: Io) => io.lang ?? 'en'

const sourceLabel = (io: Io, ref: RepositoryRef): string =>
  (ref.sources ?? []).map((source) => cliT(language(io), `repo.source.${source}`, { main: ref.worktreeOf ?? '' })).join(', ')

/**
 * `crewboard init` and `plan new` put the place they work on into Crewboard's list, so the screen shows
 * the plan. A task copy (`<repo>-orch-<task>`) is never registered: it is a worker's checkout, not a place.
 */
export async function registerPlace(io: Io, exec: Exec, root: string): Promise<void> {
  const [main] = await listWorktrees(root, exec)
  if (main && isTaskWorktree(main, root)) return
  if (await addRegisteredRepo(root, io.env, homeOf(io))) io.out(cliT(language(io), 'repo.registered', { root }))
}

/**
 * The one warning a plan command may add: the plan sits in a place the screen does not show. Only when
 * there is a screen to miss it (`~/.dsh` exists), only for a folder that holds a plan, never for a task copy.
 */
export async function warnIfOffScreen(io: Io, exec: Exec): Promise<void> {
  try {
    const home = homeOf(io)
    if (!existsSync(join(home, '.dsh'))) return
    const top = await exec('git', ['-C', io.cwd, 'rev-parse', '--show-toplevel'])
    const root = top.code === 0 ? top.stdout.trim() : ''
    if (!root || (await planIds(root).catch(() => [] as string[])).length === 0) return
    const visibility = await screenVisibility(root, { env: io.env, home, exec })
    if (visibility.visible || visibility.taskWorktree) return
    io.err(cliT(language(io), 'repo.offScreen', { root }))
  } catch {
    /* The warning is advice: failing to compute it must never change the command's result. */
  }
}

const sameFolder = (a: string, b: string): boolean => {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

export async function cmdRepoList(io: Io, exec: Exec): Promise<number> {
  const listed = listedRepositories(io.env, homeOf(io))
  const found = await discoverWorktreeRepos(listed, exec)
  const all = [...listed, ...found]
  if (all.length === 0) {
    io.out(cliT(language(io), 'repo.listEmpty'))
    return 0
  }
  for (const ref of all) {
    const missing = existsSync(ref.root) ? '' : ` · ${cliT(language(io), 'repo.missing')}`
    io.out(`${ref.root}  · ${sourceLabel(io, ref)}${missing}\n`)
  }
  return 0
}

export async function cmdRepoAdd(argv: string[], io: Io, exec: Exec): Promise<number> {
  let root: string
  try {
    root = await resolveRepoPath(argv[0] ?? '.', { home: homeOf(io), exec, cwd: io.cwd })
  } catch (err) {
    if (err instanceof RepoPathError) throw new UserError(cliT(language(io), `repo.error.${err.code}`, { path: err.path }))
    throw err
  }
  const added = await addRegisteredRepo(root, io.env, homeOf(io))
  io.out(cliT(language(io), added ? 'repo.added' : 'repo.alreadyListed', { root }))
  return 0
}

/** Removes by the listed string: a folder that no longer exists is removed like any other, nothing on disk is touched. */
export async function cmdRepoRm(argv: string[], io: Io): Promise<number> {
  const typed = argv[0]
  if (!typed) throw new UserError(cliT(language(io), 'repo.usage'), 2)
  const home = homeOf(io)
  const path = resolve(io.cwd, expandHome(typed, home))
  const entry = readRepoRegistry(io.env, home).find((root) => root === path || root === typed || sameFolder(root, path))
  if (!entry) {
    const other = listedRepositories(io.env, home).find((ref) => ref.root === path || sameFolder(ref.root, path))
    const hint = other?.sources?.includes('dsh') ? 'repo.notListed.dsh' : other?.sources?.includes('profile') ? 'repo.notListed.profile' : 'repo.notListed.none'
    throw new UserError(cliT(language(io), hint, { root: path }))
  }
  await removeRegisteredRepo(entry, io.env, home)
  io.out(cliT(language(io), 'repo.removed', { root: entry }))
  const still = listedRepositories(io.env, home).find((ref) => ref.root === entry)
  if (still) io.out(cliT(language(io), 'repo.stillShown', { sources: sourceLabel(io, still) }))
  return 0
}
