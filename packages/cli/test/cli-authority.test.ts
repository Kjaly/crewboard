import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// wp1 (2026-09-24): an agent — `orch` without an interactive terminal — may name only a worker of the
// effective preset; a person at a TTY may name any; `auto` clears the choice.

let root: string
let env: NodeJS.ProcessEnv
const task = async (id: string) => (await loadPlan(root)).tasks.find((t) => t.id === id)

beforeEach(async () => {
  root = await makeRepo()
  env = { HOME: await mkdtemp(join(tmpdir(), 'orch-authority-cli-')) }
  const h = makeHarness({ cwd: root, env })
  expect(await run(['init', '--goal', 'g'], h.io)).toBe(0)
  expect(await run(['presets', 'add', 'claude', '--label', 'Claude', '--code', 'claude/opus', '--design', 'claude/opus,claude/fable', '--review', 'claude/opus', '--research', 'claude/opus'], h.io)).toBe(0)
  expect(await run(['repo', 'preset', 'claude'], h.io)).toBe(0)
})

describe('orch task add|set --worker under the preset', () => {
  it('refuses an agent\'s worker outside the preset with exit 2 and the allowed list', async () => {
    const agent = makeHarness({ cwd: root, env })
    expect(await run(['task', 'add', 't1', '--title', 'T1', '--worker', 'codex/gpt-6-sol'], agent.io)).toBe(2)
    expect(agent.err()).toContain('Worker codex/gpt-6-sol is not in the preset “Claude” for the class “Code” (code)')
    expect(agent.err()).toContain('An agent may choose only: claude/opus')
    expect(agent.err()).toContain('Ask the person to choose another worker or change the preset.')
    expect(await task('t1')).toBeUndefined()

    const ru = makeHarness({ cwd: root, env })
    expect(await run(['--lang', 'ru', 'task', 'add', 't1', '--title', 'T1', '--class', 'design', '--worker', 'devin'], ru.io)).toBe(2)
    expect(ru.err()).toContain('не входит в пресет «Claude» для класса «Проектирование и UI» (design)')
    expect(ru.err()).toContain('Агент может выбрать только: claude/opus, claude/fable')
    expect(ru.err()).toContain('Попросите человека выбрать другого воркера или сменить пресет.')
  })

  it('accepts an agent\'s worker inside the preset and records the agent as its source', async () => {
    const agent = makeHarness({ cwd: root, env })
    expect(await run(['task', 'add', 't1', '--title', 'T1', '--class', 'design', '--worker', 'claude/fable'], agent.io)).toBe(0)
    expect(await task('t1')).toMatchObject({ worker: 'claude/fable', workerSource: 'agent' })
    expect(await run(['task', 'set', 't1', '--worker', 'devin'], agent.io)).toBe(2)
    expect(await task('t1')).toMatchObject({ worker: 'claude/fable', workerSource: 'agent' })
  })

  it('lets a person at a terminal assign any worker; it is stored as the person\'s hand pick', async () => {
    const agent = makeHarness({ cwd: root, env })
    expect(await run(['task', 'add', 't1', '--title', 'T1'], agent.io)).toBe(0)
    const person = makeHarness({ cwd: root, env, isTTY: true })
    expect(await run(['task', 'set', 't1', '--worker', 'codex/gpt-6-sol'], person.io)).toBe(0)
    expect(await task('t1')).toMatchObject({ worker: 'codex/gpt-6-sol', workerSource: 'person' })
    expect(await run(['task', 'add', 't2', '--title', 'T2', '--worker', 'devin'], person.io)).toBe(0)
    expect(await task('t2')).toMatchObject({ worker: 'devin', workerSource: 'person' })
  })

  it('--worker auto clears the worker and its source', async () => {
    const person = makeHarness({ cwd: root, env, isTTY: true })
    expect(await run(['task', 'add', 't1', '--title', 'T1', '--worker', 'devin'], person.io)).toBe(0)
    const agent = makeHarness({ cwd: root, env })
    expect(await run(['task', 'set', 't1', '--worker', 'auto'], agent.io)).toBe(0)
    const t = await task('t1')
    expect(t?.worker).toBeUndefined()
    expect(t?.workerSource).toBeUndefined()
  })
})

describe('orch run -a under the preset', () => {
  it('refuses an agent\'s -a outside the preset with exit 2 before anything is prepared', async () => {
    await writeFile(join(root, 'c.md'), 'do it\n')
    const agent = makeHarness({ cwd: root, env })
    expect(await run(['task', 'add', 't1', '--title', 'T1', '--contract', 'c.md'], agent.io)).toBe(0)
    expect(await run(['run', 't1', '-a', 'devin', '--skip-preflight'], agent.io)).toBe(2)
    expect(agent.err()).toContain('An agent may choose only: claude/opus')
    expect((await task('t1'))?.runs).toEqual([])
  })

  it('tells agents in the help not to pass -a or --worker', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['--help'], h.io)
    expect(h.out()).toContain('agents, do not pass it')
    const ru = makeHarness({ cwd: root, env })
    await run(['--lang', 'ru', '--help'], ru.io)
    expect(ru.out()).toContain('агентам не передавать')
  })
})
