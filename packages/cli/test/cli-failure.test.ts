import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPlan, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const FAKE_CLAUDE = fileURLToPath(new URL('../../core/test/fixtures/fake-claude.mjs', import.meta.url))

/** A repository with task t1 whose first Claude run failed (fo1) and left a file uncommitted in its copy. */
async function failedOnce() {
  const root = await makeRepo()
  const tmp = await mkdtemp(join(tmpdir(), 'orch-cli-fo1-'))
  const claude = join(tmp, 'claude')
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
  await chmod(claude, 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, PORCH_CONFIG: join(tmp, 'porch.json'), CREWBOARD_CLAUDE_COMMAND: claude, CREWBOARD_CLI_RUNNER: 'inline' }
  await writeFile(join(root, 'task.md'), 'APIERROR build it\n')
  await mkdir(join(root, '.orchestration'), { recursive: true })
  const person = makeHarness({ cwd: root, env, isTTY: true })
  expect(await run(['init'], person.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], person.io)).toBe(0)
  expect(await run(['run', 't1', '-a', 'claude/opus', '--skip-preflight'], person.io), person.err()).toBe(0)
  const copy = (await loadPlan(root)).tasks[0]?.worktree?.path ?? ''
  await writeFile(join(copy, 'half-done.ts'), 'export const x = 1\n')
  return { root, env, copy }
}

describe('starting again on a copy with uncommitted changes (fo1)', () => {
  it('V-fo1/cli-dirty-agent an agent is refused, and the refusal names both commands', async () => {
    const { root, env } = await failedOnce()
    const agent = makeHarness({ cwd: root, env, isTTY: false })
    expect(await run(['run', 't1', '--skip-preflight', '--reset-copy'], agent.io)).toBe(1)
    expect(agent.err()).toContain('crewboard run t1 --keep-changes')
    expect(agent.err()).toContain('crewboard run t1 --reset-copy')
    expect((await loadPlan(root)).tasks[0]?.runs).toHaveLength(1)
  })

  it('V-fo1/cli-dirty-person the CLI asks a person: continue, reset, or cancel', async () => {
    const { root, env, copy } = await failedOnce()
    const cancel = makeHarness({ cwd: root, env, isTTY: true, answers: [''] })
    expect(await run(['run', 't1', '--skip-preflight'], cancel.io)).toBe(1)
    expect((await loadPlan(root)).tasks[0]?.runs).toHaveLength(1)
    const keep = makeHarness({ cwd: root, env, isTTY: true, answers: ['c'] })
    expect(await run(['run', 't1', '--skip-preflight'], keep.io), keep.err()).toBe(0)
    expect(await readFile(join(copy, 'half-done.ts'), 'utf8')).toContain('x = 1')
    const reset = makeHarness({ cwd: root, env, isTTY: true, answers: ['r'] })
    expect(await run(['--lang', 'ru', 'run', 't1', '--skip-preflight'], reset.io), reset.err()).toBe(0)
    await expect(readFile(join(copy, 'half-done.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // The flag answers without a question.
    await writeFile(join(copy, 'again.ts'), 'x\n')
    const flagged = makeHarness({ cwd: root, env, isTTY: true })
    expect(await run(['run', 't1', '--skip-preflight', '--keep-changes'], flagged.io), flagged.err()).toBe(0)
    expect((await loadPlan(root)).tasks[0]?.runs).toHaveLength(4)
  })

  it('status says how the failed attempt ended and what to do, in both languages', async () => {
    const { root, env } = await failedOnce()
    const h = makeHarness({ cwd: root, env, isTTY: true })
    expect(await run(['status'], h.io)).toBe(0)
    expect(h.out()).toMatch(/t1 .*last attempt failed: the worker failed → try again: crewboard run t1/)
    h.reset()
    expect(await run(['--lang', 'ru', 'status'], h.io)).toBe(0)
    expect(h.out()).toMatch(/t1 .*последняя попытка упала: воркер упал → повторить: crewboard run t1/)
  })
})

/** A running Claude run whose supervisor is this test process, last seen doing something at `lastStep`. */
async function runningRun(lastStep: string, events: Array<{ type: string; data: unknown }> = []) {
  const root = await makeRepo()
  const tmp = await mkdtemp(join(tmpdir(), 'orch-cli-fo1-'))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, PORCH_CONFIG: join(tmp, 'porch.json') }
  const h = makeHarness({ cwd: root, env, isTTY: true, now: new Date('2026-09-25T12:00:00Z') })
  await writeFile(join(root, 'task.md'), 'build it\n')
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], h.io)).toBe(0)
  const runId = 'run_claude-fo1'
  await updatePlan(root, (plan) => {
    plan.tasks[0]?.runs.push({ runId, agent: 'claude/opus', startedAt: '2026-09-25T11:30:00.000Z' })
    return plan
  })
  const dir = join(root, '.orchestration', 'runs', runId)
  await mkdir(join(dir, 'mailbox'), { recursive: true })
  await writeFile(join(dir, 'state.json'), JSON.stringify({ status: 'running', exitCode: null, startedAt: '2026-09-25T11:30:00.000Z', pid: process.pid, usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }))
  const lines = [{ ts: lastStep, type: 'tool_started', backend: 'claude', data: { tool: 'bash', status: 'running', input: { command: 'pnpm test' } } }, ...events.map((e) => ({ ts: lastStep, backend: 'claude', ...e }))]
  await writeFile(join(dir, 'events.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return { root, h }
}

describe('a running task that went quiet (fo1, st2)', () => {
  it('V-fo1/cli-stalled status shows «quiet for N min» next to the running task', async () => {
    const { h } = await runningRun('2026-09-25T11:40:00.000Z')
    expect(await run(['status'], h.io)).toBe(0)
    expect(h.out()).toMatch(/t1 .*quiet for 20 min/)
    h.reset()
    expect(await run(['status', '--json'], h.io)).toBe(0)
    expect(JSON.parse(h.out()).views[0]).toMatchObject({ status: 'running', stalledMin: 20 })
    h.reset()
    expect(await run(['--lang', 'ru', 'status'], h.io)).toBe(0)
    expect(h.out()).toMatch(/t1 .*тишина 20 мин/)
  })

  it('a live run shows no marker', async () => {
    const { h } = await runningRun('2026-09-25T11:59:00.000Z')
    expect(await run(['status'], h.io)).toBe(0)
    expect(h.out()).not.toMatch(/quiet for/)
  })
})

describe('runner notes follow the interface language (fo1, B33)', () => {
  it('V-fo1/cli-note a code and an older build’s Russian line both read in the reader’s language', async () => {
    const { h } = await runningRun('2026-09-25T11:59:00.000Z', [
      { type: 'steer', data: { code: 'stop_requested' } },
      { type: 'warning', data: 'поправка пришла после завершения запуска и не доставлена' },
    ])
    expect(await run(['--lang', 'en', 'events', 't1'], h.io)).toBe(0)
    expect(h.out()).toContain('stop requested')
    expect(h.out()).toContain('a direction arrived after the run finished and was not delivered')
    expect(h.out()).not.toMatch(/[А-Яа-я]/)
    h.reset()
    expect(await run(['--lang', 'ru', 'events', 't1'], h.io)).toBe(0)
    expect(h.out()).toContain('запрошена остановка')
    expect(h.out()).toContain('поправка пришла после завершения запуска')
  })
})
