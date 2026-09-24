import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type NeedsYouItem, loadPlan, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// w1d (B17): after `accept` the work is still in its branch. The terminal says what to do, lists it in
// `attention` and `status`, and `run` of a dependent refuses until the branch is merged.

const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

async function setup() {
  const root = await makeRepo()
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
  const asked: string[] = []
  const h = makeHarness({ cwd: root, env, isTTY: true, now: new Date('2026-09-24T10:00:00Z') })
  h.io.prompt = async (question) => { asked.push(question); return 'y' }
  expect(await run(['init', '--goal', 'Merge'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'a', '--title', 'A'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'g', '--title', 'G', '--deps', 'a'], h.io)).toBe(0)
  // `a` as a worker leaves it: its own branch and copy, the change committed or not.
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, 'a.ts'), 'export const a = 2\n')
  await updatePlan(root, (p) => {
    const a = p.tasks.find((t) => t.id === 'a')!
    a.status = 'in_review'
    a.worktree = { path: copy, branch: 'orch/a-a' }
    return p
  })
  h.reset()
  return { root, copy, h, asked }
}

it('accept names the merge, attention and status list the task, run of a dependent waits for the merge', async () => {
  const { root, copy, h, asked } = await setup()
  await git(copy, 'add', 'a.ts')
  await git(copy, 'commit', '-q', '-m', 'a')

  expect(await run(['accept', 'a'], h.io)).toBe(0)
  expect(asked[0]).not.toContain('no commit carries')
  expect(h.out()).toContain('✓ a accepted')
  expect(h.out()).toContain('not merged into main yet — tasks that depend on a wait for it')
  expect(h.out()).toContain(`    git -C ${root} merge --no-ff orch/a-a`)

  h.reset()
  expect(await run(['attention', '--json'], h.io)).toBe(0)
  expect((JSON.parse(h.out()) as NeedsYouItem[]).map((i) => [i.kind, i.taskId, i.hint])).toEqual([['unmerged', 'a', `git -C ${root} merge --no-ff orch/a-a`]])
  h.reset()
  expect(await run(['attention'], h.io)).toBe(0)
  expect(h.out()).toContain('Accepted, not merged (1)')
  expect(h.out()).toContain(`a: A → git -C ${root} merge --no-ff orch/a-a`)

  h.reset()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).toMatch(/✓ a +A · accepted, not merged/)
  expect(h.out()).toMatch(/⏸ g +G · waiting for a to be merged/)
  expect(h.out()).toContain('Accepted, not merged (1): a')
  h.reset()
  expect(await run(['status', '--json'], h.io)).toBe(0)
  const status = JSON.parse(h.out())
  expect(status.unmerged).toEqual(['a'])
  expect(status.views.find((v: { id: string }) => v.id === 'g')).toMatchObject({ status: 'blocked', waitingMerge: ['a'] })

  h.reset()
  const agent = makeHarness({ cwd: root, env: h.io.env })
  expect(await run(['run', 'g', '--allow-unmerged'], agent.io)).not.toBe(0)
  expect(agent.err()).toContain('The task is waiting for a to be merged: accepted, but not in main yet')
  expect(agent.err()).toContain('--allow-unmerged')

  await git(root, 'merge', '--no-ff', '-q', '-m', 'merge a', 'orch/a-a')
  h.reset()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).toMatch(/○ g +G/)
  expect(h.out()).not.toContain('not merged')
  expect((await loadPlan(root)).tasks.find((t) => t.id === 'a')?.merged).toMatchObject({ into: 'main' })
})

it('accept of work left uncommitted warns first and prints the commit before the merge', async () => {
  const { root, copy, h, asked } = await setup()
  expect(await run(['accept', 'a'], h.io)).toBe(0)
  expect(asked[0]).toContain('The copy of a holds 1 file(s) no commit carries: the task branch does not contain this result')
  expect(h.out()).toContain(`    git -C ${copy} add -A\n    git -C ${copy} commit -m 'crewboard: a'\n    git -C ${root} merge --no-ff orch/a-a`)
})
