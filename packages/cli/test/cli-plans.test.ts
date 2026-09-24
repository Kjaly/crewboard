import { describe, expect, it } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { run } from '../src/cli.js'
import { makeRepo } from '../../core/test/git-helpers.js'
import { makeHarness } from './harness.js'

describe('orch plan', () => {
  it('creates, lists, switches, archives and renames plans', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    await run(['init', '--goal', 'Старый'], h.io)
    expect(await run(['plan', 'new', 'next', '--goal', 'Новый'], h.io)).toBe(0)
    expect((await loadPlan(root)).goal).toBe('Новый')
    expect(await run(['plan', 'list'], h.io)).toBe(0)
    expect(h.out()).toContain('● next')
    expect(h.out()).toContain('○ main')
    expect(await run(['plan', 'use', 'main'], h.io)).toBe(0)
    expect((await loadPlan(root)).goal).toBe('Старый')
    expect(await run(['plan', 'archive', 'next'], h.io)).toBe(0)
    expect(await run(['plan', 'rename', 'main', '--goal', 'Переименован'], h.io)).toBe(0)
    expect((await loadPlan(root)).goal).toBe('Переименован')
    expect(await run(['plan', 'use', 'zzz'], h.io)).toBe(1)
    expect(await run(['plan'], h.io)).toBe(2)
  })

  it('names a missing --plan and lists the plans the repository has', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    await run(['init', '--goal', 'Main'], h.io)
    await run(['plan', 'new', 'next', '--goal', 'Other'], h.io)
    h.reset()
    expect(await run(['status', '--plan', 'zzz'], h.io)).toBe(1)
    expect(h.err()).toContain('Plan zzz does not exist')
    expect(h.err()).toContain('main')
    expect(h.err()).toContain('next')
    expect(h.err()).not.toContain('crewboard init')
    // The same diagnosis covers every --plan command, not just status.
    h.reset()
    expect(await run(['wait', '--plan', 'zzz'], h.io)).toBe(1)
    expect(h.err()).toContain('Plan zzz does not exist')
    expect(h.err()).toContain('main')
  })

  it('keeps the init hint when the repository has no plans at all', async () => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root })
    expect(await run(['status', '--plan', 'zzz'], h.io)).toBe(1)
    expect(h.err()).toContain('crewboard init')
  })
})
