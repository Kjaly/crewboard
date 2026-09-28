import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildRepoSnapshot, createBackends, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../../cli/src/cli.js'
import { makeHarness } from '../../cli/test/harness.js'
import { createReviewCenter } from '../src/client/notify.js'
import { snapshotWaiting } from '../src/client/review.js'
import { inboxCount, inboxItems, planCounts, repoEntry, sidebarTree } from '../src/client/sidebar-model.js'
import { createAttentionNotifier } from '../src/host/notify.js'
import type { OrchestraSnapshot } from '../src/shared/types.js'

/**
 * ny1: `crewboard plan archive main` in a hub whose only plan is `main` leaves it current. Its waiting
 * work — reviews, a decision, a failed run — must still vanish from «Needs you», the terminal and every count.
 */
it('an archived plan, even the only (current) one, waits on nobody; unarchived, it comes back', async () => {
  const root = await makeRepo()
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
  const h = makeHarness({ cwd: root, env, now: new Date('2026-09-24T10:00:00Z') })
  const cli = async (...args: string[]) => expect(await run(args, h.io)).toBe(0)
  await cli('init', '--goal', 'Hub')
  await cli('task', 'add', 'plain', '--title', 'Unchecked work')
  await cli('task', 'add', 'pick', '--title', 'Pick a name', '--kind', 'decision')
  await cli('task', 'add', 'broke', '--title', 'Broken run')
  await updatePlan(root, (p) => {
    for (const task of p.tasks) {
      if (task.id === 'plain') task.status = 'in_review'
      if (task.id === 'broke') task.runs.push({ runId: 'run_devin-broke', agent: 'devin', startedAt: '2026-09-24T08:00:00Z', finishedAt: '2026-09-24T08:05:00Z', outcome: 'failed' })
    }
    return p
  })
  const backends = createBackends({ env, home: env.HOME, exec: nodeExec, root })
  const read = async (): Promise<{ cli: unknown[]; snapshot: OrchestraSnapshot }> => {
    h.reset()
    await cli('attention', '--json')
    const repo = await buildRepoSnapshot(root, backends, h.io.now())
    return { cli: JSON.parse(h.out()), snapshot: { generatedAt: h.io.now().toISOString(), workers: [], repos: [repo] } }
  }
  const counts = (snapshot: OrchestraSnapshot) => {
    const entry = repoEntry(snapshot.repos[0]!)
    const center = createReviewCenter()
    center.feed(snapshot)
    return {
      inbox: inboxCount(inboxItems(snapshot)),
      badge: snapshotWaiting(snapshot),
      repo: { waiting: entry.waiting, attention: entry.attention },
      group: sidebarTree(snapshot, Date.parse(snapshot.generatedAt)).repos.map((group) => [group.waiting, group.attention]),
      rows: entry.plans.map((plan) => planCounts(plan)),
      title: [center.getState().waiting, center.getState().failed],
    }
  }
  const waiting = await read()
  expect(waiting.cli).toHaveLength(3)
  // at2: one waiting number — the sidebar heading and the badge agree (the failed run counts once, in both).
  // The tree row reads the plan's own progress: only the presented decision is a person's move, so the
  // row's waiting count is 1 while the legacy «Needs you» queue still holds the plain review.
  expect(counts(waiting.snapshot)).toMatchObject({ inbox: 3, badge: 3, repo: { waiting: 1, attention: 1 }, title: [3, 1] })

  await cli('plan', 'archive', 'main')
  const archived = await read()
  expect(archived.snapshot.repos[0]).toMatchObject({ planId: 'main', archived: true, plans: [expect.objectContaining({ id: 'main', current: true, archived: true })] })
  // The screen still shows the plan's tasks and states when it is opened.
  expect(archived.snapshot.repos[0]!.tasks.map((task) => [task.id, task.status])).toEqual([['plain', 'in_review'], ['pick', 'ready'], ['broke', 'ready']])
  expect(archived.cli).toEqual([])
  expect(inboxItems(archived.snapshot, { root, planId: 'main' })).toEqual([])
  expect(counts(archived.snapshot)).toEqual({ inbox: 0, badge: 0, repo: { waiting: 0, attention: 0 }, group: [[0, 0]], rows: [{ running: 0, waiting: 0, failed: 0, checking: 0, unmerged: 0 }], title: [0, 0] })

  // Notifications: nothing new appears on the archived snapshot (the orchestrator's chat: chat.test.ts).
  const notifier = createAttentionNotifier(() => {})
  notifier({ ...archived.snapshot, repos: [] })
  expect(notifier(archived.snapshot)).toEqual([])

  await cli('plan', 'unarchive', 'main')
  const restored = await read()
  expect(restored.snapshot.repos[0]).not.toHaveProperty('archived')
  // `at` moves: archiving touches the plan.
  const rows = (items: unknown[]) => items.map((item) => ({ ...(item as object), at: undefined }))
  expect(rows(restored.cli)).toEqual(rows(waiting.cli))
  expect(counts(restored.snapshot)).toEqual(counts(waiting.snapshot))
})
