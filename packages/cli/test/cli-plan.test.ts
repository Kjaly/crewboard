import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

describe('orch plan commands', () => {
  it('init creates the plan and the git exclude entry', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    expect(await run(['init', '--goal', 'Первый шкаф'], h.io)).toBe(0)
    expect((await loadPlan(root)).goal).toBe('Первый шкаф')
    expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toContain('.orchestration/')
    expect(await run(['--lang', 'ru', 'init'], h.io)).toBe(1)
    expect(h.err()).toContain('План уже есть')
  })

  it('task add/set and status show derived statuses', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    await run(['init', '--goal', 'g'], h.io)
    expect(await run(['task', 'add', 'plan', '--title', 'Утверждаю план', '--kind', 'decision'], h.io)).toBe(0)
    expect(await run(['task', 'add', 't1', '--title', 'Фикстуры', '--deps', 'plan', '--lane', 'Итерация 0'], h.io)).toBe(0)
    // A worker outside the preset is a person's choice (wp1): an agent without a TTY would be refused.
    expect(await run(['task', 'set', 't1', '--worker', 'deepseek-flash'], makeHarness({ cwd: root, isTTY: true }).io)).toBe(0)
    h.reset()
    expect(await run(['status', '--json'], h.io)).toBe(0)
    const status = JSON.parse(h.out()) as { views: { id: string; status: string; needsHuman: boolean }[]; ready: string[] }
    expect(status.views).toEqual([
      expect.objectContaining({ id: 'plan', status: 'ready', needsHuman: true }),
      expect.objectContaining({ id: 't1', status: 'blocked' }),
    ])
    expect(status.ready).toEqual([])
  })

  it('reports a schema refusal as an invalid plan, not as a crash', async () => {
    // zod/mini names its error `$ZodError`; matching on the name would turn this into a stack trace.
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    await run(['init'], h.io)
    expect(await run(['task', 'add', 'Bad_Id', '--title', 'x'], h.io)).toBe(1)
    expect(h.err()).toMatch(/^Invalid plan: /)
    expect(h.err()).toContain('"code": "invalid_format"')
    expect(h.err()).not.toContain('    at ')
  })

  it('rejects a dependency cycle and an unknown dependency', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    await run(['init'], h.io)
    await run(['task', 'add', 'a', '--title', 'A'], h.io)
    await run(['task', 'add', 'b', '--title', 'B', '--deps', 'a'], h.io)
    expect(await run(['task', 'set', 'a', '--deps', 'b'], h.io)).toBe(1)
    expect(h.err()).toContain('dependency cycle')
    expect(await run(['task', 'add', 'c', '--title', 'C', '--deps', 'zzz'], h.io)).toBe(1)
  })

  it('accept and reject need a human at a TTY', async () => {
    const root = await makeRepo()
    const bot = makeHarness({ cwd: root })
    await run(['init'], bot.io)
    await run(['task', 'add', 'plan', '--title', 'План', '--kind', 'decision'], bot.io)
    expect(await run(['--lang', 'ru', 'accept', 'plan'], bot.io)).toBe(1)
    expect(bot.err()).toContain('только человек')

    const human = makeHarness({ cwd: root, isTTY: true, answers: ['да'] })
    expect(await run(['accept', 'plan'], human.io)).toBe(0)
    expect((await loadPlan(root)).tasks[0]).toMatchObject({ status: 'accepted' })

    const human2 = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
    await run(['task', 'add', 't2', '--title', 'T2'], human2.io)
    expect(await run(['reject', 't2'], human2.io)).toBe(2)
    expect(await run(['reject', 't2', '--reason', 'нет теста'], human2.io)).toBe(0)
    const t2 = (await loadPlan(root)).tasks.find((t) => t.id === 't2')
    expect(t2).toMatchObject({ status: 'rejected' })
    expect(t2?.notes.at(-1)).toMatchObject({ type: 'reject', text: 'нет теста' })
  })

  it('prints help and rejects unknown commands', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    expect(await run(['help'], h.io)).toBe(0)
    expect(h.out()).toContain('crewboard run')
    expect(await run(['nope'], h.io)).toBe(2)
  })
})
