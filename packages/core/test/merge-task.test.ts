import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Exec, nodeExec } from '../src/exec.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { clearConflictCache, reviewConflicts } from '../src/worktree/conflicts.js'
import { MergeError, checkMerge, mergeTask } from '../src/worktree/merge-task.js'
import { makeRepo } from './git-helpers.js'

// mg1 (B18): a person merges accepted work from Crewboard; conflicts are shown before anyone accepts.

const NOW = new Date('2026-09-24T10:00:00Z')
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])
const head = async (dir: string) => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim()
const exists = (path: string) => stat(path).then(() => true, () => false)

/** A task whose copy committed `file` with `content`; `status` as given, accepted `acceptedAt` when accepted. */
async function addTask(root: string, id: string, o: { file: string; content: string; status?: 'accepted' | 'in_review'; acceptedAt?: string; base?: string }) {
  const copy = join(root, '..', `repo-orch-${id}`)
  const branch = `orch/${id}-${id}`
  await git(root, 'worktree', 'add', '-q', '-b', branch, copy, 'main')
  await writeFile(join(copy, o.file), o.content)
  await git(copy, 'add', o.file)
  await git(copy, 'commit', '-q', '-m', `${id}: work`)
  const status = o.status ?? 'accepted'
  await updatePlan(root, (p) => {
    p.tasks.push({
      ...newTask({ id, title: `Task ${id}` }),
      status,
      worktree: { path: copy, branch, ...(o.base ? { base: o.base } : {}) },
      notes: status === 'accepted' ? [{ at: o.acceptedAt ?? NOW.toISOString(), type: 'accept', text: 'accepted' }] : [],
    })
    return p
  })
  return { copy, branch }
}

async function setup() {
  const root = await makeRepo()
  await initPlan(root, 'goal', NOW)
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  return { root, policyPath: join(home, 'worktrees.json') }
}

const refusal = async (promise: Promise<unknown>) => {
  const err = await promise.then(() => undefined, (e: unknown) => e)
  expect(err).toBeInstanceOf(MergeError)
  return err as MergeError
}

