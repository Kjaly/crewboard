import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildRepoSnapshot, createBackends, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../../cli/src/cli.js'
import { makeHarness } from '../../cli/test/harness.js'
import { inboxItems } from '../src/client/sidebar-model.js'

/**
 * nq1: the terminal and the screen agree on what waits for a person. One repository on disk — checked
 * and unchecked reviews, a decision, a failed run, a background plan that waits — read once by
 * `crewboard attention --json` and once the way the screen builds «Needs you».
 */
it('crewboard attention and the screen\'s «Needs you» list the same items', async () => {
  const root = await makeRepo()
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
  const h = makeHarness({ cwd: root, env, now: new Date('2026-09-24T10:00:00Z') })
  const cli = async (...args: string[]) => expect(await run(args, h.io)).toBe(0)
  await cli('init', '--goal', 'Harness')
  await cli('task', 'add', 'checked', '--title', 'Checked work')
  await cli('task', 'add', 'plain', '--title', 'Unchecked work')
  await cli('task', 'add', 'pick', '--title', 'Pick a name', '--kind', 'decision')
  await cli('task', 'add', 'broke', '--title', 'Broken run')
  await cli('plan', 'new', 'later', '--goal', 'Later work')
  await cli('task', 'add', 'bg', '--title', 'Background review')
  await cli('plan', 'use', 'main')
  await updatePlan(root, (p) => {
    for (const task of p.tasks) {
      if (task.id === 'checked' || task.id === 'plain') task.status = 'in_review'
      if (task.id === 'checked') task.check = { state: 'checked', at: '2026-09-24T09:00:00Z' }
      if (task.id === 'broke') task.runs.push({ runId: 'run_devin-broke', agent: 'devin', startedAt: '2026-09-24T08:00:00Z', finishedAt: '2026-09-24T08:05:00Z', outcome: 'failed' })
    }
    return p
  })
  await updatePlan(root, (p) => {
    for (const task of p.tasks) task.status = 'in_review'
    return p
  }, 5, 'later')

  h.reset()
  await cli('attention', '--json')
  const fromCli = JSON.parse(h.out())

  const snapshot = await buildRepoSnapshot(root, createBackends({ env, home: env.HOME, exec: nodeExec, root }), h.io.now())
  const fromScreen = inboxItems({ generatedAt: h.io.now().toISOString(), workers: [], repos: [snapshot] }).map(({ key: _key, id: _id, repo: _repo, ...item }) => item)

  expect(fromScreen).toEqual(fromCli)
  expect(fromCli.map((i: { kind: string; taskId?: string; planId?: string }) => [i.kind, i.taskId ?? i.planId]).sort()).toEqual([
    ['attention', 'broke'],
    ['decision', 'pick'],
    ['plan', 'later'],
    ['review', 'checked'],
    ['review', 'plain'],
  ])
})
