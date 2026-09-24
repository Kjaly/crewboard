import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Backends, type RawEvent, type RunBackend, initPlan, newTask, updatePlan } from '@crewboard/core'
import { actionRoutes } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'
import type { PlanCost, RunStepSummary, Trajectory } from '../src/shared/types.js'

const NOW = new Date('2026-09-22T12:10:00Z')
const A = '/crewboard/api'

const EVENTS: RawEvent[] = [
  { ts: '2026-09-22T12:00:00Z', type: 'turn_started', data: { turn: 1, text: 'сделай' } },
  { ts: '2026-09-22T12:00:10Z', type: 'tool_started', data: { tool: 'bash', status: 'running', input: { command: 'pnpm test' }, callId: 'c1' } },
  { ts: '2026-09-22T12:00:40Z', type: 'tool_completed', data: { tool: 'bash', status: 'completed', callId: 'c1' } },
  { ts: '2026-09-22T12:00:50Z', type: 'turn_ended', data: { turn: 1, stopReason: 'success' } },
]

function fakeRes() {
  const res = {
    body: '',
    status: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status
      res.headers = headers
      return res
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk
    },
  }
  return res
}

async function setup(statuses: Record<string, { status: string; terminal: boolean; exitCode: number | null; finishedAt?: string }> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orch-insight-'))
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({
      ...newTask({ id: 'a', title: 'Первая' }),
      status: 'accepted',
      notes: [{ at: '2026-09-22T12:05:00Z', type: 'accept', text: 'ок' }],
      runs: [
        { runId: 'run_dsh-a1', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z', finishedAt: '2026-09-22T12:01:00Z', outcome: 'completed' },
        { runId: 'run_dsh-a2', agent: 'claude-opus', startedAt: '2026-09-22T12:02:00Z', finishedAt: '2026-09-22T12:03:00Z', outcome: 'completed', quotaBeforePct: 40, quotaAfterPct: 42.5 },
      ],
    })
    p.tasks.push(newTask({ id: 'b', title: 'Без запусков' }))
    return p
  })
  let eventReads = 0
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-new',
    events: async (id) => { eventReads++; return id === 'run_dsh-legacy-cost' ? [...EVENTS, { ts: '2026-09-22T12:00:50Z', type: 'usage', data: { total_cost_usd: 0.25 } }] : EVENTS },
    status: async (id) => statuses[id] ?? { status: 'completed', terminal: true, exitCode: 0 },
    steer: async () => {},
    cancel: async () => {},
    usage: async () => ({ calls: 2, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 0, usd: 0.25 }),
  }
  const backends: Backends = { forAgent: async (_agent, id) => id === 'run_codex-missing' || id === 'run_dsh-legacy-cost' ? { ...backend, usage: async () => undefined } : backend }
  const native: Native = { confirm: async () => true, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home: root, now: () => NOW })
  const call = async (url: string) => {
    const pathname = url.split('?')[0]
    const route = routes.find((r) => r.path === pathname)
    if (!route) throw new Error(`no route ${pathname}`)
    const res = fakeRes()
    const req = Readable.from([]) as unknown as IncomingMessage
    Object.assign(req, { method: 'GET', url, headers: {} })
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; error?: string; value?: unknown } }
  }
  return { root, call, q: `repo=${encodeURIComponent(root)}`, eventReads: () => eventReads }
}

