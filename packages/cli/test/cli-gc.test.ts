import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_RECIPE, initPlan, newTask, nodeExec, prepareWorktree, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const exists = (p: string) => stat(p).then(() => true, () => false)

/** Four accepted clean copies: the oldest is merged and past the three recent ones — the only one that may go. */
async function setup() {
  const root = await makeRepo()
  await initPlan(root, 'g', new Date('2026-09-22T10:00:00Z'))
  const copies = new Map<string, { path: string; branch: string }>()
  for (const id of ['old', 'new1', 'new2', 'new3']) {
    const wt = await prepareWorktree({ repoRoot: root, taskId: id, title: id, recipe: EMPTY_RECIPE, exec: nodeExec })
    copies.set(id, { path: wt.path, branch: wt.branch })
  }
  const acceptedAt = { old: '2026-09-22T10:00:00Z', new1: '2026-09-22T11:00:00Z', new2: '2026-09-22T11:01:00Z', new3: '2026-09-22T11:02:00Z' }
  await updatePlan(root, (plan) => {
    plan.tasks = Object.entries(acceptedAt).map(([id, at]) => ({ ...newTask({ id, title: id }), status: 'accepted' as const, worktree: copies.get(id)!, notes: [{ at, type: 'accept' as const, text: 'accepted' }] }))
    return plan
  })
  const home = await mkdtemp(join(tmpdir(), 'orch-gc-home-'))
  const env = { ...process.env, HOME: home, CREWBOARD_WORKTREE_CONFIG: join(home, 'worktrees.json') }
  return { root, copies, env }
}

// B06 (ux8 P5): the help says «without --yes only shows reasons and sizes» — the dry run used to remove
// merged clean copies through the accepted re-check and print nothing about it.
describe('worktree gc', () => {
  it('without --yes deletes nothing, even a merged clean copy it would remove', async () => {
    const { root, copies, env } = await setup()
    const h = makeHarness({ cwd: root, env })
    expect(await run(['worktree', 'gc'], h.io)).toBe(0)
    expect(await exists(copies.get('old')!.path)).toBe(true)
    expect(h.out()).toMatch(/✓ main\/old: can remove/)
    expect(h.out()).toMatch(/· main\/new1: kept \(copy accepted recently\)/)
  })

  it('with --yes removes it and says what it removed', async () => {
    const { root, copies, env } = await setup()
    const h = makeHarness({ cwd: root, env })
    expect(await run(['worktree', 'gc', '--yes'], h.io)).toBe(0)
    expect(await exists(copies.get('old')!.path)).toBe(false)
    expect(h.out()).toContain('✓ old: worktree removed')
  })

  it('with --yes and nothing to remove says so and why the rest stays', async () => {
    const { root, env } = await setup()
    const h = makeHarness({ cwd: root, env })
    await run(['worktree', 'gc', '--yes'], h.io)
    h.reset()
    expect(await run(['worktree', 'gc', '--yes'], h.io)).toBe(0)
    expect(h.out()).toBe('Nothing removed: 3 kept as copy accepted recently.\n')
    h.reset()
    expect(await run(['--lang', 'ru', 'worktree', 'gc', '--yes'], h.io)).toBe(0)
    expect(h.out()).toBe('Ничего не убрано: оставлено 3 — копия принята недавно.\n')
  })
})
