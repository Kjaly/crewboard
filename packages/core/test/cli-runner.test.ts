import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
import { finalMessage } from '../src/runs/report.js'
import { readSteer, steerMailName, writeSteer } from '../src/runs/steers.js'
import { readRunEvents } from '../src/dsh/runner.js'
import { evaluateRun } from '../src/watch/rules.js'
import { runCost } from '../src/cost/cost.js'
import { makeRepo } from './git-helpers.js'

// The API-only route needs a configured key for the happy-path Claude runs; the fake CLI makes no call. The
// conflicting sources are cleared so a developer's own shell cannot turn these tests into policy refusals.
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test'
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
delete process.env.ANTHROPIC_BASE_URL
delete process.env.CLAUDE_CODE_USE_BEDROCK
delete process.env.CLAUDE_CODE_USE_VERTEX
delete process.env.CLAUDE_CODE_USE_FOUNDRY
delete process.env.ANTHROPIC_PROFILE

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
/** cm1: like `prepare`, but `cwd` is a real git repository, so the runner's `git status` check has something to read. */
async function prepareGit(kind: 'claude' | 'codex', prompt: string) {
  const runDir = await mkdtemp(join(tmpdir(), `orch-cli-${kind}-`))
  const cwd = await makeRepo()
  const promptFile = join(runDir, 'prompt.md')
  await writeFile(promptFile, prompt)
  const log = join(runDir, 'argv.log')
  process.env.FAKE_CLI_LOG = log
  const args: CliRunnerArgs = { kind, runDir, cwd, promptFile, command: process.execPath, commandArgs: [kind === 'claude' ? FAKE_CLAUDE : FAKE_CODEX], model: kind === 'claude' ? 'opus' : 'gpt-5.6-sol' }
  return { runDir, cwd, args }
}
const mail = (runDir: string, name: string, text = '') => writeFile(join(runDir, 'mailbox', name), text)
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
/** Waits until the runner has taken a mail out of the mailbox (the direction is now held or delivered). */
const whenMailTaken = async (runDir: string, name: string) => {
  for (let i = 0; i < 400; i++) {
    if (!(await readdir(join(runDir, 'mailbox')).catch(() => [] as string[])).includes(name)) return
    await new Promise((r) => setTimeout(r, 25))
  }
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
    // HOLD: the first turn ends only once the steer is folded into it, whatever the machine load.
    const { runDir, args, argv } = await prepare('claude', 'HOLD first')
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
    // HOLD keeps the turn open until the cancel kills it: a fixed delay before the cancel raced the end of a SLOW turn
    // under load, and the held direction then ran as the next turn and the run completed.
    const { runDir, args } = await prepare('claude', 'HOLD first')
    const held = async () => { await steer(runDir, args.promptFile, 'later', 'queue'); await whenMailTaken(runDir, steerMailName(STEER)); await mail(runDir, 'cancel') }
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, held)])
    expect(state).toMatchObject({ status: 'cancelled', exitCode: 130 })
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'abandoned', reason: 'cancelled' })
  })
})

describe('runCliRun: claude that failed with exit code 0 (B01)', () => {
  const RESETS_AT = '2026-09-24T19:00:00.000Z'
  const attention = async (runDir: string, state: Awaited<ReturnType<typeof runCliRun>>) =>
    evaluateRun({ taskId: 't', runId: 'r', agent: 'claude/opus', startedAt: state.startedAt, state: { status: state.status, terminal: true, exitCode: state.exitCode }, events: normalize(await readRunEvents(runDir)), steersAt: [] }, new Date())

  it('V-B01/rate-limit a turn that hit the usage limit fails the run with the reason and the reset time', async () => {
    const { runDir, args } = await prepare('claude', 'RATELIMIT build it')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'failed', exitCode: 1, error: expect.stringContaining("You've hit your usage limit") })
    expect(state.error).toContain(RESETS_AT)
    const events = await readRunEvents(runDir)
    expect(events.find((e) => e.type === 'rate_limited')?.data).toMatchObject({ resetsAt: RESETS_AT })
    const [alarm] = await attention(runDir, state)
    expect(alarm).toMatchObject({ kind: 'failed', severity: 'alert', reason: { code: 'rate_limited', resetsAt: RESETS_AT }, hint: 'crewboard run t' })
    expect(alarm?.message).toContain("You've hit your usage limit")
  })

  it('V-B01/is-error a result with is_error fails the run with the text of that result', async () => {
    const { runDir, args } = await prepare('claude', 'APIERROR build it')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'failed', exitCode: 1, error: 'API Error: 529 overloaded' })
    const [alarm] = await attention(runDir, state)
    expect(alarm).toMatchObject({ kind: 'failed', message: expect.stringContaining('API Error: 529 overloaded') })
    // fo1: an error with no known cause is still a reason — `worker_error`, with the worker's own words as detail.
    expect(alarm).toMatchObject({ reason: { code: 'worker_error' }, detail: 'API Error: 529 overloaded' })
  })
})

