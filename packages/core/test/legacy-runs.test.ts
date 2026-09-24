import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGACY_CACHE_NAME, LEGACY_STEER_OVERRIDE, createLegacyRuns, legacySteerRoot } from '../src/runs/legacy-runs.js'
import { normalize } from '../src/runs/normalize.js'
import { createBackends } from '../src/orchestration/backends.js'
import { runCost } from '../src/cost/cost.js'
import { buildTrajectory } from '../src/runs/trajectory.js'
import { nodeExec } from '../src/exec.js'

const ID = 'run_amber-otter-4f21'

describe('saved run artifacts', () => {
  it('locates cache roots and reads state, events, trace input and cost data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-older-run-'))
    const root = join(home, 'cache')
    const run = join(root, 'runs', ID)
    const artifacts = join(run, 'artifacts')
    await mkdir(join(artifacts, 'normalized'), { recursive: true })
    await writeFile(join(run, 'meta.json'), JSON.stringify({ run_id: ID, agent_id: 'devin', backend: 'devin-cli', status: 'running', artifacts_dir: artifacts, started_at: '2026-09-22T10:00:00Z', finished_at: '2026-09-22T10:01:00Z', exit_code: 0 }))
    await writeFile(join(run, 'state.json'), JSON.stringify({ run_id: ID, status: 'completed' }))
    await writeFile(join(artifacts, 'normalized', 'devin.jsonl'), [
      { ts: '2026-09-22T10:00:00Z', type: 'tool_started', data: 'Read file' },
      { ts: '2026-09-22T10:00:01Z', type: 'answer_delta', data: 'Done' },
      { ts: '2026-09-22T10:00:02Z', type: 'future_event', data: { cost_usd: 0.1 } },
    ].map((e) => JSON.stringify(e)).join('\n'))
    expect(legacySteerRoot({}, home, 'darwin')).toBe(join(home, 'Library', 'Caches', LEGACY_CACHE_NAME, 'steer'))
    expect(legacySteerRoot({ XDG_CACHE_HOME: '/xdg' }, home, 'linux')).toBe(join('/xdg', LEGACY_CACHE_NAME, 'steer'))
    const reader = createLegacyRuns({ [LEGACY_STEER_OVERRIDE]: root }, home)
    expect(await reader.status(ID)).toMatchObject({ status: 'completed', terminal: true, exitCode: 0, finishedAt: '2026-09-22T10:01:00Z' })
    const events = await reader.events(ID)
    expect(events.map((e) => e.type)).toEqual(['tool_started', 'answer_delta', 'progress'])
    expect(normalize(events).map((e) => e.kind)).toEqual(['action', 'message', 'action'])
    expect(JSON.stringify(events)).toContain('cost_usd')
    const backends = createBackends({ env: { [LEGACY_STEER_OVERRIDE]: root }, home, root: home, exec: nodeExec })
    const fromPlan = await backends.forAgent('devin', ID)
    expect((await fromPlan.events(ID)).map((e) => e.type)).toEqual(events.map((e) => e.type))
    expect(buildTrajectory(events, { startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:01:00Z' }, new Date('2026-09-22T10:01:00Z')).spans.length).toBeGreaterThan(0)
    expect(runCost({ runId: ID, agent: 'devin', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:01:00Z' }, events).usd).toBe(0.1)
  })

  it('reports missing history without crashing and refuses every mutation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-older-empty-'))
    const reader = createLegacyRuns({ [LEGACY_STEER_OVERRIDE]: join(home, 'missing') }, home)
    expect(await reader.status(ID)).toMatchObject({ status: 'history_unavailable', terminal: false })
    expect(await reader.events(ID)).toEqual([])
    await expect(reader.steer(ID, '/tmp/note')).rejects.toMatchObject({ code: 'legacy_run_read_only' })
    await expect(reader.cancel(ID)).rejects.toMatchObject({ code: 'legacy_run_read_only' })
    await expect(reader.launch({ agent: 'devin', promptFile: '/tmp/task', cwd: home })).rejects.toMatchObject({ code: 'legacy_run_read_only' })
  })
})
