import { describe, expect, it } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

describe('orch supersede', () => {
  it('needs a human at a TTY and a --by task', async () => {
    const root = await makeRepo()
    const bot = makeHarness({ cwd: root })
    await run(['init'], bot.io)
    await run(['task', 'add', 'a', '--title', 'A'], bot.io)
    await run(['task', 'add', 'b', '--title', 'B'], bot.io)
    expect(await run(['supersede', 'b', '--by', 'a'], bot.io)).toBe(1)
    const human = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
    expect(await run(['supersede', 'b'], human.io)).toBe(2)
    expect(await run(['--lang', 'ru', 'supersede', 'b', '--by', 'a'], human.io)).toBe(0)
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'b')).toMatchObject({ status: 'superseded' })
    expect(human.out()).toContain('⊘ b вытеснена задачей a')
  })
})