describe('runCliRun: claude background work (bg1)', () => {
  const turns = (events: Awaited<ReturnType<typeof readRunEvents>>) => events.filter((e) => e.type === 'turn_started').map((e) => e.data as { text: string; fullText: string; woken?: true })

  it('V-bg1/stays-open keeps the session open while the worker waits for its background child and finishes after the woken turn', async () => {
    const { runDir, args } = await prepare('claude', 'BACKGROUND:600 run the stress checks')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed', exitCode: 0, usage: { calls: 2 } })
    const events = await readRunEvents(runDir)
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['background_started', 'background_wait', 'background_finished']))
    expect(events.find((e) => e.type === 'background_finished')?.data).toMatchObject({ status: 'completed', summary: expect.stringContaining('exit code 0') })
    expect(turns(events).at(-1)).toMatchObject({ woken: true, text: expect.stringContaining('completed') })
    expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(2)
    expect(finalMessage(events)).toBe('saw bg1-600')
  })

  it('V-bg1/wake-fallback sends the outcome as a turn itself when the CLI does not wake the session', async () => {
    const { runDir, args } = await prepare('claude', 'BACKGROUND:300 NOWAKE checks')
    const state = await runCliRun({ ...args, background: { wakeGraceMs: 300 } })
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 2 } })
    const sent = turns(await readRunEvents(runDir)).at(-1)
    expect(sent?.woken).toBeUndefined()
    expect(sent?.fullText).toMatch(/background work has finished: .*exit code 0.*final report/i)
  })

  it('V-bg1/limit tells the worker to stop waiting once, then closes and records what was abandoned', async () => {
    const { runDir, args } = await prepare('claude', 'BACKGROUND:30000 endless monitor')
    const started = Date.now()
    const state = await runCliRun({ ...args, background: { limitMs: 400 } })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 2 } })
    const events = await readRunEvents(runDir)
    expect(turns(events).at(-1)?.fullText).toMatch(/still running after .*: sleep bg1-30000.*Nothing will wake you/)
    expect(events.find((e) => e.type === 'background_abandoned')?.data).toMatchObject({ tasks: [{ id: 'bg1-30000' }] })
    expect(events.find((e) => e.type === 'background_finished')?.data).toMatchObject({ status: 'stopped' })
  })

  it('V-bg1/stop-while-waiting a stop while background work runs cancels the run: the last answer was no report', async () => {
    const { runDir, args } = await prepare('claude', 'BACKGROUND:30000 checks')
    const [state] = await Promise.all([runCliRun(args), whenTurnEnded(runDir, () => mail(runDir, 'cancel'))])
    expect(state).toMatchObject({ status: 'cancelled', exitCode: 130 })
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
    // HOLD: a 5 s SLOW turn could end before a starved runner took the steer, which then ran as a queued next turn.
    const { runDir, args, argv } = await prepare('codex', 'HOLD first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'fix the test', 'auto'))])
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 1 } })
    expect((await readSteer(runDir, '11111111-1111-4111-8111-111111111111'))?.state).toBe('acknowledged')
    const calls = await argv()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-m', 'gpt-5.6-sol', 'th-1', 'fix the test'])
  })

  it('holds a steer that arrives before codex reported its thread and resumes that thread with the correction', async () => {
    // Under load the steer landed while `codex exec` was still booting: the SIGINT killed it before `thread.started`,
    // and the correction ran as a fresh `exec` that had lost the task.
    const { runDir, args, argv } = await prepare('codex', 'LATE first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'fix the test', 'auto'))])
    expect(state).toMatchObject({ status: 'completed' })
    expect((await argv()).map((call) => call.slice(0, 2))).toEqual([['exec', '--json'], ['exec', 'resume']])
    expect((await argv()).at(-1)?.slice(-2)).toEqual(['th-1', 'fix the test'])
  })

  it('reads a resumed turn whose process exits while the runner still marks the direction as sent', async () => {
    // The listeners were attached after that await: a process that exited in between had its output flushed and its
    // `close` emitted unseen, and the run waited forever. The held steer lock stretches that window deterministically.
    const { runDir, args, argv } = await prepare('codex', 'HOLD first')
    const done = join(runDir, 'done.log')
    process.env.FAKE_CLI_DONE = done
    const lock = join(runDir, '.steer-lock')
    const release = async () => {
      await mkdir(lock)
      await steer(runDir, args.promptFile, 'fix the test', 'auto')
      for (let i = 0; i < 400 && !(await readFile(done, 'utf8').catch(() => '')).includes('fix the test'); i++) await new Promise((r) => setTimeout(r, 25))
      await new Promise((r) => setTimeout(r, 300))
      await rm(lock, { recursive: true, force: true })
    }
    try {
      const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, release)])
      expect(state).toMatchObject({ status: 'completed', usage: { calls: 1 } })
      expect((await argv()).at(-1)?.slice(-2)).toEqual(['th-1', 'fix the test'])
      expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'acknowledged' })
    } finally {
      delete process.env.FAKE_CLI_DONE
    }
  })

  it('V-st1/codex-queue lets the running turn finish and sends a queued direction as the next turn', async () => {
    const { runDir, args, argv } = await prepare('codex', 'SLOW first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'fix the test', 'queue'))])
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 2 } })
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'acknowledged' })
    expect((await argv()).at(-1)?.at(-1)).toBe('fix the test')
  })

  it('cancels a running turn', async () => {
    const { runDir, args } = await prepare('codex', 'HOLD first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => mail(runDir, 'cancel'))])
    expect(state).toMatchObject({ status: 'cancelled', exitCode: 130 })
  })
})

