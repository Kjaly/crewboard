import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type NeedsYouItem, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

const AT = '2026-09-24T09:00:00Z'

/**
 * The nq1 report: four tasks in review, checked by the orchestrator, sat in the screen's «Needs you»
 * while `crewboard attention` printed «All clear». One decision and one task still being checked
 * (not the person's yet — vr1) complete the fixture.
 */
async function reviewPlan(env: NodeJS.ProcessEnv) {
  const root = await makeRepo()
  const h = makeHarness({ cwd: root, env, now: new Date('2026-09-24T10:00:00Z') })
  expect(await run(['init', '--goal', 'Harness'], h.io)).toBe(0)
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'busy']) expect(await run(['task', 'add', id, '--title', `Task ${id}`], h.io)).toBe(0)
  expect(await run(['task', 'add', 'pick', '--title', 'Pick a name', '--kind', 'decision'], h.io)).toBe(0)
  await updatePlan(root, (p) => {
    for (const task of p.tasks) {
      if (task.id === 'pick') continue
      task.status = 'in_review'
      if (task.id === 'r5') continue
      task.check = { state: task.id === 'busy' ? 'checking' : 'checked', at: AT, note: 'gates green' }
    }
    return p
  })
  h.reset()
  return { root, h }
}

const homeEnv = async (): Promise<NodeJS.ProcessEnv> => ({ ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) })

it('lists checked reviews, the unchecked one and the decision — not «All clear»', async () => {
  const { root, h } = await reviewPlan(await homeEnv())
  expect(await run(['attention', '--json'], h.io)).toBe(0)
  const items = JSON.parse(h.out()) as NeedsYouItem[]
  expect(items.map((i) => [i.kind, i.taskId, i.checked])).toEqual(
    expect.arrayContaining([
      ['review', 'r1', true],
      ['review', 'r2', true],
      ['review', 'r3', true],
      ['review', 'r4', true],
      ['review', 'r5', false],
      ['decision', 'pick', undefined],
    ]),
  )
  expect(items).toHaveLength(6)
  // Still being checked: the orchestrator's, not the person's.
  expect(items.some((i) => i.taskId === 'busy')).toBe(false)
  expect(items.every((i) => i.root === root && i.planId === 'main')).toBe(true)

  h.reset()
  expect(await run(['attention'], h.io)).toBe(0)
  const text = h.out()
  expect(text).not.toContain('All clear')
  expect(text).toContain('Waiting for review (5)')
  expect(text).toContain('Decisions (1)')
  expect(text).toMatch(/r1: Task r1 · checked by the orchestrator/)
  expect(text).toMatch(/r5: Task r5 · not checked by the orchestrator/)
  expect(text.indexOf('Waiting for review')).toBeLessThan(text.indexOf('Decisions'))
})

it('says «All clear» only when nothing waits, and keeps the old run alarms behind --alarms', async () => {
  const { h } = await reviewPlan(await homeEnv())
  expect(await run(['attention', '--alarms', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out())).toEqual([])
  h.reset()
  expect(await run(['attention', '--alarms'], h.io)).toBe(0)
  expect(h.out()).toContain('All clear')

  const quiet = makeHarness({ cwd: await makeRepo(), env: h.io.env })
  await run(['init'], quiet.io)
  quiet.reset()
  expect(await run(['attention'], quiet.io)).toBe(0)
  expect(quiet.out()).toContain('All clear')
})

it('--all covers every repository the screen lists', async () => {
  const env = await homeEnv()
  const first = await reviewPlan(env)
  const second = await reviewPlan(env)
  const elsewhere = makeHarness({ cwd: await mkdtemp(join(tmpdir(), 'orch-nowhere-')), env })
  // Needs no repository of its own: it reads the screen's list.
  expect(await run(['attention', '--all', '--json'], elsewhere.io)).toBe(0)
  const roots = new Set((JSON.parse(elsewhere.out()) as NeedsYouItem[]).map((i) => i.root))
  expect(roots).toEqual(new Set([first.root, second.root]))
  first.h.reset()
  expect(await run(['attention', '--all'], first.h.io)).toBe(0)
  expect(first.h.out()).toContain('Waiting for review (10)')
  expect(first.h.out()).toContain('[repo] r1')
})
