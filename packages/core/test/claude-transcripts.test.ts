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
    expect(u).toEqual({ calls: 2, inputTokens: 100, outputTokens: 3000, cacheReadTokens: 1_000_000, cacheWriteTokens: 10_000, reasoningTokens: 0, usd: 0.638, source: 'claude_transcript', rateDate: '2026-09-25', priceVersion: 'claude-opus-5/2026-09-25' })
  })

  // cs1: the reworked Claude preset (Sonnet 5 for code, Opus for design/review) needs Sonnet 5 and Fable 5.1 priced too.
  it('prices Claude Sonnet 5 and Claude Fable 5.1 runs', async () => {
    const sonnet = await projects([row('2026-09-25T11:00:00Z', 'm1', 'claude-sonnet-5', [1000, 2000, 3000, 4000])])
    // 1000*2 + 2000*10 + 3000*0.2 + 4000*2.5 = 2000 + 20000 + 600 + 10000 = 32600 per 1M → $0.0326
    expect(await readClaudeTranscriptUsage(sonnet, CWD, { startedAt: '2026-09-25T10:00:00Z' })).toMatchObject({ usd: 0.0326, priceVersion: 'claude-sonnet-5/2026-09-25' })
    const fable = await projects([row('2026-09-25T11:00:00Z', 'm1', 'claude-fable-5-1', [1000, 1000, 1000, 1000])])
    // 1000*10 + 1000*50 + 1000*0.25 + 1000*12.5 = 10000 + 50000 + 250 + 12500 = 72750 per 1M → $0.07275
    expect(await readClaudeTranscriptUsage(fable, CWD, { startedAt: '2026-09-25T10:00:00Z' })).toMatchObject({ usd: 0.07275, priceVersion: 'claude-fable-5-1/2026-09-25' })
  })

  // cs1 (orchestrator follow-up): the owner's reworked preset launches claude/opus-5-5 workers — Opus 5.5 needs
  // its own row, distinct from and cheaper than Opus 5, not silently priced at the older rate.
  it('prices Claude Opus 5.5 runs, distinctly from Opus 5', async () => {
    const opus55 = await projects([row('2026-09-25T11:00:00Z', 'm1', 'claude-opus-5-5', [1000, 1000, 1000, 1000])])
    // 1000*4 + 1000*20 + 1000*0.2 + 1000*5 = 4000 + 20000 + 200 + 5000 = 29200 per 1M → $0.0292
    expect(await readClaudeTranscriptUsage(opus55, CWD, { startedAt: '2026-09-25T10:00:00Z' })).toMatchObject({ usd: 0.0292, priceVersion: 'claude-opus-5-5/2026-09-25' })
  })

  it('prices a dated snapshot of a known model from its base id (exact-then-family)', async () => {
    const dated = await projects([row('2026-09-25T11:00:00Z', 'm1', 'claude-sonnet-5-20260601', [1000, 2000, 3000, 4000])])
    // Same rate as plain claude-sonnet-5: 2000 + 20000 + 600 + 10000 = 32600 per 1M → $0.0326
    expect(await readClaudeTranscriptUsage(dated, CWD, { startedAt: '2026-09-25T10:00:00Z' })).toMatchObject({ usd: 0.0326, priceVersion: 'claude-sonnet-5-20260601/2026-09-25' })
  })

  it('never falls back across minor versions: an unlisted minor version stays unpriced', async () => {
    // claude-opus-5-6 looks like it could be "family opus-5", but it is not a dated snapshot (no 8-digit
    // suffix) and it is not the exact opus-5-5 row either — it must stay unknown, never silently priced as Opus 5.
    const dir = await projects([row('2026-09-25T11:00:00Z', 'm1', 'claude-opus-5-6', [1000, 1000, 1000, 1000])])
    const u = await readClaudeTranscriptUsage(dir, CWD, { startedAt: '2026-09-25T10:00:00Z' })
    expect(u).toMatchObject({ source: 'claude_transcript' })
    expect(u).not.toHaveProperty('usd')
  })

  it('gives tokens without money for unpriced models and nothing when there is no transcript', async () => {
    const dir = await projects([row('2026-09-22T11:00:00Z', 'm1', 'claude-haiku-4-5-20251001', [10, 20, 30, 40])])
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

  // cs1: a Codex run under a subscription (no usd of its own) is priced from its tokens instead of staying unknown.
  it('prices a Codex run from its tokens when the CLI reported none of its own', async () => {
    const codexRun = { runId: 'run_codex-a', agent: 'codex/gpt-6-sol', model: 'gpt-6-sol', startedAt: '2026-09-25T10:00:00Z' }
    const codexBackend = { id: 'codex', usage: async () => ({ calls: 1, inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, reasoningTokens: 0, source: 'codex_cli' }) } as unknown as RunBackend
    // gpt-6-sol: 1000*2 + 1000*10 = 12_000 per 1M → $0.012
    expect(await usageForRun(codexBackend, codexRun, undefined, '/nowhere')).toMatchObject({ apiEquivalentUsd: 0.012, source: 'codex_rate_estimate', priceVersion: 'gpt-6-sol/2026-09-25' })
    // The CLI's own reported usd is never overridden by the estimate.
    const priced = { id: 'codex', usage: async () => ({ calls: 1, inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.9, source: 'codex_cli' }) } as unknown as RunBackend
    const withUsd = await usageForRun(priced, codexRun, undefined, '/nowhere')
    expect(withUsd).toMatchObject({ usd: 0.9 })
    expect(withUsd).not.toHaveProperty('apiEquivalentUsd')
    // An unlisted Codex model stays unpriced.
    const codexBackend2 = { id: 'codex', usage: async () => ({ calls: 1, inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, reasoningTokens: 0, source: 'codex_cli' }) } as unknown as RunBackend
    expect(await usageForRun(codexBackend2, { ...codexRun, agent: 'codex/gpt-5.5', model: 'gpt-5.5' }, undefined, '/nowhere')).not.toHaveProperty('apiEquivalentUsd')
  })
})
