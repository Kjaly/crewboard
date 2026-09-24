import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import { initPlan } from '../src/plan/store.js'
import { worktreeLocation } from '../src/worktree/prepare.js'
import {
  RepoPathError,
  addRegisteredRepo,
  discoverWorktreeRepos,
  dshPluginRowRepos,
  isTaskWorktree,
  readRepoRegistry,
  removeRegisteredRepo,
  repoRegistryPath,
  resolveRepoPath,
  screenVisibility,
} from '../src/workspaces/registry.js'
import { folderKey, mergeWorkspaces } from '../src/workspaces/workspaces.js'
import { makeRepo } from './git-helpers.js'

const home = () => mkdtemp(join(tmpdir(), 'orch-registry-'))

describe("Crewboard's repository list", () => {
  it('lives next to the other stores, with an env override', async () => {
    expect(repoRegistryPath({}, '/h')).toBe('/h/.config/crewboard/repos.json')
    expect(repoRegistryPath({ CREWBOARD_REPOS_FILE: '/x/r.json' }, '/h')).toBe('/x/r.json')
    expect(repoRegistryPath({ ORCH_REPOS_FILE: '/y/r.json' }, '/h')).toBe('/y/r.json')
  })

  it('adds once, removes by the listed string, and reads a broken file as empty', async () => {
    const h = await home()
    expect(readRepoRegistry({}, h)).toEqual([])
    const adds = await Promise.all([addRegisteredRepo('/a', {}, h), addRegisteredRepo('/b', {}, h), addRegisteredRepo('/a', {}, h)])
    expect(adds.filter(Boolean)).toHaveLength(2)
    expect(readRepoRegistry({}, h)).toEqual(['/a', '/b'])
    expect(await removeRegisteredRepo('/gone/forever', {}, h)).toBe(false)
    expect(await removeRegisteredRepo('/a', {}, h)).toBe(true)
    expect(readRepoRegistry({}, h)).toEqual(['/b'])
    await writeFile(repoRegistryPath({}, h), '{ not json')
    expect(readRepoRegistry({}, h)).toEqual([])
    await writeFile(repoRegistryPath({}, h), JSON.stringify({ repos: ['/ok', 'relative', 7] }))
    expect(readRepoRegistry({}, h)).toEqual(['/ok'])
  })
})

describe('worktrees of listed repositories', () => {
  it('knows a Crewboard task copy by its location', () => {
    expect(isTaskWorktree('/src/app', worktreeLocation('/src/app', 't1', 'x').path)).toBe(true)
    expect(isTaskWorktree('/src/app', '/src/app/.worktrees/hub')).toBe(false)
    expect(isTaskWorktree('/src/app', '/src/app-hub')).toBe(false)
    expect(isTaskWorktree('/src/app', '/src/app')).toBe(false)
  })

  it('finds checkouts that hold a plan, skipping task copies, planless ones and known roots', async () => {
    const main = await makeRepo()
    const add = async (path: string, branch: string) => expect((await nodeExec('git', ['-C', main, 'worktree', 'add', '-q', '-b', branch, path])).code).toBe(0)
    const hub = join(main, '.worktrees', 'hub')
    const task = worktreeLocation(main, 't1', 'x').path
    const plain = join(dirname(main), 'plain')
    await add(hub, 'hub')
    await add(task, 'orch/t1-x')
    await add(plain, 'plain')
    await initPlan(hub, 'Hub', new Date())
    await initPlan(task, 'Task', new Date())
    expect(await discoverWorktreeRepos([{ root: main }], nodeExec)).toEqual([{ root: hub, sources: ['worktree'], worktreeOf: main }])
    expect(await discoverWorktreeRepos([{ root: main }, { root: hub }], nodeExec)).toEqual([])
    // Not git, or gone: nothing to discover, nothing thrown.
    expect(await discoverWorktreeRepos([{ root: await home() }, { root: '/definitely/not/here' }], nodeExec)).toEqual([])
  })
})

