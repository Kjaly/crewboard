import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { runContractChecks } from '../src/runs/checks-run.js'
import { evidenceRef } from '../src/runs/evidence.js'
import { slotsDir } from '../src/slots/slots.js'
import { prepareWorktree } from '../src/worktree/prepare.js'
import { RecipeSchema } from '../src/worktree/recipe.js'
import { makeRepo } from './git-helpers.js'

// ql1: the baseline and `verify --run-checks` go through the same machine-wide slot as `crewboard slot`.

it('two baselines with one machine slot take turns instead of racing', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, CREWBOARD_CHECK_SLOTS: '1' }
  const rootA = await makeRepo()
  const rootB = await makeRepo()
  const recipe = RecipeSchema.parse({ baseline: 'sleep 0.3 && echo done' })
  const order: string[] = []
  const first = prepareWorktree({ repoRoot: rootA, taskId: 'a', title: 'A', recipe, exec: nodeExec, env }).then((r) => {
    order.push('a')
    return r
  })
  await new Promise((r) => setTimeout(r, 60))
  const second = prepareWorktree({ repoRoot: rootB, taskId: 'b', title: 'B', recipe, exec: nodeExec, env }).then((r) => {
    order.push('b')
    return r
  })
  const [a, b] = await Promise.all([first, second])
  expect(a.baseline?.ok).toBe(true)
  expect(b.baseline?.ok).toBe(true)
  expect(order).toEqual(['a', 'b'])
  // The slot was released after each baseline: nothing is left holding it.
  expect((await readdir(slotsDir(env, env.HOME ?? '')).catch(() => [])).filter((n) => n.endsWith('.lock'))).toHaveLength(0)
})

it('verify --run-checks runs its commands through the same slot', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, CREWBOARD_CHECK_SLOTS: '2' }
  const root = await makeRepo()
  await initPlan(root, 'goal')
  const wt = `${root}-copy`
  await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'orch/t', wt, 'HEAD'])
  await mkdir(join(root, 'contracts'), { recursive: true })
  await writeFile(join(root, 'contracts', 't.md'), '# T\n<checks>\n- echo one\n- echo two\n</checks>\n')
  const answer = 'Result: received\n- echo one — passed\n- echo two — passed\n'
  const RUN = 'run_dsh-slot'
  await mkdir(join(root, '.orchestration', 'runs', RUN), { recursive: true })
  await writeFile(join(root, evidenceRef(RUN)), JSON.stringify({
    version: 1, runId: RUN, worker: 'dsh', contractPath: 'contracts/t.md', finalAnswer: answer, finalAnswerState: 'reported', claimLine: 'Result: received',
    report: { runId: RUN, text: answer, truncated: false },
    files: [], filesState: 'reported', checks: [{ command: 'echo one', state: 'run' }, { command: 'echo two', state: 'run' }], checksState: 'reported', capturedAt: '2026-09-25T09:30:00Z',
  }))
  await updatePlan(root, (p) => {
    p.tasks.push({
      ...newTask({ id: 't', title: 'T', contract: 'contracts/t.md' }),
      status: 'in_review',
      worktree: { path: wt, branch: 'orch/t' },
      runs: [{ runId: RUN, agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:30:00Z', outcome: 'completed', evidence: evidenceRef(RUN) }],
    })
    return p
  })
  const waited: number[] = []
  const record = await runContractChecks({ root, taskId: 't', by: 'person', exec: nodeExec, env, onSlotWaiting: (ahead) => waited.push(ahead) })
  expect(record.checks).toHaveLength(2)
  expect(record.checks.every((c) => c.exitCode === 0)).toBe(true)
  expect((await readdir(slotsDir(env, env.HOME ?? '')).catch(() => [])).filter((n) => n.endsWith('.lock'))).toHaveLength(0)
})
