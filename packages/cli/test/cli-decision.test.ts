import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { loadPlan, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

let root: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  root = await makeRepo()
  env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
})

/** A plan with a decision and a plain worker task; the decision was prepared once (checked). */
async function setup(h: ReturnType<typeof makeHarness>) {
  expect(await run(['init', '--goal', 'g'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'd1', '--title', 'Pick a store', '--kind', 'decision'], h.io)).toBe(0)
  expect(await run(['task', 'add', 'w1', '--title', 'Work'], h.io)).toBe(0)
  await updatePlan(root, (p) => {
    p.tasks.find((t) => t.id === 'd1')!.check = { state: 'checked', at: '2026-09-22T10:00:00Z', note: 'A or B, recommend A' }
    return p
  })
  h.reset()
}

// dc1: the answer the person already gave in chat is recorded without any terminal question.
it('decision answer records the answer and the basis and closes the decision', async () => {
  const h = makeHarness({ cwd: root, env })
  await setup(h)
  expect(await run(['decision', 'answer', 'd1', '--answer', 'sqlite', '--basis', 'user message “use sqlite”'], h.io)).toBe(0)
  expect(h.out()).toContain("the person's answer is recorded")
  expect(h.questions()).toEqual([])
  const d1 = (await loadPlan(root)).tasks.find((t) => t.id === 'd1')!
  expect(d1.status).toBe('accepted')
  expect(d1.notes.at(-1)).toMatchObject({ type: 'accept', event: { kind: 'answered', answer: 'sqlite', basis: 'user message “use sqlite”', by: 'orchestrator' } })
})

it('decision answer wants both the answer and its basis; repeats are idempotent, conflicts refused', async () => {
  const h = makeHarness({ cwd: root, env })
  await setup(h)
  expect(await run(['decision', 'answer', 'd1', '--answer', 'sqlite'], h.io)).toBe(2)
  expect(await run(['decision', 'answer', 'd1', '--basis', 'chat'], h.io)).toBe(2)
  expect(await run(['decision', 'answer', 'w1', '--answer', 'x', '--basis', 'chat'], h.io)).toBe(1)
  expect(h.err()).toContain('not a decision')
  expect(await run(['decision', 'answer', 'd1', '--answer', 'sqlite', '--basis', 'chat'], h.io)).toBe(0)
  h.reset()
  expect(await run(['decision', 'answer', 'd1', '--answer', 'sqlite', '--basis', 'chat'], h.io)).toBe(0)
  expect(h.out()).toContain('already recorded')
  expect(await run(['decision', 'answer', 'd1', '--answer', 'postgres', '--basis', 'chat'], h.io)).toBe(1)
  expect(h.err()).toContain('already answered')
})

it('decision prepare returns an open decision to preparation and refuses a closed one', async () => {
  const h = makeHarness({ cwd: root, env })
  await setup(h)
  expect(await run(['decision', 'prepare', 'd1'], h.io)).toBe(2)
  expect(await run(['decision', 'prepare', 'd1', '--reason', 'compare latency too'], h.io)).toBe(0)
  expect(h.out()).toContain('back in preparation')
  const d1 = (await loadPlan(root)).tasks.find((t) => t.id === 'd1')!
  expect(d1.check).toBeUndefined()
  expect(d1.notes.at(-1)).toMatchObject({ event: { kind: 'decision_prepare', reason: 'compare latency too' } })
  await run(['decision', 'answer', 'd1', '--answer', 'A', '--basis', 'chat'], h.io)
  h.reset()
  expect(await run(['decision', 'prepare', 'd1', '--reason', 'again'], h.io)).toBe(1)
  expect(h.err()).toContain('already closed')
})

it('decision without a subcommand prints usage', async () => {
  const h = makeHarness({ cwd: root, env })
  await setup(h)
  expect(await run(['decision'], h.io)).toBe(2)
  expect(await run(['decision', 'close', 'd1'], h.io)).toBe(2)
  expect(h.err()).toContain('decision answer')
})