describe('one folder, many spellings', () => {
  it('compares symlinked and real paths as one folder in every source and in discovery', async () => {
    const main = await realpath(await makeRepo())
    const link = join(await realpath(await home()), 'via')
    await symlink(dirname(main), link)
    const linked = join(link, basename(main))
    expect(folderKey(linked)).toBe(main)
    expect(folderKey(`${main}/`)).toBe(main)
    expect(folderKey('/definitely/not/here/')).toBe('/definitely/not/here')

    const merged = mergeWorkspaces([{ id: 'w', path: linked, title: 'Acme' }], [`${main}/`], [main])
    expect(merged).toEqual([{ root: linked, title: 'Acme', sources: ['dsh', 'profile', 'crewboard'] }])
    // git prints the real path of the main checkout: it is the listed one, not a new row.
    expect(await discoverWorktreeRepos(merged, nodeExec, () => true)).toEqual([])

    const h = await home()
    expect(await addRegisteredRepo(linked, {}, h)).toBe(true)
    expect(await addRegisteredRepo(main, {}, h)).toBe(false)
    await writeFile(repoRegistryPath({}, h), JSON.stringify({ repos: [linked, main] }))
    expect(readRepoRegistry({}, h)).toEqual([linked])
    expect(await removeRegisteredRepo(main, {}, h)).toBe(true)
    expect(readRepoRegistry({}, h)).toEqual([])
  })
})

describe('typed paths', () => {
  it('expands ~, resolves a subfolder to its repository root and names what is wrong', async () => {
    const repo = await makeRepo()
    const h = dirname(repo)
    await mkdir(join(repo, 'packages'))
    await writeFile(join(h, 'file.txt'), 'x')
    await mkdir(join(h, 'plain'))
    expect(await resolveRepoPath('~/repo', { home: h, exec: nodeExec })).toBe(repo)
    expect(await resolveRepoPath(join(repo, 'packages'), { home: h, exec: nodeExec })).toBe(repo)
    const code = (input: string) => resolveRepoPath(input, { home: h, exec: nodeExec }).then(() => 'ok', (e: RepoPathError) => e.code)
    expect(await code('repo')).toBe('not_absolute')
    expect(await code(join(h, 'nope'))).toBe('not_found')
    expect(await code(join(h, 'file.txt'))).toBe('not_directory')
    expect(await code(join(h, 'plain'))).toBe('not_git')
  })
})

describe('what the screen shows, seen from the CLI', () => {
  it('reads the plugin row of the dsh profile patch', () => {
    const yaml = '- id: other\n  config: {}\n- id: crewboard\n  config:\n    repos:\n      - /r/a\n      - /r/b\n- id: next\n'
    expect(dshPluginRowRepos(yaml, 'crewboard')).toEqual(['/r/a', '/r/b'])
    expect(dshPluginRowRepos(yaml, 'dsh-orchestra')).toBeUndefined()
  })

  it('counts every source and the worktrees of listed repositories', async () => {
    const repo = await makeRepo()
    const h = await home()
    expect(await screenVisibility(repo, { env: {}, home: h, exec: nodeExec })).toEqual({ visible: false, taskWorktree: false })
    expect(await screenVisibility(repo, { env: { CREWBOARD_REPOS: repo }, home: h, exec: nodeExec })).toEqual({ visible: true, via: 'listed' })
    await mkdir(join(h, '.dsh', 'profiles', 'web'), { recursive: true })
    await writeFile(join(h, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), `- id: crewboard\n  config:\n    repos:\n      - ${repo}\n`)
    expect(await screenVisibility(repo, { env: {}, home: h, exec: nodeExec })).toEqual({ visible: true, via: 'listed' })
    const hub = join(repo, '.worktrees', 'hub')
    expect((await nodeExec('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'hub', hub])).code).toBe(0)
    expect(await screenVisibility(hub, { env: {}, home: h, exec: nodeExec })).toEqual({ visible: true, via: 'worktree' })
    const task = worktreeLocation(repo, 't2', 'y').path
    expect((await nodeExec('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'orch/t2-y', task])).code).toBe(0)
    expect(await screenVisibility(task, { env: {}, home: await home(), exec: nodeExec })).toEqual({ visible: false, taskWorktree: true })
  })
})
