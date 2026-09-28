import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

/**
 * Golden fixture for cs1: two plans in one repository (`main`, `sprint2`), two dsh-billed runs on
 * different days and classes in `main`, one in `sprint2`, plus a draft job outside any plan. A second
 * repository (built the same way) exercises `--all-repos`.
 */
async function billRecord(file: string, record: Record<string, unknown>) {
  await appendFile(file, `${JSON.stringify(record)}\n`)
}

async function dshRun(root: string, runId: string, sessionId: string) {
  await mkdir(join(root, '.orchestration', 'runs', runId), { recursive: true })
  await writeFile(join(root, '.orchestration', 'runs', runId, 'state.json'), JSON.stringify({ status: 'completed', exitCode: 0, startedAt: '2026-09-20T00:00:00Z', pid: process.pid, sessionId }))
}

async function buildRepo(env: NodeJS.ProcessEnv, billFile: string) {
  const root = await makeRepo()
  const h = makeHarness({ cwd: root, env, now: new Date('2026-09-25T12:00:00Z') })
  expect(await run(['init', '--goal', 'cs1 fixture'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'Task one', '--class', 'code'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't2', '--title', 'Task two', '--class', 'design'], h.io)).toBe(0)
  expect(await run(['plan', 'new', 'sprint2', '--goal', 'second plan'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't3', '--title', 'Task three', '--class', 'review', '--plan', 'sprint2'], h.io)).toBe(0)
  // `plan new` switches the current plan to the one it created; the fixture's default plan stays `main`.
  expect(await run(['plan', 'use', 'main'], h.io)).toBe(0)

  // `makeRepo()` always returns `<tmp>/repo`, so the path itself is not unique enough to key session ids by.
  const tag = Math.random().toString(36).slice(2, 8)
  const rid = (suffix: string) => `run_dsh-${tag}${suffix}`
  const t1 = rid('t1a')
  const t2 = rid('t2a')
  const t3 = rid('t3a')
  await dshRun(root, t1, `${t1}-s`)
  await dshRun(root, t2, `${t2}-s`)
  await dshRun(root, t3, `${t3}-s`)
  await billRecord(billFile, { sessionId: `${t1}-s`, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.1, priced: true })
  await billRecord(billFile, { sessionId: `${t2}-s`, inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.2, priced: true })
  await billRecord(billFile, { sessionId: `${t3}-s`, inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.05, priced: true })

  await updatePlan(root, (p) => {
    const task1 = p.tasks.find((t) => t.id === 't1')!
    task1.runs.push({ runId: t1, agent: 'dsh/deepseek-flash', startedAt: '2026-09-20T10:00:00Z', finishedAt: '2026-09-20T10:05:00Z', outcome: 'completed' })
    const task2 = p.tasks.find((t) => t.id === 't2')!
    task2.runs.push({
      runId: t2, agent: 'dsh/deepseek-flash', effort: 'high', startedAt: '2026-09-21T09:00:00Z', finishedAt: '2026-09-21T09:10:00Z', outcome: 'completed',
      quotaSamples: [
        { sampleId: `${t2}-q1`, accountKey: 'acct', provider: 'claude', windowId: '5h', beforePct: 10, afterPct: 20, attribution: 'exclusive' },
        { sampleId: `${t2}-q2`, accountKey: 'acct', provider: 'claude', windowId: 'week', beforePct: 30, afterPct: 33, attribution: 'exclusive' },
      ],
    })
    return p
  }, 5, 'main')
  await updatePlan(root, (p) => {
    const task3 = p.tasks.find((t) => t.id === 't3')!
    task3.runs.push({ runId: t3, agent: 'dsh/deepseek-flash', startedAt: '2026-09-22T08:00:00Z', finishedAt: '2026-09-22T08:02:00Z', outcome: 'completed' })
    return p
  }, 5, 'sprint2')

  const draftId = `dj-${tag}`
  const draftRunId = `run_dsh-${draftId}a`
  await dshRun(root, draftRunId, `${draftRunId}-s`)
  await billRecord(billFile, { sessionId: `${draftRunId}-s`, inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.02, priced: true })
  await mkdir(join(root, '.orchestration', 'draft-runs', draftId), { recursive: true })
  await writeFile(
    join(root, '.orchestration', 'draft-runs', draftId, 'job.json'),
    JSON.stringify({
      id: draftId, status: 'completed', source: { name: 'spec.md', hash: 'h' }, agent: 'dsh/deepseek-flash', createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T07:00:00Z',
      attempts: [{ runId: draftRunId, kind: 'draft', agent: 'dsh/deepseek-flash', startedAt: '2026-09-20T07:00:00Z', finishedAt: '2026-09-20T07:02:00Z', outcome: 'completed', isolation: 'read_only' }],
    }),
  )
  h.reset()
  return { root, h }
}

