import { describe, expect, it } from 'vitest'
import { criticalPath, deriveViews, loadPlan, readySet, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

async function setup() {
  const root = await makeRepo()
  const bot = makeHarness({ cwd: root })
  await run(['init'], bot.io)
  await run(['task', 'add', 'a', '--title', 'A'], bot.io)
  await run(['task', 'add', 'b', '--title', 'B', '--deps', 'a'], bot.io)
  await run(['task', 'add', 'c', '--title', 'C'], bot.io)
  bot.reset()
  return { root, bot }
}

// w1f: a task that is no longer needed is closed for good. `reject` sends it back (ready again) and
// `supersede` needs a winner; `drop` is the third way out, and like accept/reject it belongs to a person.
describe('crewboard drop', () => {
  it('refuses an agent: without a terminal nothing changes', async () => {
    const { root, bot } = await setup()
    expect(await run(['drop', 'c', '--reason', 'not needed'], bot.io)).toBe(1)
    expect(bot.err()).toContain('Only a human')
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'c')?.status).toBe('ready')
  })

  it('needs a reason', async () => {
    const { root } = await setup()
    const human = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
    expect(await run(['drop', 'c'], human.io)).toBe(2)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'c')?.status).toBe('ready')
  })

  it('keeps the task when the person says no', async () => {
    const { root } = await setup()
    const human = makeHarness({ cwd: root, isTTY: true, answers: ['n'] })
    expect(await run(['drop', 'c', '--reason', 'not needed'], human.io)).toBe(1)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'c')?.status).toBe('ready')
  })

  it('closes the task for good: in history, never ready again, off the critical path, not launchable', async () => {
    const { root } = await setup()
    const human = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
    expect(await run(['--lang', 'ru', 'drop', 'a', '--reason', 'сделали руками'], human.io)).toBe(0)
    expect(human.out()).toContain('a закрыта как ненужная')
    const plan = await loadPlan(root)
    const task = plan.tasks.find((t) => t.id === 'a')!
    expect(task.status).toBe('dropped')
    expect(task.notes.at(-1)).toMatchObject({ event: { kind: 'dropped', reason: 'сделали руками' } })
    const views = deriveViews(plan)
    expect(views.find((v) => v.task.id === 'a')?.status).toBe('dropped')
    expect(readySet(views)).not.toContain('a')
    expect(criticalPath(plan)).not.toContain('a')

    const status = makeHarness({ cwd: root })
    await run(['status', '--json'], status.io)
    const json = JSON.parse(status.out()) as { ready: string[]; criticalPath: string[]; views: { id: string; status: string }[] }
    expect(json.ready).not.toContain('a')
    expect(json.criticalPath).not.toContain('a')
    expect(json.views.find((t) => t.id === 'a')?.status).toBe('dropped')

    // Nothing brings it back through the ordinary paths.
    expect(await run(['task', 'set', 'a', '--status', 'ready'], status.io)).not.toBe(0)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'a')?.status).toBe('dropped')
    expect(await run(['run', 'a'], status.io)).toBe(1)
    expect(status.err()).toContain('closed as not needed')
  })

  it('refuses a task that is already closed', async () => {
    const { root } = await setup()
    await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'c')!.status = 'accepted'; return p })
    const human = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
    expect(await run(['drop', 'c', '--reason', 'late'], human.io)).toBe(1)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'c')?.status).toBe('accepted')
  })
})
