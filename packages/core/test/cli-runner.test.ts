import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cliKindOf, cliModel } from '../src/backend/types.js'
import { createBackends, resolveProfile } from '../src/orchestration/backends.js'
import { nodeExec } from '../src/exec.js'
import { createCliBackend } from '../src/runs/cli-backend.js'
import { type CliRunnerArgs, runCliRun } from '../src/runs/cli-runner.js'
import { normalize } from '../src/runs/normalize.js'
import { readSteer, steerMailName, writeSteer } from '../src/runs/steers.js'
import { readRunEvents } from '../src/dsh/runner.js'

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

async function prepare(kind: 'claude' | 'codex', prompt: string) {
  const runDir = await mkdtemp(join(tmpdir(), `orch-cli-${kind}-`))
  const promptFile = join(runDir, 'prompt.md')
  await writeFile(promptFile, prompt)
  const log = join(runDir, 'argv.log')
  process.env.FAKE_CLI_LOG = log
  const args: CliRunnerArgs = { kind, runDir, cwd: runDir, promptFile, command: process.execPath, commandArgs: [kind === 'claude' ? FAKE_CLAUDE : FAKE_CODEX], model: kind === 'claude' ? 'opus' : 'gpt-5.6-sol' }
  return { runDir, args, argv: async () => (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as string[]) }
}
const mail = (runDir: string, name: string, text = '') => writeFile(join(runDir, 'mailbox', name), text)
const later = (ms: number, fn: () => Promise<unknown>) => new Promise((r) => setTimeout(() => fn().then(r, r), ms))
/** Waits until the runner has started its first turn: a fixed delay raced the process start under load. */
const whenTurnStarted = async (runDir: string, fn: () => Promise<unknown>) => {
  for (let i = 0; i < 400; i++) {
    const events = await readFile(join(runDir, 'events.jsonl'), 'utf8').catch(() => '')
    if (events.includes('"turn_started"')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  return fn()
}
const whenTurnEnded = async (runDir: string, fn: () => Promise<unknown>) => {
  for (let i = 0; i < 400; i++) {
    const events = await readFile(join(runDir, 'events.jsonl'), 'utf8').catch(() => '')
    if (events.includes('"turn_ended"')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  return fn()
}
const STEER = '11111111-1111-4111-8111-111111111111'
/** Records a direction and drops it in the mailbox under the name the backends really write (13-digit timestamp). */
const steer = async (runDir: string, file: string, text: string, mode: 'auto' | 'queue' | 'interrupt') => {
  const at = new Date().toISOString()
  await writeSteer(runDir, { id: STEER, createdAt: at, mode, preview: text, file, state: 'queued', timestamps: { queued: at } })
  await mail(runDir, steerMailName(STEER), text)
}

describe('runCliRun: claude', () => {
  it('runs one turn and records session, tools and money', async () => {
    const { runDir, args, argv } = await prepare('claude', 'build it')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed', exitCode: 0, sessionId: 'sess-1', usage: { calls: 1, inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50, usd: 0.1 } })
    expect((await argv())[0]).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'opus']))
    const feed = normalize(await readRunEvents(runDir))
    expect(feed.map((e) => e.kind)).toEqual(['message', 'file', 'message'])
  })

  it('delivers a steer written mid-turn inside that turn, acknowledges it and finishes the run', async () => {
    // Real Claude Code folds a mid-turn user message into the running turn: one `result` for two messages (st1, rg1 run).
    const { runDir, args, argv } = await prepare('claude', 'SLOW first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'and add tests', 'auto'))])
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 1 } })
    expect((await argv())[0]).toContain('--replay-user-messages')
    const events = await readRunEvents(runDir)
    expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(1)
    expect(events.find((e) => e.type === 'steer')?.data).toBe('and add tests')
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'acknowledged' })
  })

  it('V-st1/queued-steer-next-turn holds a queued direction until the turn ends, sends it as the next turn, then finishes', async () => {
    const { runDir, args } = await prepare('claude', 'SLOW first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'and add tests', 'queue'))])
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 2, usd: 0.2 } })
    const events = await readRunEvents(runDir)
    expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(2)
    const sentAt = events.findIndex((e) => e.type === 'steer')
    expect(sentAt).toBeGreaterThan(events.findIndex((e) => e.type === 'turn_ended'))
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'acknowledged', timestamps: { sent: expect.any(String), acknowledged: expect.any(String) } })
  })

  it('V-st1/steer-after-last-turn does not keep the run open and records the direction as abandoned', async () => {
    const { runDir, args } = await prepare('claude', 'LINGER build it')
    const [state] = await Promise.all([runCliRun(args), whenTurnEnded(runDir, () => steer(runDir, args.promptFile, 'too late', 'queue'))])
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 1 } })
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'abandoned', reason: 'run_finished' })
  })

  it('V-st1/stop-after-final-report finishes as completed when the last turn ended successfully', async () => {
    const { runDir, args } = await prepare('claude', 'LINGER build it')
    const [state] = await Promise.all([runCliRun(args), whenTurnEnded(runDir, () => mail(runDir, 'cancel'))])
    expect(state).toMatchObject({ status: 'completed', exitCode: 0 })
  })

  it('stops a run mid-turn as cancelled and abandons the direction it still held', async () => {
    const { runDir, args } = await prepare('claude', 'SLOW first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, async () => { await steer(runDir, args.promptFile, 'later', 'queue'); await later(300, () => mail(runDir, 'cancel')) })])
    expect(state).toMatchObject({ status: 'cancelled', exitCode: 130 })
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'abandoned', reason: 'cancelled' })
  })
})