describe('mergeTask', () => {
  it('merges with --no-ff: a merge commit naming the branch, merged recorded, a note in the feed', async () => {
    const { root, policyPath } = await setup()
    const { branch } = await addTask(root, 'a', { file: 'a.ts', content: 'export const a = 1\n', base: 'main' })
    const before = await head(root)
    const result = await mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, policyPath })
    expect(result).toMatchObject({ taskId: 'a', into: 'main', strategy: 'no-ff', branch, copy: 'kept_recent' })
    expect(await head(root)).toBe(result.commit)
    const parents = (await git(root, 'log', '-1', '--format=%P')).stdout.trim().split(' ')
    expect(parents).toEqual([before, result.tip])
    expect((await git(root, 'log', '-1', '--format=%s')).stdout).toContain(`Merge branch '${branch}' (crewboard: a — Task a)`)
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 'a')!
    expect(task.merged).toMatchObject({ into: 'main', commit: result.tip, mergeCommit: result.commit, strategy: 'no-ff' })
    expect(task.notes.map((n) => n.event)).toEqual([undefined, { kind: 'merged', into: 'main', strategy: 'no-ff', commit: result.commit }, { kind: 'worktree', outcome: 'kept_recent' }])
    // A second merge is refused: nothing left to do.
    expect((await refusal(mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, policyPath }))).code).toBe('already_merged')
  })

  it('merges with --squash as one commit and cleans the copy the way gc would', async () => {
    const { root, policyPath } = await setup()
    const { copy } = await addTask(root, 'a', { file: 'a.ts', content: 'export const a = 1\n', acceptedAt: '2026-09-24T08:00:00Z' })
    // Three copies accepted later are «the three most recent»: the merged one goes.
    for (const id of ['x', 'y', 'z']) await addTask(root, id, { file: `${id}.ts`, content: `${id}\n`, acceptedAt: '2026-09-24T09:00:00Z' })
    const before = await head(root)
    const result = await mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, strategy: 'squash', policyPath })
    expect(result).toMatchObject({ strategy: 'squash', copy: 'removed' })
    expect((await git(root, 'log', '-1', '--format=%P')).stdout.trim()).toBe(before)
    expect((await git(root, 'log', '-1', '--format=%B')).stdout).toContain(`squash merge of orch/a-a at ${result.tip}`)
    expect((await git(root, 'show', 'HEAD:a.ts')).stdout).toBe('export const a = 1\n')
    expect(await exists(copy)).toBe(false)
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 'a')!
    expect(task.merged).toMatchObject({ into: 'main', strategy: 'squash', mergeCommit: result.commit })
    expect(task.notes.map((n) => n.event?.kind)).toEqual(expect.arrayContaining(['merged', 'worktree']))
  })

  it('refuses a dirty base and touches nothing', async () => {
    const { root, policyPath } = await setup()
    await addTask(root, 'a', { file: 'a.ts', content: 'a\n' })
    await writeFile(join(root, 'README.txt'), 'local edit\n')
    const before = await head(root)
    const err = await refusal(mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, policyPath }))
    expect(err).toMatchObject({ code: 'base_dirty', vars: { into: 'main', count: 1, paths: 'README.txt' } })
    expect(await head(root)).toBe(before)
    expect((await loadPlan(root)).tasks[0]?.merged).toBeUndefined()
  })

  it('refuses when another branch is checked out in the main checkout', async () => {
    const { root, policyPath } = await setup()
    await addTask(root, 'a', { file: 'a.ts', content: 'a\n' })
    await git(root, 'switch', '-q', '-c', 'other')
    const err = await refusal(mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, policyPath }))
    expect(err).toMatchObject({ code: 'wrong_branch', vars: { into: 'main', current: 'other' } })
    expect(err.message).toContain(`git -C ${root} switch main`)
    // The recorded base wins over the main-line guess.
    await updatePlan(root, (p) => { p.tasks[0]!.worktree!.base = 'other'; return p })
    expect((await checkMerge(root, 'a', { exec: nodeExec })).into).toBe('other')
  })

  it('refuses a conflicting merge with the paths, leaving the checkout untouched', async () => {
    const { root, policyPath } = await setup()
    await addTask(root, 'a', { file: 'README.txt', content: 'from the task\n' })
    await writeFile(join(root, 'README.txt'), 'from main\n')
    await git(root, 'commit', '-q', '-am', 'main moves')
    const before = await head(root)
    const err = await refusal(mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, policyPath }))
    expect(err).toMatchObject({ code: 'conflicts', paths: ['README.txt'], vars: { into: 'main', count: 1, paths: 'README.txt' } })
    expect(await head(root)).toBe(before)
    expect((await git(root, 'status', '--porcelain', '--untracked-files=no')).stdout).toBe('')
    expect((await git(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code).not.toBe(0)
  })

  it('a merge git refuses mid-way is undone; an undo git refuses too is said with the command, never assumed done (rf2)', async () => {
    const { root, policyPath } = await setup()
    await addTask(root, 'u', { file: 'u.ts', content: 'export const u = 1\n', base: 'main' })
    const before = await head(root)
    // The merge starts (MERGE_HEAD, staged files) and then fails, e.g. a hook or a lock.
    const failing = (abortCode: number): Exec => async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('--no-ff')) {
        await nodeExec('git', ['-C', root, 'merge', '--no-ff', '--no-commit', args.at(-1) ?? ''])
        return { code: 1, stdout: '', stderr: 'error: simulated refusal\n', timedOut: false }
      }
      if (cmd === 'git' && args.includes('--abort') && abortCode !== 0) return { code: abortCode, stdout: '', stderr: 'fatal: Unable to create index.lock\n', timedOut: false }
      return nodeExec(cmd, args, opts)
    }
    const undone = await refusal(mergeTask(root, 'u', { exec: failing(0), now: () => NOW, policyPath }))
    expect(undone.code).toBe('merge_failed')
    expect((await git(root, 'status', '--porcelain', '--untracked-files=no')).stdout).toBe('')
    expect(await head(root)).toBe(before)

    const stuck = await refusal(mergeTask(root, 'u', { exec: failing(128), now: () => NOW, policyPath }))
    expect(stuck).toMatchObject({ code: 'undo_failed', vars: { root, command: `git -C ${root} merge --abort` } })
    expect(stuck.message).toContain('Unable to create index.lock')
    expect((await git(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code).toBe(0)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'u')?.merged).toBeUndefined()
  })

  it('refuses a task that is not accepted, and a copy holding uncommitted work', async () => {
    const { root, policyPath } = await setup()
    const { copy } = await addTask(root, 'a', { file: 'a.ts', content: 'a\n', status: 'in_review' })
    expect((await refusal(mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, policyPath }))).code).toBe('not_accepted')
    expect((await refusal(mergeTask(root, 'nope', { exec: nodeExec, now: () => NOW, policyPath }))).code).toBe('unknown_task')
    await updatePlan(root, (p) => { p.tasks[0]!.status = 'accepted'; return p })
    await writeFile(join(copy, 'loose.ts'), 'x\n')
    expect((await refusal(mergeTask(root, 'a', { exec: nodeExec, now: () => NOW, policyPath }))).code).toBe('copy_uncommitted')
  })
})

describe('reviewConflicts', () => {
  beforeEach(() => clearConflictCache())

  it('warns about a task in review against its base and another task, and follows the base as it moves', async () => {
    const { root } = await setup()
    await addTask(root, 'b', { file: 'src.ts', content: 'b\n', status: 'in_review' })
    expect((await reviewConflicts(root, await loadPlan(root), nodeExec)).size).toBe(0)

    // The base moves with a different src.ts: the warning appears.
    await writeFile(join(root, 'src.ts'), 'main\n')
    await git(root, 'add', 'src.ts')
    await git(root, 'commit', '-q', '-m', 'main adds src.ts')
    expect((await reviewConflicts(root, await loadPlan(root), nodeExec)).get('b')).toEqual([{ with: 'base', into: 'main', paths: ['src.ts'] }])

    // The base drops src.ts again; two more tasks in review write other.ts differently: they conflict with each other.
    await git(root, 'rm', '-q', 'src.ts')
    await git(root, 'commit', '-q', '-m', 'main drops src.ts again')
    await addTask(root, 'c', { file: 'other.ts', content: 'c\n', status: 'in_review' })
    await addTask(root, 'd', { file: 'other.ts', content: 'd\n', status: 'in_review' })
    const found = await reviewConflicts(root, await loadPlan(root), nodeExec)
    expect(found.get('c')).toEqual([{ with: 'task', taskId: 'd', paths: ['other.ts'], into: 'main' }])
    expect(found.get('d')).toEqual([{ with: 'task', taskId: 'c', paths: ['other.ts'], into: 'main' }])
    // The base dropped its src.ts again: b merges cleanly now and its warning is gone.
    expect(found.has('b')).toBe(false)
  })
})
