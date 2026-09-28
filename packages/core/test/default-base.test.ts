import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import { getRepositoryDefaultBase, repoDefaultBranch, resolveDefaultBase, setPlanDefaultBase, setRepositoryDefaultBase } from '../src/worktree/default-base.js'
import { initPlan, loadPlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-25T10:00:00Z')
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

// bs1: a task's base is chosen, not caught by accident — the repository's default base, overridable per
// repository and per plan, never whatever a shared main checkout happens to have checked out.

describe('repoDefaultBranch', () => {
  it('is the checked-out branch when there is no origin and no main/master to prefer', async () => {
    const root = await makeRepo()
    expect(await repoDefaultBranch(root, nodeExec)).toBe('main')
  })

  it('prefers origin/HEAD over the checked-out branch', async () => {
    const root = await makeRepo()
    const upstream = await makeRepo()
    await git(upstream, 'branch', '-m', 'trunk')
    await git(root, 'remote', 'add', 'origin', upstream)
    await git(root, 'fetch', '-q', 'origin')
    await git(root, 'branch', 'trunk', 'origin/trunk')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    await git(root, 'switch', '-q', '-c', 'feature')
    expect(await repoDefaultBranch(root, nodeExec)).toBe('trunk')
  })

  it('falls back to main over the checked-out branch when there is no origin/HEAD', async () => {
    const root = await makeRepo()
    await git(root, 'switch', '-q', '-c', 'feature')
    expect(await repoDefaultBranch(root, nodeExec)).toBe('main')
  })
})

describe('resolveDefaultBase', () => {
  it('is the repository default with no override', async () => {
    const root = await makeRepo()
    await initPlan(root, 'g', NOW)
    expect(await resolveDefaultBase(root, nodeExec)).toEqual({ branch: 'main', source: 'default' })
  })

  it('the repository setting overrides the repository default, round-tripping through settings.json', async () => {
    const root = await makeRepo()
    await initPlan(root, 'g', NOW)
    await setRepositoryDefaultBase(root, 'develop')
    expect(await getRepositoryDefaultBase(root)).toBe('develop')
    expect(await resolveDefaultBase(root, nodeExec)).toEqual({ branch: 'develop', source: 'repository', repository: 'develop' })
    await setRepositoryDefaultBase(root, undefined)
    expect(await getRepositoryDefaultBase(root)).toBeUndefined()
    expect(await resolveDefaultBase(root, nodeExec)).toEqual({ branch: 'main', source: 'default' })
  })

  it('a plan override wins over the repository setting', async () => {
    const root = await makeRepo()
    await initPlan(root, 'g', NOW)
    await setRepositoryDefaultBase(root, 'develop')
    await setPlanDefaultBase(root, undefined, 'release')
    expect(await resolveDefaultBase(root, nodeExec)).toEqual({ branch: 'release', source: 'plan', plan: 'release', repository: 'develop' })
    expect((await loadPlan(root)).defaultBase).toBe('release')
    await setPlanDefaultBase(root, undefined, undefined)
    expect(await resolveDefaultBase(root, nodeExec)).toMatchObject({ branch: 'develop', source: 'repository' })
  })

  it('settings.json keeps other keys untouched', async () => {
    const root = await makeRepo()
    await initPlan(root, 'g', NOW)
    await setRepositoryDefaultBase(root, 'develop')
    const raw = JSON.parse(await readFile(join(root, '.orchestration', 'settings.json'), 'utf8'))
    expect(raw).toEqual({ defaultBase: 'develop' })
  })
})
