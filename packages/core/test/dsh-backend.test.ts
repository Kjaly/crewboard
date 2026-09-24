import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDshBackend } from '../src/dsh/backend.js'
import { runDshRun } from '../src/dsh/runner.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'orch-dshb-'))
  const promptFile = join(dir, 'task.md')
  await writeFile(promptFile, 'write tests')
  process.env.FAKE_ACP_LOG = join(dir, 'acp.log')
  const runsRoot = join(dir, 'runs')
  const backend = createDshBackend({ runsRoot, command: process.execPath, args: [FAKE], startRunner: (a) => runDshRun(a) })
  return { dir, promptFile, runsRoot, backend }
}

describe('createDshBackend', () => {
  it('launches through the runner and reports state and events', async () => {
    const { dir, promptFile, backend } = await setup()
    const runId = await backend.launch({ agent: 'dsh/deepseek-flash', promptFile, cwd: dir })
    expect(runId).toMatch(/^run_dsh-[a-z0-9]+$/)
    expect(await backend.status(runId)).toMatchObject({ status: 'completed', terminal: true, exitCode: 0 })
    expect((await backend.events(runId)).some((e) => e.type === 'tool_started')).toBe(true)
  })

  it('writes steer and cancel requests into the mailbox', async () => {
    const { promptFile, runsRoot, backend } = await setup()
    const runId = 'run_dsh-manual'
    await mkdir(join(runsRoot, runId), { recursive: true })
    await backend.steer(runId, promptFile)
    await backend.cancel(runId)
    const mail = (await readdir(join(runsRoot, runId, 'mailbox'))).sort()
    expect(mail[0]).toBe('cancel')
    expect(mail[1]).toMatch(/^steer-\d+-[a-z0-9]+\.md$/)
  })

  it('reports a starting run and detects a dead supervisor', async () => {
    const { runsRoot, backend } = await setup()
    await mkdir(join(runsRoot, 'run_dsh-a'), { recursive: true })
    expect(await backend.status('run_dsh-a')).toMatchObject({ status: 'starting', terminal: false })
    await mkdir(join(runsRoot, 'run_dsh-b'), { recursive: true })
    await writeFile(join(runsRoot, 'run_dsh-b', 'state.json'), JSON.stringify({ status: 'running', exitCode: null, startedAt: 't', pid: 999_999 }))
    expect(await backend.status('run_dsh-b')).toMatchObject({ status: 'failed', terminal: true, exitCode: 1 })
  })

  it('reads usage for the run session from dsh-bill records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-dshb-'))
    const runsRoot = join(dir, 'runs')
    const billRecords = join(dir, 'records.jsonl')
    await writeFile(billRecords, `${JSON.stringify({ sessionId: 'sess-1', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.0001, priced: true })}\n`)
    const backend = createDshBackend({ runsRoot, billRecords })
    await mkdir(join(runsRoot, 'run_dsh-u'), { recursive: true })
    await writeFile(join(runsRoot, 'run_dsh-u', 'state.json'), JSON.stringify({ status: 'completed', exitCode: 0, startedAt: 't', pid: process.pid, sessionId: 'sess-1' }))
    expect(await backend.usage?.('run_dsh-u')).toMatchObject({ sessionId: 'sess-1', calls: 1, usd: 0.0001 })
    await mkdir(join(runsRoot, 'run_dsh-v'), { recursive: true })
    expect(await backend.usage?.('run_dsh-v')).toBeUndefined()
  })
})
