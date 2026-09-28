import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadPlan, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// mk1: `mark-merged <id> --reason "…"` — a person records work that reached the base in a way Crewboard cannot see.

const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

/** Accepted `a` with uncommitted work in its copy and no branch commit; `g` depends on it. */
async function setup() {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: home, CREWBOARD_WORKTREE_CONFIG: join(home, 'worktrees.json') }
  const asked: string[] = []
  const h = makeHarness({ cwd: root, env, isTTY: true, now: new Date('2026-09-25T10:00:00Z') })
  h.io.prompt = async (question) => { asked.push(question); return 'y' }
  expect(await run(['init', '--goal', 'Mark'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'a', '--title', 'A'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'g', '--title', 'G', '--deps', 'a'], h.io)).toBe(0)
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, 'a.ts'), 'export const a = 2\n')
  await updatePlan(root, (p) => {
    const a = p.tasks.find((t) => t.id === 'a')!
    a.status = 'accepted'
    a.worktree = { path: copy, branch: 'orch/a-a' }
    return p
  })
  h.reset()
  return { root, h, asked, env }
}

it('refuses an agent caller (no terminal) and records nothing', async () => {
  const { root, env } = await setup()
  const agent = makeHarness({ cwd: root, env })
  expect(await run(['mark-merged', 'a', '--reason', 'landed by hand'], agent.io)).toBe(1)
  expect(agent.err()).toContain('if you are a person, run it in a terminal')
  expect((await loadPlan(root)).tasks[0]?.merged).toBeUndefined()
})

it('asks, records the reason by a person, and the dependent is no longer waiting for the merge', async () => {
  const { root, h, asked } = await setup()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).toContain('waiting for a to be merged')
  h.reset()
  expect(await run(['mark-merged', 'a', '--reason', 'carried into the hub by hand'], h.io)).toBe(0)
  expect(asked[0]).toBe(`Record task a (orch/a-a) as merged into main in ${root}, because: «carried into the hub by hand»? Git is not touched; tasks that depend on a may start. [y/N] `)
  expect(h.out()).toContain('✓ a marked as merged into main by a person')
  expect((await loadPlan(root)).tasks[0]?.merged).toMatchObject({ into: 'main', how: 'person', by: 'person', reason: 'carried into the hub by hand' })
  h.reset()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).not.toContain('waiting for a to be merged')
  expect(h.out()).not.toContain('Accepted, not merged')
})

it('without a reason prints the usage; a no at the question changes nothing', async () => {
  const { root, h } = await setup()
  expect(await run(['mark-merged', 'a'], h.io)).toBe(2)
  expect(h.err()).toContain('mark-merged <id> --reason')
  h.io.prompt = async () => 'n'
  expect(await run(['mark-merged', 'a', '--reason', 'x'], h.io)).toBe(1)
  expect((await loadPlan(root)).tasks[0]?.merged).toBeUndefined()
})
