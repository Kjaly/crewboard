import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { claudeProjectSlug, claudeProjectsDir, readClaudeTranscriptUsage } from '../src/cost/claude-transcripts.js'
import { usageForRun } from '../src/cost/run-usage.js'

const CWD = '/Users/me/work/crewboard-orch-q3'
const row = (ts: string, id: string, model: string, u: [number, number, number, number]) =>
  JSON.stringify({ timestamp: ts, cwd: CWD, message: { id, model, usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } } })

async function projects(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-cc-'))
  const project = join(dir, claudeProjectSlug(CWD))
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'session-1.jsonl'), `${lines.join('\n')}\nnot json\n`)
  return dir
}

describe('claude transcripts', () => {
  it('builds the project slug and directory like Claude Code', () => {
    expect(claudeProjectSlug('/Users/dev/projects/crewboard-orch-q3')).toBe('-Users-dev-projects-crewboard-orch-q3')
    expect(claudeProjectSlug('/tmp/a_b.c')).toBe('-tmp-a-b-c')
    expect(claudeProjectsDir({}, '/h')).toBe('/h/.claude/projects')
    expect(claudeProjectsDir({ CREWBOARD_CLAUDE_PROJECTS: '/x' }, '/h')).toBe('/x')
  })

  it('sums unique messages inside the run window and prices known models', async () => {
    const dir = await projects([
      row('2026-09-22T10:00:00Z', 'm0', 'claude-opus-5', [1, 1, 1, 1]),
      row('2026-09-22T11:00:00Z', 'm1', 'claude-opus-5', [100, 1000, 1_000_000, 10_000]),
      row('2026-09-22T11:00:01Z', 'm1', 'claude-opus-5', [100, 1000, 1_000_000, 10_000]),
      row('2026-09-22T11:30:00Z', 'm2', 'claude-opus-5', [0, 2000, 0, 0]),
    ])
    const u = await readClaudeTranscriptUsage(dir, CWD, { startedAt: '2026-09-22T10:30:00Z', finishedAt: '2026-09-22T12:00:00Z' })
    // 100*5 + 3000*25 + 1_000_000*0.5 + 10_000*6.25 = 500 + 75_000 + 500_000 + 62_500 = 638_000 per 1M → $0.638
    expect(u).toEqual({ calls: 2, inputTokens: 100, outputTokens: 3000, cacheReadTokens: 1_000_000, cacheWriteTokens: 10_000, reasoningTokens: 0, usd: 0.638, source: 'claude_transcript', rateDate: '2026-09-22', priceVersion: 'claude-opus-5/2026-09-22' })
  })

  it('gives tokens without money for unpriced models and nothing when there is no transcript', async () => {
    const dir = await projects([row('2026-09-22T11:00:00Z', 'm1', 'claude-sonnet-5', [10, 20, 30, 40])])
    expect(await readClaudeTranscriptUsage(dir, CWD, { startedAt: '2026-09-22T10:00:00Z' })).toEqual({ calls: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 0, source: 'claude_transcript' })
    expect(await readClaudeTranscriptUsage(dir, '/nowhere', { startedAt: '2026-09-22T10:00:00Z' })).toBeUndefined()
  })

  it('prefers the backend usage and falls back to transcripts only for claude runs', async () => {
    const dir = await projects([row('2026-09-22T11:00:00Z', 'm1', 'claude-opus-5', [0, 1000, 0, 0])])
    const run = { runId: 'run_x', agent: 'claude-opus', startedAt: '2026-09-22T10:00:00Z' }
    const bare = { id: 'legacy' } as unknown as RunBackend
    expect(await usageForRun(bare, run, CWD, dir)).toMatchObject({ outputTokens: 1000, usd: 0.025 })
    expect(await usageForRun(bare, { ...run, agent: 'devin' }, CWD, dir)).toBeUndefined()
    expect(await usageForRun(bare, run, undefined, dir)).toBeUndefined()
    const withUsage = { id: 'dsh', usage: async () => ({ calls: 9, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }) } as unknown as RunBackend
    expect(await usageForRun(withUsage, run, CWD, dir)).toMatchObject({ calls: 9 })
  })
})
