import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type RunnerArgs, readRunEvents, readRunState, runDshRun } from '../src/dsh/runner.js'
import { normalize } from '../src/runs/normalize.js'
import { readSteer, steerMailName, writeSteer } from '../src/runs/steers.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))

async function setup(prompt: string, extra: Partial<RunnerArgs> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-dsh-'))
  const runDir = join(dir, 'run')
  const log = join(dir, 'acp.log')
  const promptFile = join(dir, 'task.md')
  await writeFile(promptFile, prompt)
  process.env.FAKE_ACP_LOG = log
  const args: RunnerArgs = { runDir, cwd: dir, promptFile, command: process.execPath, args: [FAKE], ...extra }
  return { runDir, log, args }
}
const logOf = async (file: string) =>
  (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; text?: string; method?: string; params?: Record<string, unknown>; outcome?: unknown })
/** Acts once the first turn has started instead of at a fixed delay from the run start, which assumed a fast agent startup. */
const whenTurnStarted = async (runDir: string, fn: () => Promise<unknown>) => {
  for (let i = 0; i < 400; i++) {
    if ((await readFile(join(runDir, 'events.jsonl'), 'utf8').catch(() => '')).includes('"turn_started"')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  return fn()
}

describe('runDshRun', () => {
  it('completes a run and writes state and events', async () => {
    const { runDir, args } = await setup('write tests')
    const final = await runDshRun(args)
    expect(final).toMatchObject({ status: 'completed', exitCode: 0, sessionId: 'sess-1' })
    expect(await readRunState(runDir)).toMatchObject({ status: 'completed', exitCode: 0 })
    const feed = normalize(await readRunEvents(runDir))
    expect(feed.map((e) => e.kind)).toEqual(['file', 'message'])
    expect(feed[0]?.text).toBe('out.txt')
    expect(feed[1]?.text).toBe('done: write tests')
  })

  it('records turns, paired tool calls and context usage', async () => {
    const { runDir, args } = await setup('SLOW task')
    await mkdir(join(runDir, 'mailbox'), { recursive: true })
    await Promise.all([runDshRun(args), whenTurnStarted(runDir, async () => { await writeSteer(runDir, { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date().toISOString(), mode: 'auto', preview: 'Change of plan', file: args.promptFile, state: 'queued', timestamps: { queued: new Date().toISOString() } }); await writeFile(join(runDir, 'mailbox', steerMailName('11111111-1111-4111-8111-111111111111')), 'Change of plan') })])
    const raw = await readRunEvents(runDir)
    const types = raw.map((e) => e.type)
    expect(types.filter((t) => t === 'turn_started')).toHaveLength(2)
    expect(raw.filter((e) => e.type === 'turn_ended').map((e) => (e.data as { stopReason: string }).stopReason)).toEqual(['cancelled', 'end_turn'])
    const started = raw.find((e) => e.type === 'tool_started')!.data as { callId: string }
    const completed = raw.find((e) => e.type === 'tool_completed')!.data as { callId: string; status: string }
    expect(started.callId).toBe('c1')
    expect(completed).toMatchObject({ callId: 'c1', status: 'completed' })
    expect(raw.find((e) => e.type === 'usage')?.data).toEqual({ used: 1200, size: 128000 })
    expect((raw.find((e) => e.type === 'turn_started')!.data as { text: string }).text).toBe('SLOW task')
  })

  it('selects the requested model', async () => {
    const { log, args } = await setup('x', { model: 'deepseek-flash' })
    await runDshRun(args)
    const call = (await logOf(log)).find((e) => e.method === 'session/set_config_option')
    expect(call?.params).toMatchObject({ sessionId: 'sess-1', configId: 'model', value: '["deepseek-official","deepseek-flash"]' })
  })

  it('steers by interrupting the turn and continuing in the same session', async () => {
    const { runDir, log, args } = await setup('SLOW task')
    await mkdir(join(runDir, 'mailbox'), { recursive: true })
    const [final] = await Promise.all([runDshRun(args), whenTurnStarted(runDir, async () => { await writeSteer(runDir, { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date().toISOString(), mode: 'auto', preview: 'Change of plan', file: args.promptFile, state: 'queued', timestamps: { queued: new Date().toISOString() } }); await writeFile(join(runDir, 'mailbox', steerMailName('11111111-1111-4111-8111-111111111111')), 'Change of plan') })])
    expect(final).toMatchObject({ status: 'completed', exitCode: 0 })
    const prompts = (await logOf(log)).filter((e) => e.type === 'prompt').map((e) => e.text)
    expect(prompts).toEqual(['SLOW task', 'Change of plan'])
    const sessions = (await logOf(log)).filter((e) => e.method === 'session/new')
    expect(sessions).toHaveLength(1)
    expect(normalize(await readRunEvents(runDir)).some((e) => e.kind === 'steer' && e.text === 'Change of plan')).toBe(true)
    expect((await readSteer(runDir, '11111111-1111-4111-8111-111111111111'))?.state).toBe('acknowledged')
  })

  it('cancels a running turn', async () => {
    const { runDir, log, args } = await setup('SLOW task')
    await mkdir(join(runDir, 'mailbox'), { recursive: true })
    const [final] = await Promise.all([runDshRun(args), whenTurnStarted(runDir, () => writeFile(join(runDir, 'mailbox', 'cancel'), ''))])
    expect(final).toMatchObject({ status: 'cancelled', exitCode: 130 })
    expect((await logOf(log)).filter((e) => e.type === 'prompt')).toHaveLength(1)
  })

  it('denies escalation requests and records them', async () => {
    const { runDir, log, args } = await setup('ESCALATE please')
    await runDshRun(args)
    expect((await logOf(log)).find((e) => e.type === 'permission')?.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' })
    expect(normalize(await readRunEvents(runDir)).some((e) => e.kind === 'problem')).toBe(true)
  })

  it('marks a crashed agent as failed', async () => {
    const { runDir, args } = await setup('CRASH now')
    const final = await runDshRun(args)
    expect(final).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(final.error).toMatch(/exited \(3\)/)
    expect(normalize(await readRunEvents(runDir)).at(-1)?.kind).toBe('problem')
  })
})