describe('GET /api/cost', () => {
  it('I3 carries a stable decision association and typed verdict', async () => {
    const { root, call, q } = await setup()
    await updatePlan(root, (plan) => { plan.tasks[0]!.notes[0]!.verdict = { kind: 'disputed', mismatch: 'claim_missing' }; plan.tasks[0]!.reviewIntervals = [{ id: 'review:run_dsh-a2', enteredAt: '2026-09-22T12:03:00Z', decidedAt: '2026-09-22T12:05:00Z', runId: 'run_dsh-a2', source: 'human', association: 'exact', decision: 'accepted' }]; return plan })
    const value = (await call(`${A}/cost?${q}`)).json.value as PlanCost
    expect(value.tasks?.[0]?.decisions[0]).toMatchObject({ id: 'decision:a:0', verdict: 'disputed' })
    expect(value.tasks?.[0]?.reviewIntervals[0]?.decisionId).toBe('decision:a:0')
  })
  it('I1 resolves a completed earlier attempt from backend terminal state', async () => {
    const { root, call, q } = await setup({ 'run_dsh-a1': { status: 'completed', terminal: true, exitCode: 0, finishedAt: '2026-09-22T12:01:00Z' } })
    await updatePlan(root, (plan) => { delete plan.tasks[0]!.runs[0]!.finishedAt; return plan })
    const value = (await call(`${A}/cost?${q}`)).json.value as PlanCost
    expect(value.runs[0]).toMatchObject({ finishedAt: '2026-09-22T12:01:00Z', durationSec: 60, executionOutcome: 'completed', terminalProvenance: 'backend' })
    expect(value.tasks?.[0]?.workerSec).toBe(120)
  })
  it('I8 omits step overviews and reuses completed summary reads', async () => {
    const fixture = await setup()
    const first = (await fixture.call(`${A}/cost?${fixture.q}`)).json.value as PlanCost
    const reads = fixture.eventReads()
    const second = (await fixture.call(`${A}/cost?${fixture.q}`)).json.value as PlanCost
    expect(second.runs.every((run) => run.overview === undefined)).toBe(true)
    expect(fixture.eventReads()).toBe(reads)
    expect(JSON.stringify(first).length).toBeLessThan(5000)
  })
  it('I8 keeps a 500-run host summary bounded and cached', async () => {
    const fixture = await setup()
    await updatePlan(fixture.root, (plan) => { plan.tasks[0]!.runs = Array.from({ length: 500 }, (_, index) => ({ runId: `run_dsh-bench-${index}`, agent: 'dsh', startedAt: '2026-09-22T12:00:00Z', finishedAt: '2026-09-22T12:01:00Z', outcome: 'completed' as const })); return plan })
    const started = performance.now()
    const first = await fixture.call(`${A}/cost?${fixture.q}`)
    const firstMs = performance.now() - started
    const bytes = Buffer.byteLength(JSON.stringify(first.json.value))
    const warmStart = performance.now()
    const second = await fixture.call(`${A}/cost?${fixture.q}`)
    const warmMs = performance.now() - warmStart
    if (process.env.CREWBOARD_BENCH ?? process.env.ORCH_BENCH) console.log(`I8 500 host runs: cold=${firstMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms bytes=${bytes}`)
    expect((first.json.value as PlanCost).runs).toHaveLength(500)
    expect((second.json.value as PlanCost).runs).toHaveLength(500)
    expect(bytes).toBeLessThan(450_000)
    expect(fixture.eventReads()).toBe(0)
  })
  it('I8 retains legacy event money when no usage adapter record exists', async () => {
    const { root, call, q } = await setup()
    await updatePlan(root, (plan) => { plan.tasks[0]!.runs = [{ runId: 'run_dsh-legacy-cost', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z', finishedAt: '2026-09-22T12:01:00Z', outcome: 'completed' }]; return plan })
    const value = (await call(`${A}/cost?${q}`)).json.value as PlanCost
    expect(value.runs[0]?.cashUsd?.value).toBe(0.25)
  })
  it('I5 leaves missing task cash and equivalents absent', async () => {
    const { root, call, q } = await setup()
    await updatePlan(root, (plan) => { plan.tasks[0]!.runs = [{ runId: 'run_codex-missing', agent: 'codex/gpt-6-sol', startedAt: '2026-09-22T12:00:00Z', finishedAt: '2026-09-22T12:01:00Z', outcome: 'completed' }]; return plan })
    const value = (await call(`${A}/cost?${q}`)).json.value as PlanCost
    expect(value.tasks?.[0]?.accounting.cashUsd).toBeUndefined()
    expect(value.tasks?.[0]?.accounting.apiEquivalentUsd).toBeUndefined()
    expect(value.tasks?.[0]?.accounting.cashEligibleRuns).toBe(0)
  })
  it('returns one row per run with plan coordinates, per-agent totals and acceptance moments', async () => {
    const { call, q } = await setup()
    const res = await call(`${A}/cost?${q}`)
    expect(res.status).toBe(200)
    const value = res.json.value as PlanCost
    expect(value.runs).toHaveLength(2)
    expect(value.runs[0]).toMatchObject({
      runId: 'run_dsh-a1',
      taskId: 'a',
      taskTitle: 'Первая',
      agent: 'dsh',
      startedAt: '2026-09-22T12:00:00Z',
      finishedAt: '2026-09-22T12:01:00Z',
      durationSec: 60,
      cashUsd: { value: 0.25 },
    })
    expect(value.runs[1]).toMatchObject({ agent: 'claude/opus', rawAgent: 'claude-opus', quotaDeltaPct: 2.5 })
    expect(Object.keys(value.totals).sort()).toEqual(['claude/opus', 'dsh'])
    expect(value.totals.dsh).toMatchObject({ runs: 1, durationSec: 60, cashUsd: 0.25 })
    expect(value.accepted).toEqual([{ taskId: 'a', at: '2026-09-22T12:05:00Z' }])
  })
})

describe('GET /api/trace', () => {
  it('I3 does not infer return or run wait from a later attempt and task-only acceptance', async () => {
    const { call, q } = await setup()
    const trace = (await call(`${A}/trace?${q}&id=a&run=run_dsh-a1`)).json.value as Trajectory
    expect(trace.reviewOutcome).toBeUndefined()
    expect(trace.humanWaitMs).toBeUndefined()
  })
  it('builds the trajectory of the last run, or of the named one', async () => {
    const { call, q } = await setup()
    const res = await call(`${A}/trace?${q}&id=a`)
    expect(res.status).toBe(200)
    const trace = res.json.value as Trajectory
    expect(trace.totals).toMatchObject({ turns: 1, toolCalls: 1 })
    expect(trace.spans.filter((s) => s.lane === 'tools')).toEqual([
      { lane: 'tools', label: 'pnpm test', start: Date.parse('2026-09-22T12:00:10Z'), end: Date.parse('2026-09-22T12:00:40Z') },
    ])
    expect(trace.spans.length).toBeLessThanOrEqual(400)
    expect(trace.records?.some((record) => record.kind === 'check' && record.label === 'pnpm test')).toBe(true)
    expect(trace.totalSteps).toBe(trace.records?.length)
    expect(trace.retainedRange).toMatchObject({ from: 1, to: trace.totalSteps, total: trace.totalSteps })
    expect(trace.completeness).toBe('complete')
    const stepId = trace.records?.[0]?.stepId
    expect(stepId).toBeTruthy()
    const seek = await call(`${A}/trace?${q}&id=a&seek=${encodeURIComponent(stepId ?? '')}`)
    expect((seek.json.value as Trajectory).records?.[0]?.stepId).toBe(stepId)
    expect(await call(`${A}/trace?${q}&id=a&seek=missing`)).toMatchObject({ status: 404, json: { error: 'unknown_step' } })
    expect(trace.cost).toMatchObject({ runId: 'run_dsh-a2' })
    const named = await call(`${A}/trace?${q}&id=a&run=run_dsh-a1`)
    expect(named.status).toBe(200)
  })

  it('answers 404 for an unknown task, an unknown run and a task that never ran', async () => {
    const { call, q } = await setup()
    expect(await call(`${A}/trace?${q}&id=zzz`)).toMatchObject({ status: 404, json: { error: 'unknown_task' } })
    expect(await call(`${A}/trace?${q}&id=a&run=run_dsh-nope`)).toMatchObject({ status: 404, json: { error: 'unknown_run' } })
    expect(await call(`${A}/trace?${q}&id=b`)).toMatchObject({ status: 404, json: { error: 'unknown_run' } })
  })
})

describe('GET /api/run-steps', () => {
  it('builds each strip from ledger kinds, caches finished runs and leaves GET cost free of events', async () => {
    const fixture = await setup()
    await fixture.call(`${A}/cost?${fixture.q}`)
    const before = fixture.eventReads()
    const first = (await fixture.call(`${A}/run-steps?${fixture.q}&runs=run_dsh-a1,run_dsh-a2,unknown`)).json.value as Record<string, RunStepSummary>
    expect(Object.keys(first).sort()).toEqual(['run_dsh-a1', 'run_dsh-a2'])
    // turn_started → request (H), bash `pnpm test` → check (C); placed by elapsed time.
    expect(first['run_dsh-a1']).toMatchObject({ timing: 'elapsed', problems: 0, completeness: 'complete' })
    expect(first['run_dsh-a1']!.counts.request).toBe(1)
    expect(first['run_dsh-a1']!.strip).toMatch(/^H/)
    expect(first['run_dsh-a1']!.strip).toContain('C')
    const reads = fixture.eventReads()
    expect(reads).toBeGreaterThan(before)
    await fixture.call(`${A}/run-steps?${fixture.q}&runs=run_dsh-a1,run_dsh-a2`)
    expect(fixture.eventReads()).toBe(reads)
  })
})