async function homeEnv(): Promise<{ env: NodeJS.ProcessEnv; billFile: string }> {
  const home = await mkdtemp(join(tmpdir(), 'orch-cost-home-'))
  const billFile = join(home, '.dsh', 'dsh-bill', 'records.jsonl')
  await mkdir(join(home, '.dsh', 'dsh-bill'), { recursive: true })
  await writeFile(billFile, '')
  return { env: { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: home }, billFile }
}

describe('crewboard cost (cs1)', () => {
  it('reads only a supplied rollout diagnostic and refuses incompatible cost filters', async () => {
    const root = await makeRepo()
    const file = join(root, 'explicit-rollout.jsonl')
    await writeFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 90 }, last_token_usage: { input_tokens: 10, cached_input_tokens: 8 } } } }))
    const h = makeHarness({ cwd: root })
    expect(await run(['cost', '--codex-rollout', file], h.io), h.err()).toBe(0)
    expect(JSON.parse(h.out())).toMatchObject({ actor: 'external_orchestrator', provenance: { file }, unallocatedBaseline: { inputTokens: 100 }, latest: { lastInputTokens: 10, lastCachedInputTokens: 8 }, cash: 'unavailable', quota: 'unavailable' })
    h.reset()
    expect(await run(['cost', '--codex-rollout', file, '--since', '2026-09-28'], h.io)).toBe(1)
    expect(h.out()).toBe('')
  })
  it('shows bound orchestrator usage separately from worker totals and labels lifetime scope', async () => {
    const { env, billFile } = await homeEnv()
    const { root, h } = await buildRepo(env, billFile)
    await writeFile(join(root, '.orchestration', 'chats.json'), JSON.stringify({ main: { sessionId: 'root-chat', wake: true, boundAt: '2026-09-20T00:00:00Z' } }))
    await billRecord(billFile, { sessionId: 'root-chat', inputTokens: 0, outputTokens: 4 })
    expect(await run(['cost', '--json'], h.io)).toBe(0)
    const result = JSON.parse(h.out())
    expect(result.totals['dsh/deepseek-flash'].runs).toBe(2)
    expect(result.orchestrator).toMatchObject({ actor: 'orchestrator', scope: 'session_lifetime', coverage: { bound: 1, observed: 1 }, sessions: [{ metrics: { input: { value: 0, state: 'known' }, cacheWrite: { state: 'unavailable' } } }] })
    h.reset()
    expect(await run(['cost'], h.io)).toBe(0)
    expect(h.out()).toContain('session lifetime')
    expect(h.out()).toContain('cache write unavailable')
  })

  it('shows orchestrator status even when there are no worker or planning runs', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root, now: new Date('2026-09-25T12:00:00Z') })
    expect(await run(['init', '--goal', 'empty costs'], h.io)).toBe(0)
    h.reset()
    expect(await run(['cost'], h.io)).toBe(0)
    expect(h.out()).toContain('Orchestrator: unavailable (no bound dsh session)')
  })

  it('groups the current plan by worker, task, class, effort and day, each a distinct slice', async () => {
    const { env, billFile } = await homeEnv()
    const { h } = await buildRepo(env, billFile)

    expect(await run(['cost', '--by', 'worker', '--json'], h.io)).toBe(0)
    const byWorker = JSON.parse(h.out())
    expect(byWorker.by).toBe('worker')
    expect(byWorker.slices['dsh/deepseek-flash']).toMatchObject({ runs: 2, cashUsd: 0.3 })
    expect(byWorker.runs).toHaveLength(2)
    expect(byWorker.runs.every((r: { planId: string }) => r.planId === 'main')).toBe(true)
    expect(byWorker.runs.map((r: { taskId: string }) => r.taskId).sort()).toEqual(['t1', 't2'])

    h.reset()
    expect(await run(['cost', '--by', 'task', '--json'], h.io)).toBe(0)
    const byTask = JSON.parse(h.out())
    expect(byTask.slices.t1).toMatchObject({ runs: 1, cashUsd: 0.1 })
    expect(byTask.slices.t2).toMatchObject({ runs: 1, cashUsd: 0.2 })

    h.reset()
    expect(await run(['cost', '--by', 'class', '--json'], h.io)).toBe(0)
    const byClass = JSON.parse(h.out())
    expect(byClass.slices.code).toMatchObject({ runs: 1, cashUsd: 0.1 })
    expect(byClass.slices.design).toMatchObject({ runs: 1, cashUsd: 0.2 })

    h.reset()
    expect(await run(['cost', '--by', 'effort', '--json'], h.io)).toBe(0)
    const byEffort = JSON.parse(h.out())
    expect(byEffort.slices.default).toMatchObject({ runs: 1, cashUsd: 0.1 })
    expect(byEffort.slices.high).toMatchObject({ runs: 1, cashUsd: 0.2 })

    h.reset()
    expect(await run(['cost', '--by', 'day', '--json'], h.io)).toBe(0)
    const byDay = JSON.parse(h.out())
    expect(byDay.slices['2026-09-20']).toMatchObject({ runs: 1, cashUsd: 0.1 })
    expect(byDay.slices['2026-09-21']).toMatchObject({ runs: 1, cashUsd: 0.2 })
  })

  it('groups by plan across --all-plans, and keeps --by plan/worker text lines distinct per plan', async () => {
    const { env, billFile } = await homeEnv()
    const { h } = await buildRepo(env, billFile)
    expect(await run(['cost', '--all-plans', '--by', 'plan', '--json'], h.io)).toBe(0)
    const byPlan = JSON.parse(h.out())
    expect(byPlan.slices.main).toMatchObject({ runs: 2, cashUsd: 0.3 })
    expect(byPlan.slices.sprint2).toMatchObject({ runs: 1, cashUsd: 0.05 })

    h.reset()
    expect(await run(['cost', '--all-plans', '--by', 'worker'], h.io)).toBe(0)
    expect(h.out()).toContain('dsh/deepseek-flash: 3 run(s)')
  })

  it('filters by --since/--until and keeps the Planning line separate from task totals', async () => {
    const { env, billFile } = await homeEnv()
    const { h } = await buildRepo(env, billFile)

    // Default text output (no --by): unchanged per-worker line, plus a distinct Planning line.
    expect(await run(['cost'], h.io)).toBe(0)
    const text = h.out()
    expect(text).toContain('dsh/deepseek-flash: 2 run(s)')
    expect(text).toContain('cash $0.3')
    expect(text).toMatch(/^Planning: 1 run\(s\).*cash \$0\.02/m)

    h.reset()
    expect(await run(['cost', '--since', '2026-09-21', '--by', 'day', '--json'], h.io)).toBe(0)
    const since = JSON.parse(h.out())
    expect(Object.keys(since.slices)).toEqual(['2026-09-21'])
    expect(since.slices['2026-09-21']).toMatchObject({ cashUsd: 0.2 })
    // The draft attempt (2026-09-20) is outside the range: no Planning row.
    expect(since.planning).toEqual([])

    // A bare `--until` date is the end of that whole day (inclusive), like `--since` is its start.
    h.reset()
    expect(await run(['cost', '--until', '2026-09-21', '--by', 'day', '--json'], h.io)).toBe(0)
    const until = JSON.parse(h.out())
    expect(Object.keys(until.slices).sort()).toEqual(['2026-09-20', '2026-09-21'])
    expect(until.planning).toHaveLength(1)

    h.reset()
    expect(await run(['cost', '--until', '2026-09-20', '--by', 'day', '--json'], h.io)).toBe(0)
    const untilStrict = JSON.parse(h.out())
    expect(Object.keys(untilStrict.slices)).toEqual(['2026-09-20'])
  })

  it('keeps quota per window instead of summing across windows', async () => {
    const { env, billFile } = await homeEnv()
    const { h } = await buildRepo(env, billFile)
    expect(await run(['cost', '--by', 'task', '--json'], h.io)).toBe(0)
    const byTask = JSON.parse(h.out())
    expect(byTask.slices.t2.quotaWindows).toEqual(
      expect.arrayContaining([
        { provider: 'claude', accountKey: 'acct', windowId: '5h', deltaPct: 10 },
        { provider: 'claude', accountKey: 'acct', windowId: 'week', deltaPct: 3 },
      ]),
    )
    h.reset()
    expect(await run(['cost', '--by', 'task'], h.io)).toBe(0)
    expect(h.out()).toMatch(/t2:.*quota 5h \+10%, week \+3%/)
  })

  it('emits a CSV header and one row per slice, plus the Planning row', async () => {
    const { env, billFile } = await homeEnv()
    const { h } = await buildRepo(env, billFile)
    expect(await run(['cost', '--csv', '--by', 'task'], h.io)).toBe(0)
    const lines = h.out().trim().split('\n')
    expect(lines[0]).toBe('key,runs,minutes,cashUsd,apiEquivalentUsd,quotaWindows,tokensInput,tokensOutput,tokensCacheRead,tokensReasoning,pendingRuns')
    expect(lines.find((l) => l.startsWith('t1,'))).toBe('t1,1,5,0.1,,,100,20,0,0,')
    expect(lines.find((l) => l.startsWith('t2,'))).toBe('t2,1,10,0.2,,"5h +10%, week +3%",200,40,0,0,')
    expect(lines.find((l) => l.startsWith('planning,'))).toBe('planning,1,2,0.02,,,30,5,0,0,')
  })

  it('combines two repositories under --all-repos and tags each row with its repository', async () => {
    const home = await homeEnv()
    const first = await buildRepo(home.env, home.billFile)
    const second = await buildRepo(home.env, home.billFile)
    const elsewhere = makeHarness({ cwd: await mkdtemp(join(tmpdir(), 'orch-cost-nowhere-')), env: home.env })
    expect(await run(['cost', '--all-repos', '--by', 'worker', '--json'], elsewhere.io)).toBe(0)
    const out = JSON.parse(elsewhere.out())
    expect(out.slices['dsh/deepseek-flash']).toMatchObject({ runs: 4, cashUsd: 0.6 })
    const repos = new Set(out.runs.map((r: { repo: string }) => r.repo))
    expect(repos).toEqual(new Set([first.root, second.root]))
    expect(out.planning).toHaveLength(2)
  })

  it('refuses conflicting flags', async () => {
    const { env, billFile } = await homeEnv()
    const { h } = await buildRepo(env, billFile)
    const refused = async (args: string[], pattern: RegExp) => {
      h.reset()
      expect(await run(['cost', ...args], h.io)).not.toBe(0)
      expect(h.err()).toMatch(pattern)
    }
    await refused(['--json', '--csv'], /--json and --csv/)
    await refused(['--plan', 'main', '--all-plans'], /--all-plans/)
    await refused(['--plan', 'main', '--all-repos'], /--all-repos/)
    await refused(['--by', 'nonsense'], /--by/)
    await refused(['--since', 'not-a-date'], /--since/)
  })
})