describe('runCliRun: a claimed result with uncommitted work is finished in the same run (cm1)', () => {
  const uncommitted = async (cwd: string) => (await nodeExec('git', ['-C', cwd, 'status', '--porcelain'])).stdout.trim().split('\n').filter(Boolean).length

  it('does not demand a commit when the orchestrator owns the handoff', async () => {
    const { runDir, cwd, args } = await prepareGit('codex', 'REPORT WRITE:work.txt')
    const state = await runCliRun({ ...args, commitRequired: false })
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 1 } })
    expect((await readRunEvents(runDir)).some((event) => event.type === 'commit_nudge')).toBe(false)
    expect(await uncommitted(cwd)).toBe(1)
  })

  it('V-cm1/nudge-then-commit sends one follow-up turn on a dirty report, then finishes once the worker commits', async () => {
    const { runDir, cwd, args } = await prepareGit('claude', 'REPORT WRITE:work.txt')
    process.env.FAKE_CLI_COMMIT_ON_NUDGE = '1'
    try {
      const state = await runCliRun(args)
      expect(state).toMatchObject({ status: 'completed', exitCode: 0, usage: { calls: 2 } })
      const events = await readRunEvents(runDir)
      expect(events.find((e) => e.type === 'commit_nudge')?.data).toMatchObject({ uncommitted: 1 })
      const started = events.filter((e) => e.type === 'turn_started').map((e) => (e.data as { fullText: string }).fullText)
      expect(started).toEqual(['REPORT WRITE:work.txt', expect.stringContaining("Your work is not committed: 1 files")])
      expect(finalMessage(events)).toBe('Result: received')
      expect(await uncommitted(cwd)).toBe(0)
    } finally {
      delete process.env.FAKE_CLI_COMMIT_ON_NUDGE
    }
  })

  it('V-cm1/still-dirty sends the nudge only once and still finishes when the worker reports again without committing', async () => {
    const { runDir, cwd, args } = await prepareGit('claude', 'REPORT WRITE:work.txt')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 2 } })
    const events = await readRunEvents(runDir)
    expect(events.filter((e) => e.type === 'commit_nudge')).toHaveLength(1)
    expect(await uncommitted(cwd)).toBe(1)
  })

  it('V-cm1/clean-copy does not nudge a report that leaves nothing uncommitted', async () => {
    const { runDir, args } = await prepareGit('claude', 'REPORT')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed', usage: { calls: 1 } })
    const events = await readRunEvents(runDir)
    expect(events.some((e) => e.type === 'commit_nudge')).toBe(false)
  })

  it('V-cm1/codex sends the same nudge for codex, once, and finishes once the worker commits', async () => {
    const { runDir, cwd, args } = await prepareGit('codex', 'REPORT WRITE:work.txt')
    process.env.FAKE_CLI_COMMIT_ON_NUDGE = '1'
    try {
      const state = await runCliRun(args)
      expect(state).toMatchObject({ status: 'completed', usage: { calls: 2 } })
      const events = await readRunEvents(runDir)
      expect(events.filter((e) => e.type === 'commit_nudge')).toHaveLength(1)
      // parseCodexLine adds the trailing newline `item.completed`'s `agent_message` never has (cli-parse.ts).
      expect(finalMessage(events)).toBe('Result: received\n')
      expect(await uncommitted(cwd)).toBe(0)
    } finally {
      delete process.env.FAKE_CLI_COMMIT_ON_NUDGE
    }
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
    const backend = createCliBackend({ kind: 'claude', runsRoot, command: process.execPath, commandArgs: [FAKE_CLAUDE], startRunner: (a, env) => runCliRun(a, undefined, env) })
    const runId = await backend.launch({ agent: 'claude/opus', promptFile, cwd: runsRoot })
    expect(runId).toMatch(/^run_claude-[a-z0-9]+$/)
    expect(await backend.status(runId)).toMatchObject({ status: 'completed', terminal: true })
    expect(await backend.usage?.(runId)).toMatchObject({ sessionId: 'sess-1', calls: 1, inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50, reasoningTokens: 0, usd: 0.1, availability: { cacheWrite: { value: 50, state: 'known', final: true } } })
  })
  it('keeps Codex cache-write unavailable through parse, runner, backend and runCost', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-codex-cache-write-'))
    const promptFile = join(runsRoot, 'p.md')
    await writeFile(promptFile, 'build it')
    const backend = createCliBackend({ kind: 'codex', runsRoot, command: process.execPath, commandArgs: [FAKE_CODEX], startRunner: (a) => runCliRun(a) })
    const runId = await backend.launch({ agent: 'codex/gpt-5.6-sol', promptFile, cwd: runsRoot })
    const usage = await backend.usage?.(runId)
    expect(usage?.cacheWriteTokens).toBeUndefined()
    expect(usage?.availability?.cacheWrite?.state).toBe('unavailable')
    expect(runCost({ runId, agent: 'codex/gpt-5.6-sol', startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:01:00Z' }, [], usage).tokens).not.toHaveProperty('cacheWrite')
    await writeFile(promptFile, 'CACHEWRITE0')
    const zeroRunId = await backend.launch({ agent: 'codex/gpt-5.6-sol', promptFile, cwd: runsRoot })
    const zeroUsage = await backend.usage?.(zeroRunId)
    expect(zeroUsage?.cacheWriteTokens).toBe(0)
    expect(runCost({ runId: zeroRunId, agent: 'codex/gpt-5.6-sol', startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:01:00Z' }, [], zeroUsage).tokens?.cacheWrite).toBe(0)
    for (const prompt of ['MIXED_WRITE_MISSING_FIRST', 'MIXED_WRITE_KNOWN_FIRST']) {
      await writeFile(promptFile, prompt)
      const mixedRunId = await backend.launch({ agent: 'codex/gpt-5.6-sol', promptFile, cwd: runsRoot })
      const mixedUsage = await backend.usage?.(mixedRunId)
      expect(mixedUsage?.cacheWriteTokens).toBe(7)
      expect(mixedUsage?.availability?.cacheWrite?.state).toBe('partial')
      const run = runCost({ runId: mixedRunId, agent: 'codex/gpt-5.6-sol', startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:01:00Z' }, [], mixedUsage)
      expect(run.tokens?.cacheWrite).toBe(7)
      expect(run.availability?.cacheWrite).toBe('partial')
    }
  })
  it('does not treat a completed Cursor turn as observed zero usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-cursor-usage-'))
    const id = 'run_cursor-observed'
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, id)))
    await writeFile(join(root, id, 'state.json'), JSON.stringify({ status: 'completed', exitCode: 0, startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:01:00Z', pid: process.pid, usage: { calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }))
    const usage = await createCliBackend({ kind: 'cursor', runsRoot: root }).usage?.(id)
    expect(usage?.availability?.input?.state).toBe('unavailable')
    expect(runCost({ runId: id, agent: 'cursor/auto', startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:01:00Z' }, [], usage).tokens).toBeUndefined()
  })
  it('preserves legacy CLI cache-write sums as partial and leaves legacy zero unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-legacy-cache-write-'))
    for (const kind of ['claude', 'codex'] as const) {
      const backend = createCliBackend({ kind, runsRoot: root })
      for (const [suffix, cacheWriteTokens] of [['positive', 7], ['zero', 0]] as const) {
        const id = `run_${kind}-legacy-${suffix}`
        await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, id)))
        await writeFile(join(root, id, 'state.json'), JSON.stringify({ status: 'completed', exitCode: 0, startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:01:00Z', pid: process.pid, usage: { calls: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens, reasoningTokens: 0 } }))
        const usage = await backend.usage?.(id)
        const run = runCost({ runId: id, agent: `${kind}/model`, startedAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:01:00Z' }, [], usage)
        if (cacheWriteTokens > 0) {
          expect(usage?.availability?.cacheWrite?.state).toBe('partial')
          expect(run.tokens?.cacheWrite).toBe(7)
          expect(run.availability?.cacheWrite).toBe('partial')
        } else {
          expect(usage?.cacheWriteTokens).toBeUndefined()
          expect(usage?.availability?.cacheWrite?.state).toBe('unavailable')
          expect(run.tokens).not.toHaveProperty('cacheWrite')
        }
      }
    }
  })
})

describe('cli backends: a supervisor that died mid-run (B19)', () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const until = async (check: () => Promise<boolean> | boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await check()) return
    throw new Error('timed out')
  }
  /** A detached supervisor (the compiled one, as in production) running a worker that writes to its copy. */
  async function orphaned(prompt: string, orphanGraceMs?: number) {
    const runsRoot = await mkdtemp(join(tmpdir(), 'orch-orphan-'))
    const cwd = await mkdtemp(join(tmpdir(), 'orch-orphan-copy-'))
    const promptFile = join(runsRoot, 'p.md')
    await writeFile(promptFile, prompt)
    const { createCliBackend: detachedBackend } = await import('../dist/runs/cli-backend.js')
    const backend = detachedBackend({ kind: 'claude', runsRoot, env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-test' }, command: process.execPath, commandArgs: [FAKE_CLAUDE], ...(orphanGraceMs === undefined ? {} : { orphanGraceMs }) })
    const runId = await backend.launch({ agent: 'claude/opus', promptFile, cwd })
    const stateFile = join(runsRoot, runId, 'state.json')
    const state = async () => JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) as { pid?: number; workerPid?: number; status?: string; error?: string; interrupted?: unknown }
    await until(async () => (await state()).workerPid !== undefined && (await stat(join(cwd, 'orphan.txt')).then(() => true, () => false)))
    const { pid, workerPid } = (await state()) as { pid: number; workerPid: number }
    process.kill(pid, 'SIGKILL')
    await until(() => !alive(pid))
    const written = async () => (await readFile(join(cwd, 'orphan.txt'), 'utf8')).length
    return { backend, runId, workerPid, state, written, events: () => readRunEvents(join(runsRoot, runId)), cleanup: () => { try { process.kill(-workerPid, 'SIGKILL') } catch {} } }
  }

  it('V-B19/orphan-stopped stops the worker that outlived its supervisor and names the outcome', async () => {
    const run = await orphaned('ORPHAN build it')
    try {
      expect(alive(run.workerPid)).toBe(true)
      const status = await run.backend.status(run.runId)
      expect(status).toMatchObject({ status: 'failed', terminal: true, exitCode: 1 })
      expect(alive(run.workerPid)).toBe(false)
      expect(await run.state()).toMatchObject({ status: 'failed', interrupted: { workerPid: run.workerPid, workerStopped: true } })
      const before = await run.written()
      await new Promise((r) => setTimeout(r, 300))
      expect(await run.written()).toBe(before)
      const [alarm] = evaluateRun({ taskId: 't', runId: run.runId, agent: 'claude/opus', startedAt: new Date().toISOString(), state: status, events: normalize(await run.events()), steersAt: [] }, new Date())
      expect(alarm).toMatchObject({ kind: 'failed', reason: { code: 'interrupted', workerPid: run.workerPid, workerStopped: true } })
    } finally {
      run.cleanup()
    }
  })

  it('V-B19/orphan-alive keeps the run live while a worker that ignores SIGTERM lives, then kills it after the grace', async () => {
    const run = await orphaned('ORPHAN STUBBORN build it', 400)
    try {
      expect(await run.backend.status(run.runId)).toMatchObject({ status: 'running', terminal: false, orphan: { workerPid: run.workerPid } })
      expect(alive(run.workerPid)).toBe(true)
      await new Promise((r) => setTimeout(r, 500))
      expect(await run.backend.status(run.runId)).toMatchObject({ status: 'failed', terminal: true })
      expect(alive(run.workerPid)).toBe(false)
      expect(await run.state()).toMatchObject({ interrupted: { workerPid: run.workerPid, workerStopped: true } })
    } finally {
      run.cleanup()
    }
  })
})

/** rb1: the four CLIs driven from the one per-turn-process table (`driveTurnCli`). */
describe('runCliRun: turn CLIs — opencode, cursor-agent, gemini, grok', () => {
  const FAKES = {
    opencode: fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url)),
    cursor: fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url)),
    gemini: fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url)),
    grok: fileURLToPath(new URL('./fixtures/fake-grok.mjs', import.meta.url)),
  } as const
  type TurnKind = keyof typeof FAKES
  const prepareTurn = async (kind: TurnKind, prompt: string, extra: Partial<CliRunnerArgs> = {}) => {
    const runDir = await mkdtemp(join(tmpdir(), `orch-cli-${kind}-`))
    const cwd = await makeRepo()
    const promptFile = join(runDir, 'prompt.md')
    await writeFile(promptFile, prompt)
    const log = join(runDir, 'argv.log')
    process.env.FAKE_CLI_LOG = log
    const args: CliRunnerArgs = { kind, runDir, cwd, promptFile, command: process.execPath, commandArgs: [FAKES[kind]], ...extra }
    const argv = async () => (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as string[])
    return { runDir, cwd, args, argv, log }
  }

  it('V-rb1/opencode launches verified args, records session, tools, usage and resumes on the next turn', async () => {
    const { runDir, cwd, args, argv } = await prepareTurn('opencode', 'SLOW build it', { model: 'deepseek/deepseek-flash', effort: 'high' })
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'and tests', 'queue'))])
    expect(state).toMatchObject({ status: 'completed', exitCode: 0, sessionId: 'ses_1', usage: { calls: 2, inputTokens: 20, outputTokens: 10, usd: 0.02 } })
    const [first, second] = await argv()
    expect(first).toEqual(expect.arrayContaining(['run', '--pure', '--agent', 'build', '--auto', '-m', 'deepseek/deepseek-flash', '--variant', 'high', '--dir', cwd, '--format', 'json', 'SLOW build it']))
    // The queued direction resumed the reported session id.
    expect(second).toEqual(expect.arrayContaining(['--session', 'ses_1', 'and tests']))
    const feed = normalize(await readRunEvents(runDir))
    expect(feed.map((e) => e.kind)).toContain('action')
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'acknowledged' })
  })

  it('V-rb1/opencode-readonly runs the plan agent and fails a turn that reports an error event', async () => {
    const { args, argv } = await prepareTurn('opencode', 'ERROR build it', { readOnly: true })
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'failed', exitCode: 1, error: 'opencode exploded: provider refused' })
    expect((await argv())[0]).toEqual(expect.arrayContaining(['--agent', 'plan', '--auto']))
  })

  it('V-rb1/cursor launches verified args, streams tools, and resumes the chat on the next turn', async () => {
    const { runDir, args, argv } = await prepareTurn('cursor', 'SLOW build it', { model: 'composer-1' })
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => steer(runDir, args.promptFile, 'and tests', 'queue'))])
    expect(state).toMatchObject({ status: 'completed', exitCode: 0, sessionId: 'chat-1', usage: { calls: 2 } })
    const [first, second] = await argv()
    expect(first).toEqual(expect.arrayContaining(['--print', '--output-format', 'stream-json', '--stream-partial-output', '--approve-mcps', '--model', 'composer-1', '--force', 'SLOW build it']))
    expect(second).toEqual(expect.arrayContaining(['--resume', 'chat-1', 'and tests']))
  })

  it('V-rb1/cursor-readonly uses plan mode; a result with is_error fails the run with its text', async () => {
    const { args, argv } = await prepareTurn('cursor', 'APIERROR build it', { readOnly: true })
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'failed', exitCode: 1, error: 'API Error: 529 overloaded' })
    expect((await argv())[0]).toEqual(expect.arrayContaining(['--mode', 'plan']))
  })

  it('V-rb1/grok reads the prompt from --prompt-file and its events from streaming-json', async () => {
    const { args, argv } = await prepareTurn('grok', 'build it', { model: 'grok-4.7', effort: 'high' })
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed', exitCode: 0, sessionId: 'grok-1', usage: { calls: 1, inputTokens: 10, outputTokens: 5 } })
    const [first] = await argv()
    expect(first).toEqual(expect.arrayContaining(['--always-approve', '-m', 'grok-4.7', '--reasoning-effort', 'high', '--output-format', 'streaming-json', '--verbatim', '--prompt-file']))
    const promptFile = first[first.indexOf('--prompt-file') + 1]!
    expect(await readFile(promptFile, 'utf8')).toBe('build it')
  })

  it('V-rb1/grok-readonly takes the porch-verified sandbox and tool allowlist', async () => {
    const { args, argv } = await prepareTurn('grok', 'look at it', { readOnly: true, model: 'grok-4.7' })
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed' })
    const [first] = await argv()
    expect(first).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--no-plan', '--no-subagents', '--no-memory', '--tools', 'read_file,grep,list_dir,run_terminal_cmd,web_search,web_fetch', '--disallowed-tools', 'search_replace,write,Agent']))
    expect(first).not.toContain('--always-approve')
  })

  it('V-rb1/grok-error an end whose stopReason is Error fails the run', async () => {
    const { args } = await prepareTurn('grok', 'ERROR build it')
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'failed', exitCode: 1, error: 'grok exploded: upstream' })
  })

  it('V-rb1/gemini feeds the prompt on stdin and reads the one JSON object at exit', async () => {
    const { args, log } = await prepareTurn('gemini', 'build it', { model: 'gemini-3-pro-preview' })
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'completed', exitCode: 0, usage: { calls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 } })
    const [{ argv, stdin }] = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; stdin: string })
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'json', '--approval-mode', 'yolo', '--model', 'gemini-3-pro-preview']))
    expect(stdin).toBe('build it')
  })

  it('V-rb1/gemini-readonly uses the documented plan approval mode; an error object fails the run', async () => {
    const { args, log } = await prepareTurn('gemini', 'ERROR build it', { readOnly: true })
    const state = await runCliRun(args)
    expect(state).toMatchObject({ status: 'failed', exitCode: 1, error: 'gemini exploded: quota' })
    const [{ argv }] = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] })
    expect(argv).toEqual(expect.arrayContaining(['--approval-mode', 'plan']))
  })

  it('V-rb1/cancel stops an interruptible turn through the process group and abandons a held direction', async () => {
    const { runDir, args } = await prepareTurn('opencode', 'HOLD first')
    const held = async () => { await steer(runDir, args.promptFile, 'later', 'queue'); await whenMailTaken(runDir, steerMailName(STEER)); await mail(runDir, 'cancel') }
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, held)])
    // The exit code depends on whether SIGTERM landed before or after the CLI armed its own handler.
    expect(state).toMatchObject({ status: 'cancelled' })
    expect(await readSteer(runDir, STEER)).toMatchObject({ state: 'abandoned', reason: 'cancelled' })
  })

  it('V-rb1/cancel-cursor a running turn is killed the same way', async () => {
    const { runDir, args } = await prepareTurn('cursor', 'HOLD first')
    const [state] = await Promise.all([runCliRun(args), whenTurnStarted(runDir, () => mail(runDir, 'cancel'))])
    expect(state).toMatchObject({ status: 'cancelled' })
  })

  it('V-rb1/kind-maps `opencode/<model>`, `cursor/<model>`, `gemini/<model>`, `grok/<model>` resolve to their backends', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    for (const [agent, backend] of [
      ['opencode/deepseek/deepseek-flash', 'opencode'],
      ['cursor/composer-1', 'cursor-agent'],
      ['gemini/gemini-3-pro-preview', 'gemini-cli'],
      ['grok/grok-4.7', 'grok-build'],
    ] as const) {
      const profile = await resolveProfile({}, home, agent)
      expect([agent, profile?.backend]).toEqual([agent, backend])
      expect(cliKindOf(agent)).toBe(agent.split('/')[0])
    }
    // A fourth slash (opencode's provider/model ids) leaves the whole rest as the model.
    expect(cliModel('opencode/deepseek/deepseek-flash')).toBe('deepseek/deepseek-flash')
  })
})
