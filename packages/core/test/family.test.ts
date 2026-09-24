import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Exec, nodeExec } from '../src/exec.js'
import { createRepoFamilyResolver, resolveRepoFamily } from '../src/worktree/family.js'
import { makeRepo } from './git-helpers.js'

describe('resolveRepoFamily', () => {
  it('groups a linked worktree, its main checkout and a non-git directory', async () => {
    const main = await makeRepo()
    const worktree = join(dirname(main), 'wt')
    expect((await nodeExec('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wt', worktree])).code).toBe(0)
    const plain = await mkdtemp(join(tmpdir(), 'orch-family-plain-'))

    const mainFamily = await resolveRepoFamily(main, nodeExec)
    const worktreeFamily = await resolveRepoFamily(worktree, nodeExec)
    const plainFamily = await resolveRepoFamily(plain, nodeExec)

    expect(mainFamily).toEqual({ root: main, name: basename(main) })
    expect(worktreeFamily).toEqual(mainFamily)
    expect(plainFamily).toEqual({ root: plain, name: basename(plain) })
  })

  it('resolves a subdirectory to its repository root', async () => {
    const main = await makeRepo()
    const sub = join(main, 'packages')
    await mkdir(sub, { recursive: true })
    expect(await resolveRepoFamily(sub, nodeExec)).toEqual({ root: main, name: basename(main) })
  })

  it('caches per path and only drops the cache when the repository list changes', async () => {
    const main = await makeRepo()
    let calls = 0
    const counting: Exec = (cmd, args, opts) => {
      calls++
      return nodeExec(cmd, args, opts)
    }
    const resolver = createRepoFamilyResolver(counting)
    resolver.refresh([main])
    expect(await resolver.resolve(main)).toEqual({ root: main, name: basename(main) })
    await resolver.resolve(main)
    expect(calls).toBe(1)

    // The same list: the cache survives and git is not spawned again.
    resolver.refresh([main])
    await resolver.resolve(main)
    expect(calls).toBe(1)

    // A changed list: every cached family is resolved again.
    resolver.refresh([main, join(main, 'other')])
    await resolver.resolve(main)
    expect(calls).toBe(2)
  })
})
