import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Backends } from '../src/orchestration/backends.js'
import { claudeLimitsPath, isClaudeAgent, latestClaudeWeeklyPct } from '../src/cost/claude-limits.js'
import { criticalPath, deriveViews } from '../src/plan/graph.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { LaunchError, launchTask } from '../src/orchestration/launch.js'
import { supersedeTask } from '../src/orchestration/review.js'
import { syncPlan } from '../src/orchestration/sync.js'
import { nodeExec } from '../src/exec.js'

const NOW = new Date('2026-09-22T12:00:00Z')

describe('claude limits', () => {
  it('reads the latest weekly percentage and skips broken rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-cl-'))
    const file = join(dir, 'rate-limits.jsonl')
    await writeFile(file, ['{"ts":"t1","five_hour":10,"seven_day":40.5}', 'garbage', '{"ts":"t2","five_hour":12,"seven_day":null}', '{"ts":"t3","five_hour":13,"seven_day":41.2}', ''].join('\n'))
    expect(await latestClaudeWeeklyPct(file)).toBe(41.2)
    expect(await latestClaudeWeeklyPct(join(dir, 'missing.jsonl'))).toBeUndefined()
    expect(claudeLimitsPath({}, '/h')).toBe('/h/.claude/usage/rate-limits.jsonl')
    expect(claudeLimitsPath({ CREWBOARD_CLAUDE_LIMITS: '/x.jsonl' }, '/h')).toBe('/x.jsonl')
    expect([isClaudeAgent('claude/opus'), isClaudeAgent('claude-opus'), isClaudeAgent('codex')]).toEqual([true, true, false])
  })

  it('records the weekly percentage after a finished claude run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-cl-sync-'))
    const file = join(root, 'limits.jsonl')
    await writeFile(file, '{"ts":"t","five_hour":5,"seven_day":43}\n')
    await initPlan(root, 'g', NOW)
    await updatePlan(root, (p) => {
      p.tasks.push({ ...newTask({ id: 'a', title: 'A' }), runs: [{ runId: 'run_claude-a', agent: 'claude/opus', startedAt: '2026-09-22T11:00:00Z', quotaBeforePct: 41 }] })
      return p
    })
    const backends: Backends = {
      forAgent: async () => ({
        id: 'claude',
        launch: async () => '',
        events: async () => [],
        status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
        steer: async () => {},
        cancel: async () => {},
      }),
          }
    await syncPlan(root, backends, NOW, file)
    expect((await loadPlan(root)).tasks[0]?.runs[0]).toMatchObject({ quotaBeforePct: 41, quotaAfterPct: 43, outcome: 'completed' })
  })
})

describe('superseded tasks', () => {
  it('are shown as superseded, leave the critical path and cannot be launched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-sup-'))
    await initPlan(root, 'g', NOW)
    await updatePlan(root, (p) => {
      p.tasks.push(newTask({ id: 'a', title: 'A' }), newTask({ id: 'b', title: 'B' }))
      return p
    })
    await supersedeTask(root, 'b', 'a', NOW)
    const plan = await loadPlan(root)
    expect(plan.tasks[1]).toMatchObject({ status: 'superseded', notes: [{ type: 'comment', event: { kind: 'superseded', by: 'a' } }] })
    expect(deriveViews(plan).map((v) => v.status)).toEqual(['ready', 'superseded'])
    expect(criticalPath(plan)).toEqual(['a'])
    await expect(supersedeTask(root, 'a', 'zzz', NOW)).rejects.toMatchObject({ code: 'unknown_task' })
    const backends: Backends = { forAgent: async () => Promise.reject(new Error('x')) }
    await expect(
      launchTask({ root, taskId: 'b', agent: 'dsh', skipPreflight: true, backends, exec: nodeExec, env: {}, home: root, now: () => NOW }),
    ).rejects.toMatchObject({ code: 'superseded' })
    await expect(launchTask({ root, taskId: 'b', agent: 'dsh', skipPreflight: true, backends, exec: nodeExec, env: {}, home: root, now: () => NOW })).rejects.toBeInstanceOf(LaunchError)
  })
})