describe('runCliRun: codex', () => {
  it('runs one turn with the workspace-write sandbox and uncached token accounting', async () => {
    const { runDir, args, argv } = await prepare('codex', 'build it')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed', sessionId: 'th-1', usage: { calls: 1, inputTokens: 200, cacheReadTokens: 800, outputTokens: 50, reasoningTokens: 5 } })
    expect((await argv())[0]).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', 'gpt-5.6-sol', 'build it'])
    const feed = normalize(await readRunEvents(runDir))
    expect(feed).toEqual([
      expect.objectContaining({ kind: 'action', text: 'cat b.txt' }),
      expect.objectContaining({ kind: 'file', text: 'b.txt' }),
      expect.objectContaining({ kind: 'message', text: 'answer to: build it' }),
    ])
  })

  it('interrupts a turn on steer and resumes the same thread with the correction', async () => {
    const { runDir, args, argv } = await prepare('codex', 'SLOW first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'fix the test', 'auto'))])
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 1 } })
    expect((await readSteer(runDir, '11111111-1111-4111-8111-111111111111'))?.state).toBe('acknowledged')
    const calls = await argv()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-m', 'gpt-5.6-sol', 'th-1', 'fix the test'])
  })

  it('V-st1/codex-queue lets the running turn finish and sends a queued direction as the next turn', async () => {
    const { runDir, args, argv } = await prepare('codex', 'SLOW first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'fix the test', 'queue'))])
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 2 } })
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'acknowledged' })
    expect((await argv()).at(-1)?.at(-1)).toBe('fix the test')
  })

  it('cancels a running turn', async () => {
    const { runDir, args } = await prepare('codex', 'SLOW first')
    const [state] = await Promise.all([runCliRun(args), later(400, () => mail(runDir, 'cancel'))])
    expect(state).toMatchObject({ status: 'cancelled', exitCode: 130 })
  })
})

describe('cli backends', () => {
  it('I2 treats zero-initialized state as pending before the first usage observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-cli-initial-'))
    const id = 'run_claude-initial'
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, id)))
    await writeFile(join(root, id, 'state.json'), JSON.stringify({ status: 'running', exitCode: null, startedAt: '2026-09-23T10:00:00Z', pid: process.pid, usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }))
    const usage = await createCliBackend({ kind: 'claude', runsRoot: root }).usage?.(id)
    expect(usage).toMatchObject({ pending: true, availability: { input: { state: 'pending' }, cacheWrite: { state: 'pending' } } })
  })
  it('routes claude/… and codex/… agents and resolves their profiles', async () => {
    expect([cliKindOf('claude/opus'), cliKindOf('codex/gpt-5.6-sol'), cliKindOf('claude-opus'), cliKindOf('dsh')]).toEqual(['claude', 'codex', undefined, undefined])
    expect([cliModel('claude/opus'), cliModel('codex/'), cliModel('dsh')]).toEqual(['opus', undefined, undefined])
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const b = createBackends({ env: {}, home, exec: nodeExec, root: home })
    expect((await b.forAgent('claude/opus')).id).toBe('claude')
    expect((await b.forAgent('codex/gpt-5.6-terra')).id).toBe('codex')
    expect(await resolveProfile({}, home, 'codex/gpt-5.6-sol')).toEqual({ id: 'codex/gpt-5.6-sol', backend: 'codex-cli', model: 'gpt-5.6-sol', enabled: true })
    expect(await resolveProfile({}, home, 'claude/opus')).toMatchObject({ backend: 'claude-code', model: 'opus' })
  })

  it('launches through the backend and reports usage', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-runs-'))
    const promptFile = join(runsRoot, 'p.md')
    await writeFile(promptFile, 'build it')
    const backend = createCliBackend({ kind: 'claude', runsRoot, command: process.execPath, commandArgs: [FAKE_CLAUDE], startRunner: (a) => runCliRun(a) })
    const runId = await backend.launch({ agent: 'claude/opus', promptFile, cwd: runsRoot })
    expect(runId).toMatch(/^run_claude-[a-z0-9]+$/)
    expect(await backend.status(runId)).toMatchObject({ status: 'completed', terminal: true })
    expect(await backend.usage?.(runId)).toMatchObject({ sessionId: 'sess-1', calls: 1, inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50, reasoningTokens: 0, usd: 0.1, availability: { cacheWrite: { value: 50, state: 'known', final: true } } })
  })
})
