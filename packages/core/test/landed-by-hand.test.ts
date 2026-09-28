import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { deriveViews } from '../src/plan/graph.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { MergeError, markMerged } from '../src/worktree/merge-task.js'
import { recordMerges } from '../src/worktree/merged.js'
import { makeRepo } from './git-helpers.js'

// mk1: work a worker left uncommitted and the orchestrator carried into the base by hand stops waiting for a merge —
// found by content, or recorded by a person with a reason.

const NOW = new Date('2026-09-25T10:00:00Z')
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])
const backend: RunBackend = { id: 'dsh', launch: async () => 'run_x', events: async () => [], status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }), steer: async () => {}, cancel: async () => {} }
const backends: Backends = { forAgent: async () => backend }

/**
 * An accepted task `a` whose branch holds no commit of its own; its copy changed README.txt, added src/a.ts and a
 * journal under docs/tmp/, and deleted old.txt — all without a commit. `g` depends on `a`.
 */
async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'old.txt'), 'old\n')
  await git(root, 'add', 'old.txt')
  await git(root, 'commit', '-q', '-m', 'old')
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, 'README.txt'), 'changed\n')
  await mkdir(join(copy, 'src'))
  await writeFile(join(copy, 'src', 'a.ts'), 'export const a = 1\n')
  await mkdir(join(copy, 'docs', 'tmp'), { recursive: true })
  await writeFile(join(copy, 'docs', 'tmp', 'journal.md'), 'what I did\n')
  await rm(join(copy, 'old.txt'))
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'a', title: 'A' }), status: 'accepted', worktree: { path: copy, branch: 'orch/a-a' } })
    p.tasks.push(newTask({ id: 'g', title: 'G', deps: ['a'] }))
    return p
  })
  return { root, copy }
}

/** The orchestrator carries the copy's files into the base checkout by hand and commits them there. */
async function carryByHand(root: string, o: { readme?: string } = {}) {
  await writeFile(join(root, 'README.txt'), o.readme ?? 'changed\n')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await git(root, 'rm', '-q', 'old.txt')
  await git(root, 'add', '-A', 'README.txt', 'src')
  await git(root, 'commit', '-q', '-m', 'carry a by hand')
}

const sync = async (root: string) => recordMerges(root, await loadPlan(root), nodeExec, NOW)
const task = async (root: string, id: string) => (await loadPlan(root)).tasks.find((t) => t.id === id)!
const waiting = async (root: string) => deriveViews(await loadPlan(root)).find((v) => v.task.id === 'g')!.waitingMerge ?? []

describe('landed by content (mk1)', () => {
  it('uncommitted work identical at the base tip counts as merged, with «content» in the history; the journal is ignored', async () => {
    const { root } = await setup()
    await sync(root)
    expect((await task(root, 'a')).merged).toBeUndefined()
    expect(await waiting(root)).toEqual(['a'])

    await carryByHand(root)
    await sync(root)
    const a = await task(root, 'a')
    expect(a.merged).toMatchObject({ into: 'main', how: 'content' })
    expect(a.notes.map((n) => n.event)).toEqual([{ kind: 'merged_by_content', into: 'main' }])
    expect(await waiting(root)).toEqual([])
    // Recorded once: another sync writes nothing new.
    await sync(root)
    expect((await task(root, 'a')).notes).toHaveLength(1)
  })

  it('one file that differs at the base keeps the task unmerged', async () => {
    const { root } = await setup()
    await carryByHand(root, { readme: 'changed again by a later task\n' })
    await sync(root)
    expect((await task(root, 'a')).merged).toBeUndefined()
    expect(await waiting(root)).toEqual(['a'])
  })

  it('a deleted file still present at the base keeps the task unmerged', async () => {
    const { root } = await setup()
    await carryByHand(root)
    await writeFile(join(root, 'old.txt'), 'old\n')
    await git(root, 'add', 'old.txt')
    await git(root, 'commit', '-q', '-m', 'old is back')
    await sync(root)
    expect((await task(root, 'a')).merged).toBeUndefined()
  })
})

describe('mark as merged by a person (mk1)', () => {
  it('records the reason with by: person, and a dependent may start', async () => {
    const { root } = await setup()
    await carryByHand(root, { readme: 'edited again by task b\n' })
    await sync(root)
    expect(await waiting(root)).toEqual(['a'])

    const result = await markMerged(root, 'a', '  carried into the hub by hand, then edited by b  ', { exec: nodeExec, now: NOW })
    expect(result).toMatchObject({ taskId: 'a', into: 'main' })
    const a = await task(root, 'a')
    expect(a.merged).toEqual({ at: NOW.toISOString(), into: 'main', how: 'person', by: 'person', reason: 'carried into the hub by hand, then edited by b' })
    expect(a.notes.at(-1)).toMatchObject({ type: 'comment', event: { kind: 'marked_merged', into: 'main', by: 'person', reason: 'carried into the hub by hand, then edited by b' } })
    expect(a.notes.at(-1)?.text).toBe('marked as merged into main by a person: carried into the hub by hand, then edited by b')
    expect(await waiting(root)).toEqual([])
    expect(deriveViews(await loadPlan(root)).find((v) => v.task.id === 'a')?.unmerged).toBeUndefined()

    // Twice is refused: nothing left to do.
    const again = await markMerged(root, 'a', 'again', { exec: nodeExec, now: NOW }).catch((e: unknown) => e)
    expect(again).toBeInstanceOf(MergeError)
    expect((again as MergeError).code).toBe('already_merged')
  })

  it('refuses without a reason and for a task that is not accepted', async () => {
    const { root } = await setup()
    const code = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e as MergeError).code)
    expect(await code(markMerged(root, 'a', '   ', { exec: nodeExec, now: NOW }))).toBe('reason_required')
    expect(await code(markMerged(root, 'g', 'why', { exec: nodeExec, now: NOW }))).toBe('not_accepted')
    expect(await code(markMerged(root, 'zz', 'why', { exec: nodeExec, now: NOW }))).toBe('unknown_task')
    expect((await task(root, 'a')).merged).toBeUndefined()
  })

  it('works on a main checkout with a detached HEAD, and the panel names its current commit instead of a bare hash', async () => {
    const { root } = await setup()
    await git(root, 'checkout', '-q', '--detach')
    // No main line to fall back to: the base is the detached HEAD commit, as on a hub.
    await git(root, 'branch', '-q', '-m', 'main', 'work')
    const head = (await git(root, 'rev-parse', 'HEAD')).stdout.trim()
    const detail = await getTaskDetail(root, 'a', backends, nodeExec)
    expect(detail.merge).toMatchObject({ into: head, detached: { root } })

    const result = await markMerged(root, 'a', 'landed in the hub by hand', { exec: nodeExec, now: NOW })
    expect(result.into).toBe(head)
    expect((await task(root, 'a')).merged).toMatchObject({ into: head, how: 'person' })
    expect(await waiting(root)).toEqual([])
  })

  it('a base on a branch is named as the branch', async () => {
    const { root } = await setup()
    const detail = await getTaskDetail(root, 'a', backends, nodeExec)
    expect(detail.merge?.into).toBe('main')
    expect(detail.merge?.detached).toBeUndefined()
  })
})
