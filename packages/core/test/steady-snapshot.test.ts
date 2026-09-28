import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { clearConflictCache } from '../src/worktree/conflicts.js'
import { clearMergeCache } from '../src/worktree/merged.js'
import { makeRepo } from './git-helpers.js'

// pf1: a snapshot of a repository that did not change asks git no merge question again — no merge-tree for accepted
// work waiting for its merge, none for conflicts between tasks in review. Git calls are counted by a logging `git`
// put first on PATH, so every process the snapshot starts is seen, whichever module starts it.

const NOW = new Date('2026-09-25T12:00:00Z')
const backends: Backends = { forAgent: async () => Promise.reject(new Error('no backend in this test')) }
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])
let log = ''
let path = ''

beforeEach(async () => {
  clearConflictCache()
  clearMergeCache()
  const bin = await mkdtemp(join(tmpdir(), 'orch-git-shim-'))
  const real = (await nodeExec('/bin/sh', ['-c', 'command -v git'])).stdout.trim()
  log = join(bin, 'git.log')
  await writeFile(log, '')
  await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`)
  await chmod(join(bin, 'git'), 0o755)
  path = process.env.PATH ?? ''
  process.env.PATH = `${bin}:${path}`
})
afterEach(() => { process.env.PATH = path })

const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean)
const mergeTrees = async () => (await calls()).filter((line) => /(^| )merge-tree /.test(line)).length

/** A branch with one commit on top of main, in a copy of its own. */
async function branch(root: string, name: string, file: string, text: string): Promise<{ path: string; branch: string; base: string }> {
  const copy = join(root, '..', name.replace(/\//g, '-'))
  await git(root, 'worktree', 'add', '-q', '-b', name, copy, 'main')
  await mkdir(join(copy, 'src'), { recursive: true })
  await writeFile(join(copy, file), text)
  await git(copy, 'add', '.')
  await git(copy, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', name)
  return { path: copy, branch: name, base: 'main' }
}

it('a steady snapshot of an unchanged repository makes no merge-tree call and keeps every fact', async () => {
  const root = await makeRepo()
  await writeFile(join(root, '.gitignore'), '.orchestration/\n')
  await git(root, 'add', '.gitignore')
  await git(root, 'commit', '-q', '-m', 'ignore')
  const waiting = await branch(root, 'orch/waiting', 'src/w.ts', 'export const w = 1\n')
  const left = await branch(root, 'orch/left', 'README.txt', 'left\n')
  const right = await branch(root, 'orch/right', 'README.txt', 'right\n')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(
      { ...newTask({ id: 'waiting', title: 'Accepted, not merged' }), status: 'accepted', worktree: waiting, notes: [{ at: NOW.toISOString(), type: 'accept', text: 'ok' }] },
      { ...newTask({ id: 'left', title: 'Left' }), status: 'in_review', worktree: left },
      { ...newTask({ id: 'right', title: 'Right' }), status: 'in_review', worktree: right },
    )
    return p
  })

  const first = await buildRepoSnapshot(root, backends, NOW)
  expect(await mergeTrees()).toBeGreaterThan(0)
  await writeFile(log, '')
  const steady = await buildRepoSnapshot(root, backends, NOW)
  expect(await mergeTrees()).toBe(0)
  // The same facts, read from what the first snapshot learned.
  const facts = (s: typeof first) => s.tasks.map(({ id, status, unmerged, conflicts }) => ({ id, status, unmerged, conflicts }))
  expect(facts(steady)).toEqual(facts(first))
  expect(steady.tasks.find((t) => t.id === 'left')?.conflicts).toEqual([{ with: 'task', taskId: 'right', paths: ['README.txt'], into: 'main' }])
  expect(steady.tasks.find((t) => t.id === 'waiting')).toMatchObject({ status: 'accepted', unmerged: true })

  // A commit on the base is a new question: the waiting branch is asked again.
  await writeFile(join(root, 'other.txt'), 'x\n')
  await git(root, 'add', 'other.txt')
  await git(root, 'commit', '-q', '-m', 'base moves')
  await writeFile(log, '')
  await buildRepoSnapshot(root, backends, NOW)
  expect(await mergeTrees()).toBeGreaterThan(0)
})

it('a quick snapshot reads the plan without git and marks itself partial', async () => {
  const root = await makeRepo()
  const left = await branch(root, 'orch/left', 'README.txt', 'left\n')
  const right = await branch(root, 'orch/right', 'README.txt', 'right\n')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'left', title: 'Left' }), status: 'in_review', worktree: left }, { ...newTask({ id: 'right', title: 'Right' }), status: 'in_review', worktree: right })
    return p
  })
  await writeFile(log, '')
  const quick = await buildRepoSnapshot(root, backends, NOW, undefined, { quick: true })
  expect(await calls()).toEqual([])
  expect(quick).toMatchObject({ partial: true, hasPlan: true })
  expect(quick.tasks.map((t) => [t.id, t.status, t.conflicts])).toEqual([['left', 'in_review', undefined], ['right', 'in_review', undefined]])
  const full = await buildRepoSnapshot(root, backends, NOW)
  expect(full.partial).toBeUndefined()
  expect(full.tasks.find((t) => t.id === 'left')?.conflicts?.[0]).toMatchObject({ with: 'task', taskId: 'right' })
})
