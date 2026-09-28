import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Backends } from '../src/orchestration/backends.js'
import type { RunBackend } from '../src/backend/types.js'
import { planningCosts } from '../src/cost/planning-cost.js'

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'orch-planning-'))
  return root
}

async function writeJob(root: string, id: string, job: unknown) {
  const dir = join(root, '.orchestration', 'draft-runs', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'job.json'), JSON.stringify(job))
}

describe('planningCosts (cs1)', () => {
  it('reports draft and repair attempts as their own kind, outside any task', async () => {
    const root = await repo()
    await writeJob(root, 'dj-a', {
      id: 'dj-a', status: 'completed', source: { name: 'spec.md', hash: 'h' }, agent: 'claude/opus', createdAt: '2026-09-25T09:00:00Z', updatedAt: '2026-09-25T09:05:00Z',
      attempts: [
        { runId: 'run_draft-1', kind: 'draft', agent: 'claude/opus', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:03:00Z', outcome: 'completed', isolation: 'read_only' },
        { runId: 'run_repair-1', kind: 'repair', agent: 'claude/opus', startedAt: '2026-09-25T09:03:00Z', finishedAt: '2026-09-25T09:05:00Z', outcome: 'completed', isolation: 'read_only' },
      ],
    })
    const backends: Backends = {
      async forAgent() {
        return {
          id: 'claude',
          events: async () => [],
          usage: async (runId: string) => ({ calls: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 0, usd: runId === 'run_draft-1' ? 0.1 : 0.2 }),
        } as unknown as RunBackend
      },
    }
    const costs = await planningCosts(root, backends, '/nowhere')
    expect(costs).toHaveLength(2)
    expect(costs.map((c) => [c.jobId, c.jobKind, c.runId, c.apiEquivalentUsd?.value])).toEqual([
      ['dj-a', 'draft', 'run_draft-1', 0.1],
      ['dj-a', 'repair', 'run_repair-1', 0.2],
    ])
  })

  it('gives no rows for a repository with no draft jobs', async () => {
    const root = await repo()
    const backends: Backends = { async forAgent() { throw new Error('not called') } }
    expect(await planningCosts(root, backends, '/nowhere')).toEqual([])
  })
})
