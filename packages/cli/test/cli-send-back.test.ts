import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPlan, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const FAKE_CLAUDE = fileURLToPath(new URL('../../core/test/fixtures/fake-claude.mjs', import.meta.url))

/** A repository with t1 in review after one finished Claude run, and a fake Claude for the next one. */
async function inReview() {
  const root = await makeRepo()
  const tmp = await mkdtemp(join(tmpdir(), 'orch-cli-wk1-'))
  const claude = join(tmp, 'claude')
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
  await chmod(claude, 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, PORCH_CONFIG: join(tmp, 'porch.json'), CREWBOARD_CLAUDE_COMMAND: claude, CREWBOARD_CLI_RUNNER: 'inline' }
  await writeFile(join(root, 'task.md'), 'Build it.\n')
  await mkdir(join(root, '.orchestration'), { recursive: true })
  const person = makeHarness({ cwd: root, env, isTTY: true })
  expect(await run(['init'], person.io)).toBe(0)
  expect(await run(['task', 'add', 't1', '--title', 'T', '--contract', 'task.md'], person.io)).toBe(0)
  // The previous run's worker is in the preset: a rerun keeps it (a relaunch never bypasses the preset).
  expect(await run(['workers', 'route', 'code', 'claude/opus,dsh/deepseek-flash'], person.io), person.err()).toBe(0)
  await updatePlan(root, (plan) => {
    const task = plan.tasks[0]!
    task.status = 'in_review'
    task.runs.push({ runId: 'run_claude-old', agent: 'claude/opus', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:10:00Z', outcome: 'completed' })
    return plan
  })
  return { root, env }
}

const prompts = async (root: string) => {
  const dir = join(root, '.orchestration', 'prompts')
  return Promise.all((await readdir(dir).catch(() => [] as string[])).filter((name) => name.startsWith('t1-')).sort().map((name) => readFile(join(dir, name), 'utf8')))
}

describe('crewboard reject --rerun (wk1)', () => {
  it('V-wk1/cli-rerun sends back and starts the same worker again; the run prompt carries the reason after the contract', async () => {
    const { root, env } = await inReview()
    const person = makeHarness({ cwd: root, env, isTTY: true, answers: ['y'] })
    expect(await run(['reject', 't1', '--reason', 'Handle the empty list', '--rerun', '--skip-preflight'], person.io), person.err()).toBe(0)
    expect(person.questions()[0]).toContain('start it again now (the same worker)')
    expect(person.out()).toContain('↩ t1 returned')
    expect(person.out()).toContain("The reason is in this run's prompt")
    const task = (await loadPlan(root)).tasks[0]
    expect(task?.runs).toHaveLength(2)
    expect(task?.runs.at(-1)?.agent).toBe('claude/opus')
    expect(task?.notes.at(-1)).toMatchObject({ type: 'reject', event: { kind: 'rejected', reason: 'Handle the empty list' } })
    const [prompt] = await prompts(root)
    expect(prompt).toBeDefined()
    expect(prompt!.indexOf('Handle the empty list')).toBeGreaterThan(prompt!.indexOf('Build it.'))
    expect(prompt).toContain('<send_back>')
  })

  it('without --rerun only sends back and says where the reason goes; -a needs --rerun', async () => {
    const { root, env } = await inReview()
    const person = makeHarness({ cwd: root, env, isTTY: true, answers: ['y'] })
    expect(await run(['reject', 't1', '--reason', 'r', '-a', 'codex'], person.io)).toBe(2)
    expect(await run(['reject', 't1', '--reason', 'Handle the empty list'], person.io)).toBe(0)
    expect(person.out()).toContain("The reason goes into the next run's prompt.")
    expect((await loadPlan(root)).tasks[0]?.runs).toHaveLength(1)
    expect(await prompts(root)).toEqual([])
  })

  it('V-wk1/status-json status --json carries lastDecision {by, at, verdict, reason}', async () => {
    const { root, env } = await inReview()
    const person = makeHarness({ cwd: root, env, isTTY: true, answers: ['y'], now: new Date('2026-09-25T09:00:00Z') })
    expect(await run(['reject', 't1', '--reason', 'Handle the empty list'], person.io)).toBe(0)
    const status = makeHarness({ cwd: root, env })
    expect(await run(['status', '--json'], status.io), status.err()).toBe(0)
    const row = JSON.parse(status.out()).views.find((v: { id: string }) => v.id === 't1')
    expect(row.lastDecision).toEqual({ by: 'person', at: '2026-09-25T09:00:00.000Z', verdict: 'sent_back', reason: 'Handle the empty list' })
  })
})
