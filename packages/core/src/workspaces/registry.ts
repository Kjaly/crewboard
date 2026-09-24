import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { crewboardEnv } from '../env.js'
import type { Exec } from '../exec.js'
import { CREWBOARD_DIR } from '../plan/store.js'
import { type RepositoryRef, folderKey, mergeWorkspaces, readDshWorkspaces } from './workspaces.js'

/**
 * Crewboard's own repository list (`~/.config/crewboard/repos.json`): the places `crewboard init`,
 * `plan new`, `repo add` and the screen's «+» register. It joins dsh workspaces and the plugin's
 * `repos` setting; it is the only one of the three Crewboard writes.
 */
export const repoRegistryPath = (env: NodeJS.ProcessEnv, home: string): string => crewboardEnv(env, 'REPOS_FILE') ?? join(home, '.config', 'crewboard', 'repos.json')

/** Read on every traversal like the dsh registry, so every failure is an empty list, never a throw. */
export function readRepoRegistry(env: NodeJS.ProcessEnv, home: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(repoRegistryPath(env, home), 'utf8'))
  } catch {
    return []
  }
  const repos = (raw as { repos?: unknown } | null)?.repos
  if (!Array.isArray(repos)) return []
  const keys = new Set<string>()
  return repos.filter((r): r is string => {
    if (typeof r !== 'string' || !isAbsolute(r)) return false
    const key = folderKey(r)
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

const writes = new Map<string, Promise<unknown>>()

/** Read-modify-write under one queue per file, written atomically: two adds in one process never lose each other. */
function editRegistry<T>(env: NodeJS.ProcessEnv, home: string, edit: (repos: string[]) => { repos: string[]; result: T }): Promise<T> {
  const path = repoRegistryPath(env, home)
  const op = (writes.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const before = readRepoRegistry(env, home)
    const { repos, result } = edit(before)
    if (repos.length === before.length && repos.every((r, i) => r === before[i])) return result
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    await writeFile(tmp, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`)
    await rename(tmp, path)
    return result
  })
  writes.set(path, op)
  void op.finally(() => { if (writes.get(path) === op) writes.delete(path) }).catch(() => undefined)
  return op
}

const sameFolder = (a: string, b: string): boolean => a === b || folderKey(a) === folderKey(b)

/** Adds a root; `false` when that folder was already listed, under this path or another form of it. */
export function addRegisteredRepo(root: string, env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
  return editRegistry(env, home, (repos) => (repos.some((r) => sameFolder(r, root)) ? { repos, result: false } : { repos: [...repos, root], result: true }))
}

/**
 * Removes the entries naming that folder, by listed string or by its real path. The folder may be long
 * gone: then only the resolved spelling is compared and nothing on disk is touched.
 */
export function removeRegisteredRepo(root: string, env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
  return editRegistry(env, home, (repos) => {
    const kept = repos.filter((r) => !sameFolder(r, root))
    return { repos: kept, result: kept.length !== repos.length }
  })
}

/**
 * Crewboard's own task copies live next to the repository as `<repo>-orch-<task>` (worktreeLocation).
 * They hold a worker's checkout of the same plan, not a plan of their own, so discovery skips them.
 */
export const isTaskWorktree = (main: string, path: string): boolean =>
  path !== main && dirname(path) === dirname(main) && basename(path).startsWith(`${basename(main)}-orch-`)

/** Every checkout of the repository at `root`, main worktree first (`git worktree list --porcelain`). */
export async function listWorktrees(root: string, exec: Exec): Promise<string[]> {
  const r = await exec('git', ['-C', root, 'worktree', 'list', '--porcelain']).catch(() => undefined)
  if (r?.code !== 0) return []
  return r.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length).trim()).filter(Boolean)
}

const hasPlanDir = (path: string): boolean => existsSync(join(path, CREWBOARD_DIR))

/**
 * The checkouts of known repositories that hold a plan but are not known themselves: a hub worktree
 * made by hand appears under its repository without being registered. The main checkout counts too
 * (a known worktree brings its main one), task copies never do, and a known folder is never repeated:
 * git prints real paths, so both sides compare by {@link folderKey}.
 */
export async function discoverWorktreeRepos(known: readonly RepositoryRef[], exec: Exec, hasPlan: (path: string) => boolean = hasPlanDir): Promise<RepositoryRef[]> {
  const seen = new Set(known.map((r) => folderKey(r.root)))
  const out: RepositoryRef[] = []
  const lists = await Promise.all(known.map((r) => (existsSync(r.root) ? listWorktrees(r.root, exec) : Promise.resolve([]))))
  for (const paths of lists) {
    const [main] = paths
    if (!main) continue
    for (const path of paths) {
      const key = folderKey(path)
      if (seen.has(key) || isTaskWorktree(main, path) || !hasPlan(path)) continue
      seen.add(key)
      out.push({ root: path, sources: ['worktree'], worktreeOf: main })
    }
  }
  return out
}

export type RepoPathErrorCode = 'not_absolute' | 'not_found' | 'not_directory' | 'not_git'

/** Why a typed path cannot join the list; the code is stable, the CLI and the screen word it. */
export class RepoPathError extends Error {
  constructor(
    readonly code: RepoPathErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`)
    this.name = 'RepoPathError'
  }
}

/** `~` and `~/…` expand to the home directory; everything else is returned as typed. */
export const expandHome = (input: string, home: string): string => (input === '~' ? home : input.startsWith('~/') ? join(home, input.slice(2)) : input)

/**
 * The repository root a typed path names: `~` expanded, relative paths refused unless a `cwd` is given,
 * the folder must exist and sit in a Git repository or worktree, and a subfolder resolves to its top.
 */
export async function resolveRepoPath(input: string, opts: { home: string; exec: Exec; cwd?: string }): Promise<string> {
  const typed = expandHome(input.trim(), opts.home)
  if (!isAbsolute(typed) && !opts.cwd) throw new RepoPathError('not_absolute', input)
  const path = resolve(opts.cwd ?? '/', typed)
  let isDir: boolean
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    throw new RepoPathError('not_found', path)
  }
  if (!isDir) throw new RepoPathError('not_directory', path)
  const r = await opts.exec('git', ['-C', path, 'rev-parse', '--show-toplevel']).catch(() => undefined)
  const top = r?.code === 0 ? r.stdout.trim() : ''
  if (!top) throw new RepoPathError('not_git', path)
  return top
}

/**
 * The plugin's own `repos` setting as the CLI can see it: the `crewboard` row (and the older
 * `dsh-orchestra` one) of the dsh web profile patch. Read only; a missing or odd file is no list.
 */
export function readDshProfileRepos(home: string): string[] {
  let source: string
  try {
    source = readFileSync(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  } catch {
    return []
  }
  return ['crewboard', 'dsh-orchestra'].flatMap((id) => dshPluginRowRepos(source, id) ?? [])
}

/** The `repos` list of one plugin row in a cordis patch; `undefined` when the row or the list is absent. */
export function dshPluginRowRepos(source: string, id: string): string[] | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = source.match(new RegExp(`(?:^|\\n)- id: ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n- id:|$)`))?.[1]
  if (!block) return undefined
  const reposBlock = block.match(/\n\s+repos:\s*\n((?:\s+-\s+[^\n]+\n?)*)/)
  return reposBlock?.[1]?.split('\n').map((line) => line.match(/^\s+-\s+(.+?)\s*$/)?.[1]).filter((value): value is string => Boolean(value))
}

/**
 * The listed repositories as a process outside the dsh host can see them: dsh workspaces, the
 * plugin's `repos` (profile row, `CREWBOARD_REPOS` of this environment) and Crewboard's own list.
 */
export function listedRepositories(env: NodeJS.ProcessEnv, home: string): RepositoryRef[] {
  const fromEnv = (crewboardEnv(env, 'REPOS') ?? '').split(':').map((s) => s.trim()).filter((s) => s && isAbsolute(s))
  return mergeWorkspaces(readDshWorkspaces(home), [...readDshProfileRepos(home), ...fromEnv], readRepoRegistry(env, home))
}

export type Visibility = { visible: true; via: 'listed' | 'worktree' } | { visible: false; taskWorktree: boolean }

/**
 * Whether the screen shows the plan at `root`, answered the way the plugin builds its list: dsh
 * workspaces, the plugin's `repos` (profile row and `CREWBOARD_REPOS`), Crewboard's list, and the
 * worktrees of all of those. Paths compare after symlinks resolve (`/var` and `/private/var` on macOS).
 */
export async function screenVisibility(root: string, opts: { env: NodeJS.ProcessEnv; home: string; exec: Exec }): Promise<Visibility> {
  const known = listedRepositories(opts.env, opts.home)
  const target = folderKey(root)
  if (known.some((r) => folderKey(r.root) === target)) return { visible: true, via: 'listed' }
  const checkouts = await listWorktrees(root, opts.exec)
  const main = checkouts[0]
  if (main && isTaskWorktree(main, root)) return { visible: false, taskWorktree: true }
  const family = new Set(checkouts.map(folderKey))
  if (known.some((r) => family.has(folderKey(r.root)))) return { visible: true, via: 'worktree' }
  return { visible: false, taskWorktree: false }
}
