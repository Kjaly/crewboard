import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { clearConflictCache, loadPlan, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// mg1 (B18): `merge <id>` — a person merges accepted work after the same checks the screen makes; an agent is refused.

const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])
const head = async (dir: string) => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim()

beforeEach(() => clearConflictCache())

async function setup(o: { file?: string; status?: 'accepted' | 'in_review' } = {}) {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: home, CREWBOARD_WORKTREE_CONFIG: join(home, 'worktrees.json') }
  const asked: string[] = []
  const h = makeHarness({ cwd: root, env, isTTY: true, now: new Date('2026-09-24T10:00:00Z') })
  h.io.prompt = async (question) => { asked.push(question); return 'y' }
  expect(await run(['init', '--goal', 'Merge'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'a', '--title', 'A'], h.io)).toBe(0)
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, o.file ?? 'a.ts'), 'export const a = 2\n')
  await git(copy, 'add', '-A')
  await git(copy, 'commit', '-q', '-m', 'a')
  await updatePlan(root, (p) => {
    const a = p.tasks.find((t) => t.id === 'a')!
    a.status = o.status ?? 'accepted'
    a.worktree = { path: copy, branch: 'orch/a-a' }
    return p
  })
  h.reset()
  return { root, copy, h, asked, env }
}

it('refuses an agent (no terminal), --yes included, and touches nothing', async () => {
  const { root, env } = await setup()
  const before = await head(root)
  const agent = makeHarness({ cwd: root, env })
  expect(await run(['merge', 'a', '--yes'], agent.io)).toBe(1)
  expect(agent.err()).toContain('if you are a person, run it in a terminal')
  expect(await head(root)).toBe(before)
  expect((await loadPlan(root)).tasks[0]?.merged).toBeUndefined()
})

it('allows an agent to merge only accepted work checked on its latest run, and can repair the recorded target', async () => {
  const { root, env, copy } = await setup()
  await git(root, 'switch', '-q', '-c', 'feature/plan')
  await writeFile(join(root, 'contract.md'), '<task>Implement A</task>\n')
  await updatePlan(root, (p) => {
    const task = p.tasks[0]!
    task.worktree!.base = 'main'
    task.contract = 'contract.md'
    task.runs.push({ runId: 'run_checked', agent: 'codex/gpt-6-luna', startedAt: '2026-09-24T09:00:00Z', finishedAt: '2026-09-24T09:30:00Z', outcome: 'completed' })
    task.check = { state: 'checked', runId: 'run_checked', at: '2026-09-24T09:35:00Z', by: 'orchestrator', note: 'Checks passed' }
    return p
  })
  const agent = makeHarness({ cwd: root, env })
  expect(await run(['merge', 'a', '--auto'], agent.io)).toBe(1)
  expect(await run(['merge', 'a', '--auto', '--into', 'feature/plan', '--json'], agent.io), agent.err() + agent.out()).toBe(0)
  expect(JSON.parse(agent.out())).toMatchObject({ ok: true, into: 'feature/plan' })
  expect((await loadPlan(root)).tasks[0]).toMatchObject({ merged: { into: 'feature/plan' }, worktree: { base: 'feature/plan', path: copy } })
})

it('refuses automatic merge without a checked completed run', async () => {
  const { root, env } = await setup()
  const before = await head(root)
  const agent = makeHarness({ cwd: root, env })
  expect(await run(['merge', 'a', '--auto'], agent.io)).toBe(1)
  expect(agent.err()).toContain('requires accepted work and an orchestrator check')
  expect(await head(root)).toBe(before)
})

it('asks, merges with a merge commit and records it; status no longer lists the task as unmerged', async () => {
  const { root, h, asked } = await setup()
  expect(await run(['merge', 'a'], h.io)).toBe(0)
  expect(asked[0]).toBe(`Merge task a (orch/a-a) into main in ${root} with a merge commit? [y/N] `)
  expect(h.out()).toMatch(/✓ a merged into main: [0-9a-f]{12}/)
  expect(h.out()).toContain('worktree kept: one of the three most recently accepted')
  expect((await loadPlan(root)).tasks[0]?.merged).toMatchObject({ into: 'main', strategy: 'no-ff' })
  h.reset()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).not.toContain('not merged')
})

it('--squash --yes --json merges as one commit and prints the result for scripts', async () => {
  const { root, h, asked } = await setup()
  expect(await run(['merge', 'a', '--squash', '--yes', '--json'], h.io)).toBe(0)
  expect(asked).toEqual([])
  const out = JSON.parse(h.out())
  expect(out).toMatchObject({ ok: true, taskId: 'a', into: 'main', strategy: 'squash', branch: 'orch/a-a' })
  expect(out.commit).toBe(await head(root))
  expect(await run(['merge', 'a', '--squash', '--no-ff'], h.io)).toBe(2)
})

it('refuses a conflicting merge with the paths (text and JSON) and leaves the checkout as it was', async () => {
  const { root, h } = await setup({ file: 'README.txt' })
  await writeFile(join(root, 'README.txt'), 'main\n')
  await git(root, 'commit', '-q', '-am', 'main moves')
  const before = await head(root)
  expect(await run(['merge', 'a', '--yes'], h.io)).toBe(1)
  expect(h.err()).toContain('Merging task a into main would conflict in 1 files: README.txt. Nothing was changed.')
  h.reset()
  expect(await run(['merge', 'a', '--yes', '--json'], h.io)).toBe(1)
  expect(JSON.parse(h.out())).toMatchObject({ ok: false, error: 'conflicts', paths: ['README.txt'] })
  expect(await head(root)).toBe(before)
  expect((await git(root, 'status', '--porcelain', '--untracked-files=no')).stdout).toBe('')
})

it('refuses a dirty base and another checked-out branch, in the person\'s language', async () => {
  const { root, h } = await setup()
  await writeFile(join(root, 'README.txt'), 'edit\n')
  expect(await run(['merge', 'a', '--yes'], h.io)).toBe(1)
  expect(h.err()).toContain('main in')
  expect(h.err()).toContain('has uncommitted changes (1): README.txt')
  await git(root, 'checkout', '-q', '--', 'README.txt')
  await git(root, 'switch', '-q', '-c', 'other')
  h.reset()
  expect(await run(['--lang', 'ru', 'merge', 'a', '--yes'], h.io)).toBe(1)
  expect(h.err()).toContain('Задача a сливается в main, а в')
})

it('status shows a task in review that conflicts with main, with a ready Send back text', async () => {
  const { root, h } = await setup({ file: 'README.txt', status: 'in_review' })
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).not.toContain('conflicts with')
  await writeFile(join(root, 'README.txt'), 'main\n')
  await git(root, 'commit', '-q', '-am', 'main moves')
  h.reset()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).toMatch(/◐ a +A · .*⚠ conflicts with main in README\.txt/)
  expect(h.out()).toContain('Conflicts in review (1):')
  expect(h.out()).toContain('crewboard reject a --reason "Bring the branch up to date with main: it conflicts with main in README.txt.')
  h.reset()
  expect(await run(['status', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out()).views[0]).toMatchObject({ conflicts: [{ with: 'base', into: 'main', paths: ['README.txt'] }], sendBack: expect.stringContaining('Merge main into the branch') })
})
