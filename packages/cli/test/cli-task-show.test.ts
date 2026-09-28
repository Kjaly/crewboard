import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { type Backends, clearConflictCache, getTaskShow, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// ts1 (B26): `task show <id>` — everything about a task in one command, built on the task panel's detail.

const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])
const RUN = 'run_dsh-a1'
const REPORT = 'Result: received\nAdded a.ts\n\n## Checks\n- pnpm test — green'

beforeEach(() => clearConflictCache())

async function setup(o: { file?: string; status?: 'accepted' | 'in_review' | 'ready'; outcome?: 'completed' | 'failed' } = {}) {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: home, CREWBOARD_WORKTREE_CONFIG: join(home, 'worktrees.json') }
  const h = makeHarness({ cwd: root, env, now: new Date('2026-09-25T10:00:00Z') })
  expect(await run(['init', '--goal', 'Show'], h.io)).toBe(0)
  await mkdir(join(root, 'contracts'), { recursive: true })
  await writeFile(join(root, 'contracts', 'a.md'), '# A\n\n<checks>\n- pnpm test\n- pnpm lint\n</checks>\n')
  expect(await run(['task', 'add', 'a', '--title', 'Add a', '--contract', 'contracts/a.md', '--class', 'code'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'b', '--title', 'Use a', '--deps', 'a', '--contract', 'contracts/a.md'], h.io)).toBe(0)
  const copy = join(root, '..', 'repo-orch-a')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/a-a', copy, 'HEAD')
  await writeFile(join(copy, o.file ?? 'a.ts'), 'export const a = 2\n')
  await git(copy, 'add', '-A')
  await git(copy, 'commit', '-q', '-m', 'a')
  const evidence = `.orchestration/runs/${RUN}/evidence.json`
  await mkdir(join(root, '.orchestration', 'runs', RUN), { recursive: true })
  await writeFile(join(root, evidence), JSON.stringify({
    version: 1, runId: RUN, worker: 'dsh', finalAnswer: REPORT, finalAnswerState: 'reported',
    report: { runId: RUN, text: REPORT, source: 'final', truncated: false }, claimLine: 'Result: received',
    files: [{ path: o.file ?? 'a.ts', added: 1, deleted: 0 }], filesState: 'reported', checks: [], checksState: 'reported', uncommitted: 0, capturedAt: '2026-09-25T09:30:00Z',
  }))
  const outcome = o.outcome ?? 'completed'
  await updatePlan(root, (p) => {
    const a = p.tasks.find((t) => t.id === 'a')!
    a.status = o.status ?? 'in_review'
    a.worker = 'dsh'
    a.worktree = { path: copy, branch: 'orch/a-a', base: 'main' }
    a.runs = [{ runId: RUN, agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:30:00Z', outcome, ...(outcome === 'completed' ? { evidence } : {}) }]
    a.check = { state: 'checked', runId: RUN, at: '2026-09-25T09:40:00Z', by: 'orchestrator', note: 'pnpm test green on the stand' }
    a.notes.push({ at: '2026-09-25T09:45:00Z', type: 'comment', text: 'Looks right to me' })
    return p
  })
  h.reset()
  return { root, copy, h, env }
}

const noBackends: Backends = { forAgent: async () => { throw new Error('no backend') } }

it('shows a task in review: sections in text, the full structure in JSON — the same getTaskShow gives the tool', async () => {
  const { root, copy, h } = await setup()
  expect(await run(['task', 'show', 'a'], h.io)).toBe(0)
  const text = h.out()
  expect(text).toContain('a · Add a\n  kind implement · class code · status in_review · worker dsh\n  needed by b')
  expect(text).toContain(`Worktree\n  path ${copy}\n  branch orch/a-a, base main\n  1 files, +1 −0 against main\n    a.ts  +1 −0`)
  expect(text).toContain('Merge\n  no conflicts with its base or other tasks in review')
  expect(text).toContain(`Last run\n  ${RUN} · dsh · completed at 2026-09-25 09:30Z`)
  expect(text).toContain(`Report\n  Result: received\n  Added a.ts\n  ## Checks\n  - pnpm test — green\n  full report: .orchestration/runs/${RUN}/evidence.json`)
  expect(text).toContain('Verdict\n  result')
  expect(text).toContain('Orchestrator check\n  checked by orchestrator at 2026-09-25 09:40Z\n  pnpm test green on the stand')
  expect(text).toContain('Looks right to me')
  expect(text).toContain('Contract\n  contracts/a.md\n  checks:\n    - pnpm test\n    - pnpm lint')
  h.reset()
  expect(await run(['task', 'show', 'a', '--json'], h.io)).toBe(0)
  const json = JSON.parse(h.out())
  expect(json).toMatchObject({
    id: 'a', title: 'Add a', kind: 'implement', class: 'code', status: 'in_review', worker: 'dsh', planId: 'main', dependents: ['b'],
    worktree: { path: copy, branch: 'orch/a-a', base: 'main' },
    diffstat: { base: 'main', files: [{ path: 'a.ts', added: 1, deleted: 0 }], insertions: 1, deletions: 0, source: 'git' },
    mergeState: { state: 'in_review', conflicts: [] },
    lastRun: { runId: RUN, outcome: 'completed' },
    report: { text: REPORT }, reportFile: `.orchestration/runs/${RUN}/evidence.json`,
    verdict: { kind: 'result' },
    check: { state: 'checked', note: 'pnpm test green on the stand' },
    contract: { path: 'contracts/a.md' }, checks: ['pnpm test', 'pnpm lint'],
  })
  // One assembly (ts1): the CLI prints what core gives the orchestrator's tool.
  const direct = JSON.parse(JSON.stringify(await getTaskShow(root, 'a', noBackends, nodeExec)))
  // Each read observes the live worktree at its own instant; that timestamp is intentionally volatile.
  expect(Number.isFinite(Date.parse(json.currentGit.observedAt))).toBe(true)
  expect(Number.isFinite(Date.parse(direct.currentGit.observedAt))).toBe(true)
  delete json.currentGit.observedAt
  delete direct.currentGit.observedAt
  expect(json).toEqual(direct)
})

it('names a conflict with the base of a task in review', async () => {
  const { root, h } = await setup({ file: 'README.txt' })
  await writeFile(join(root, 'README.txt'), 'main\n')
  await git(root, 'commit', '-q', '-am', 'main moves')
  expect(await run(['task', 'show', 'a'], h.io)).toBe(0)
  expect(h.out()).toContain('Merge\n  ⚠ conflicts with main in README.txt')
  h.reset()
  expect(await run(['task', 'show', 'a', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out()).mergeState).toEqual({ state: 'in_review', conflicts: [{ with: 'base', into: 'main', paths: ['README.txt'] }] })
})

it('shows accepted work not merged with the commands, and the paths a merge would conflict on', async () => {
  const { root, h } = await setup({ status: 'accepted' })
  expect(await run(['task', 'show', 'a'], h.io)).toBe(0)
  expect(h.out()).toContain(`Merge\n  accepted, not merged into main; to merge by hand:\n    git -C ${root} merge --no-ff orch/a-a\n  or, after the same checks: crewboard merge a`)
  h.reset()
  expect(await run(['task', 'show', 'b'], h.io)).toBe(0)
  expect(h.out()).toContain('depends on a · waiting for a to be merged')
  h.reset()
  expect(await run(['task', 'show', 'a', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out()).mergeState).toEqual({ state: 'unmerged', into: 'main', branch: 'orch/a-a', commands: [`git -C ${root} merge --no-ff orch/a-a`], conflicts: [] })
  h.reset()
  const other = await setup({ status: 'accepted', file: 'README.txt' })
  await writeFile(join(other.root, 'README.txt'), 'main\n')
  await git(other.root, 'commit', '-q', '-am', 'main moves')
  expect(await run(['task', 'show', 'a'], other.h.io)).toBe(0)
  expect(other.h.out()).toContain('⚠ merging into main would conflict in 1 files: README.txt')
  other.h.reset()
  expect(await run(['task', 'show', 'a', '--json'], other.h.io)).toBe(0)
  expect(JSON.parse(other.h.out()).mergeState).toMatchObject({ state: 'unmerged', conflicts: ['README.txt'] })
})

it('shows a failed run and a blocked task, in text and JSON', async () => {
  const { h } = await setup({ status: 'ready', outcome: 'failed' })
  expect(await run(['task', 'show', 'a'], h.io)).toBe(0)
  expect(h.out()).toContain(`Last run\n  ${RUN} · dsh · failed at 2026-09-25 09:30Z`)
  expect(h.out()).toContain('Report\n  no report yet')
  h.reset()
  expect(await run(['task', 'show', 'a', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out())).toMatchObject({ status: 'ready', lastRun: { runId: RUN, outcome: 'failed' } })
  h.reset()
  expect(await run(['task', 'show', 'b'], h.io)).toBe(0)
  expect(h.out()).toContain('b · Use a\n  kind implement · status blocked · worker: the preset decides\n  depends on a · waiting for a')
  expect(h.out()).toContain('Worktree\n  no worktree')
  expect(h.out()).toContain('Last run\n  no runs yet')
  expect(h.out()).not.toContain('\nMerge\n')
  h.reset()
  expect(await run(['task', 'show', 'b', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out())).toMatchObject({ id: 'b', status: 'blocked', deps: ['a'], blockedBy: ['a'], mergeState: { state: 'none' }, checks: ['pnpm test', 'pnpm lint'] })
})

it('refuses a missing task with a sentence, and a missing id with the usage', async () => {
  const { h } = await setup()
  expect(await run(['task', 'show', 'zzz'], h.io)).toBe(1)
  expect(h.err()).toBe('No task zzz.\n')
  h.reset()
  expect(await run(['--lang', 'ru', 'task', 'show', 'zzz', '--json'], h.io)).toBe(1)
  expect(h.err()).toBe('Нет задачи zzz.\n')
  h.reset()
  expect(await run(['task', 'show'], h.io)).toBe(2)
  expect(h.err()).toContain('Usage: crewboard task show <id> [--plan id] [--json]')
})
