import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addRegisteredRepo, initPlan, nodeExec, readRepoRegistry, repoRegistryPath, worktreeLocation } from '@crewboard/core'
import { run } from '../src/cli.js'
import { makeRepo } from '../../core/test/git-helpers.js'
import { makeHarness } from './harness.js'

/**
 * Every test has its own HOME, so the list lives in `<tmp>/.config/crewboard/repos.json`, never in the
 * owner's. A `.dsh` folder in it stands for «the screen is installed»: the warning needs one to miss.
 */
async function place(opts: { dsh?: boolean } = {}) {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-rg1-cli-'))
  if (opts.dsh !== false) await mkdir(join(home, '.dsh'), { recursive: true })
  const env: NodeJS.ProcessEnv = { HOME: home }
  return { root, home, env, h: makeHarness({ cwd: root, env }) }
}

const OFF_SCREEN = 'the Crewboard screen does not show this plan'

describe('crewboard init and plan new register the place', () => {
  it('init adds the repository root to the list', async () => {
    const { root, home, env, h } = await place()
    expect(await run(['init', '--goal', 'Harness'], h.io)).toBe(0)
    expect(readRepoRegistry(env, home)).toEqual([root])
    expect(JSON.parse(await readFile(repoRegistryPath(env, home), 'utf8'))).toEqual({ version: 1, repos: [root] })
    expect(h.out()).toContain(`Added to the Crewboard list, the screen shows it: ${root}`)
    expect(h.err()).not.toContain(OFF_SCREEN)
  })

  it('plan new adds a worktree root, not its main checkout', async () => {
    const { root, home, env } = await place()
    const hub = join(root, '.worktrees', 'harness-hub')
    expect((await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'hub', hub])).code).toBe(0)
    const h = makeHarness({ cwd: hub, env })
    expect(await run(['plan', 'new', 't1', '--goal', 'Hub'], h.io)).toBe(0)
    expect(readRepoRegistry(env, home)).toEqual([hub])
  })

  it('never registers a Crewboard task copy', async () => {
    const { root, home, env } = await place()
    const copy = worktreeLocation(root, 't7', 'Task seven').path
    expect((await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'orch/t7-task-seven', copy])).code).toBe(0)
    const h = makeHarness({ cwd: copy, env })
    expect(await run(['init'], h.io)).toBe(0)
    expect(readRepoRegistry(env, home)).toEqual([])
    // …and a task copy never earns the warning either: it is not a place the screen should show.
    expect(h.err()).not.toContain(OFF_SCREEN)
  })
})

describe('the «not on screen» warning', () => {
  it('fires once for a plan in an unregistered place, with the fix, and stops after repo add', async () => {
    const { root, h } = await place()
    await initPlan(root, 'Made elsewhere', new Date('2026-09-24T10:00:00Z'))
    expect(await run(['status'], h.io)).toBe(0)
    expect(h.err().split(OFF_SCREEN)).toHaveLength(2)
    expect(h.err()).toContain('crewboard repo add')
    h.reset()
    expect(await run(['repo', 'add'], h.io)).toBe(0)
    expect(h.out()).toBe(`Added to the Crewboard list: ${root}\n`)
    expect(h.err()).toBe('')
    expect(await run(['status'], h.io)).toBe(0)
    expect(h.err()).toBe('')
  })

  it('speaks Russian', async () => {
    const { root, h } = await place()
    await initPlan(root, 'Made elsewhere', new Date('2026-09-24T10:00:00Z'))
    expect(await run(['--lang', 'ru', 'status'], h.io)).toBe(0)
    expect(h.err()).toContain('экран Crewboard не показывает этот план')
    expect(h.err()).toContain('crewboard repo add')
  })

  it('stays quiet for a worktree of a listed repository and when there is no screen', async () => {
    const listed = await place()
    await initPlan(listed.root, 'Main', new Date())
    expect(await run(['repo', 'add'], listed.h.io)).toBe(0)
    const hub = join(listed.root, '.worktrees', 'hub')
    expect((await nodeExec('git', ['-C', listed.root, 'worktree', 'add', '-q', '-b', 'hub', hub])).code).toBe(0)
    await initPlan(hub, 'Hub', new Date())
    const inHub = makeHarness({ cwd: hub, env: listed.env })
    expect(await run(['status'], inHub.io)).toBe(0)
    expect(inHub.err()).toBe('')

    const bare = await place({ dsh: false })
    await initPlan(bare.root, 'CLI only', new Date())
    expect(await run(['status'], bare.h.io)).toBe(0)
    expect(bare.h.err()).toBe('')
  })

  it('counts a dsh workspace as shown', async () => {
    const { root, home, h } = await place()
    await mkdir(join(home, '.dsh', 'storages'), { recursive: true })
    await writeFile(join(home, '.dsh', 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w1: { path: root, title: 'Repo' } } } }))
    await initPlan(root, 'Workspace plan', new Date())
    expect(await run(['status'], h.io)).toBe(0)
    expect(h.err()).toBe('')
  })
})

describe('crewboard repo add | list | rm', () => {
  it('lists every place with its source and marks a missing one', async () => {
    const { root, home, env, h } = await place()
    const gone = join(await mkdtemp(join(tmpdir(), 'orch-rg1-gone-')), 'deleted')
    expect(await run(['repo', 'add'], h.io)).toBe(0)
    await addRegisteredRepo(gone, env, home)
    h.reset()
    expect(await run(['repo', 'list'], h.io)).toBe(0)
    expect(h.out()).toBe(`${root}  · Crewboard list\n${gone}  · Crewboard list · missing\n`)
  })

  it('removes a path that no longer exists, touching nothing on disk', async () => {
    const { root, home, env, h } = await place()
    const gone = join(await mkdtemp(join(tmpdir(), 'orch-rg1-gone-')), 'deleted')
    await addRegisteredRepo(gone, env, home)
    await addRegisteredRepo(root, env, home)
    expect(await run(['repo', 'rm', gone], h.io)).toBe(0)
    expect(h.out()).toContain(`Removed from the Crewboard list: ${gone}`)
    expect(readRepoRegistry(env, home)).toEqual([root])
    expect(await run(['repo', 'rm', '.'], h.io)).toBe(0)
    expect(readRepoRegistry(env, home)).toEqual([])
    expect((await nodeExec('git', ['-C', root, 'status', '--short'])).code).toBe(0)
  })

  it('refuses a folder that is not a Git repository and a path not in the list', async () => {
    const { home, h } = await place()
    const plain = await mkdtemp(join(tmpdir(), 'orch-rg1-plain-'))
    expect(await run(['repo', 'add', plain], h.io)).toBe(1)
    expect(h.err()).toContain('is not a Git repository or worktree')
    h.reset()
    expect(await run(['repo', 'rm', join(home, 'nowhere')], h.io)).toBe(1)
    expect(h.err()).toContain('Not in the Crewboard list')
  })

  it('keeps repo preset and prints the new usage for an unknown subcommand', async () => {
    const { h } = await place()
    expect(await run(['repo', 'frobnicate'], h.io)).toBe(2)
    expect(h.err()).toContain('repo add [path] | repo list | repo rm <path> | repo preset <id>')
  })
})
