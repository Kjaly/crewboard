import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { type Backends, buildRepoSnapshot, createBackends, type NeedsYouItem, nodeExec, updatePlan, waitingCounts } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../../cli/src/cli.js'
import { makeHarness } from '../../cli/test/harness.js'
import { createReviewCenter } from '../src/client/notify.js'
import { snapshotWaiting } from '../src/client/review.js'
import { RepoSidebar } from '../src/client/sidebar.js'
import { inboxCount, inboxItems } from '../src/client/sidebar-model.js'
import { ReviewView } from '../src/client/views/review.js'
import { scopeText, waitingOf } from '../src/client/waiting.js'
import { OrchestraService } from '../src/host/service.js'
import { orchestraTools } from '../src/host/tools.js'
import type { OrchestraSnapshot } from '../src/shared/types.js'

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')

/**
 * at2 (B25): one state on disk — a checked review, a review without the orchestrator check (no orchestrator chat), a
 * decision and a failed run in the open plan, a background plan with a review — read by every surface that counts waiting work. Each says the same numbers: 4 in this plan, 5 in all.
 * (The rendered header chip reads the same `waitingOf` and `scopeText`; app.test and where-it-waits render it.)
 */
it('the same state yields the same waiting counts on every surface', async () => {
  const root = await makeRepo()
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
  const now = new Date('2026-09-25T10:00:00Z')
  const h = makeHarness({ cwd: root, env, now })
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
      if (task.id === 'checked') task.check = { state: 'checked', at: '2026-09-25T09:00:00Z' }
      if (task.id === 'broke') task.runs.push({ runId: 'run_devin-broke', agent: 'devin', startedAt: '2026-09-25T08:00:00Z', finishedAt: '2026-09-25T08:05:00Z', outcome: 'failed' })
    }
    return p
  })
  await updatePlan(root, (p) => {
    for (const task of p.tasks) task.status = 'in_review'
    return p
  }, 5, 'later')

  const repo = await buildRepoSnapshot(root, createBackends({ env, home: env.HOME, exec: nodeExec, root }), now)
  const snapshot: OrchestraSnapshot = { generatedAt: now.toISOString(), workers: [], repos: [repo] }
  const open = { root, planId: repo.planId }
  const expected = { plan: 4, all: 5 }
  expect(waitingOf(snapshot, open)).toMatchObject(expected)

  // `crewboard attention`: its rows count the same, and its first line names the scope and the reasons.
  h.reset()
  await cli('attention', '--json')
  const rows = JSON.parse(h.out()) as NeedsYouItem[]
  expect(waitingCounts(rows, open)).toMatchObject(expected)
  h.reset()
  await cli('attention')
  expect(h.out().split('\n')[0]).toBe('Waiting on you: in this plan 4 · in this repository 5 — 2 tasks wait for review · 1 review without the orchestrator check · 1 decision · 1 run failed or stalled')

  // The orchestrator's `orchestra_attention` tool returns the same rows.
  const backends: Backends = createBackends({ env, home: env.HOME, exec: nodeExec, root })
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => now })
  const tool = orchestraTools({ service, repos: [root], backendsFor: () => backends, env, home: env.HOME as string, now: () => now }).find((t) => t.name === 'orchestra_attention')!
  expect(waitingCounts((await tool.execute({})) as NeedsYouItem[], open)).toMatchObject(expected)

  // The sidebar: its heading and the collapsed-rail dot.
  expect(inboxCount(inboxItems(snapshot, open))).toBe(5)
  const sidebar = renderToStaticMarkup(<RepoSidebar snapshot={snapshot} repo={repo} open onToggle={() => {}} />)
  expect(text(sidebar)).toContain('Review queue · in this plan 4 · all 5')

  // The tab title, the favicon and the icon badge: the review centre's number, the one the title controller is given.
  const title = vi.fn()
  const center = createReviewCenter({ onFeed: (state) => title(state.waiting, state.failed) })
  center.feed(snapshot)
  expect(title).toHaveBeenLastCalledWith(5, 1)
  expect(snapshotWaiting(snapshot)).toBe(5)
  // The toast says the open plan's arrivals by the same reasons (a failed run is the macOS channel's news, not a toast).
  expect(center.getState().toasts.map((toast) => toast.items.map((item) => item.reason))).toEqual([['review', 'checkOff', 'decision']])

  // The review chip's label, and Review's band: the plan's number, its reasons and the same scope.
  expect(scopeText(waitingOf(snapshot, open))).toBe('in this plan 4 · all 5')
  const review = renderToStaticMarkup(
    <ReviewView repo={repo} workers={[]} selectedId={null} onSelect={() => {}} density="overview" now={now} cost={{ generatedAt: now.toISOString(), runs: [], totals: {}, accepted: [], tasks: [] }} waiting={waitingOf(snapshot, open)} />,
  )
  const band = text(review.slice(review.indexOf('orc-needs'), review.indexOf('</section>', review.indexOf('orc-needs'))))
  expect(band).toContain('1 task waits for review · 1 review without the orchestrator check · 1 decision · 1 run failed or stalled')
  expect(band).toContain('in this plan 4 · all 5')
  expect(review).toMatch(/orc-needs__count[^>]*>4</)
})
