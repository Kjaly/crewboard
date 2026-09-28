import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireSlot, defaultSlots, loadMaxSlots, saveMaxSlots, slotsDir, withSlot } from '../src/slots/slots.js'

// ql1: a machine-wide slot for heavy commands, so several baselines, checks and workers running tests do not
// all start at once and drive the load average through the roof.

let home: string
async function setup() {
  home = await mkdtemp(join(tmpdir(), 'orch-slots-'))
  return { env: {}, home }
}

describe('slot settings', () => {
  it('defaults to a quarter of the cores, at least one', () => {
    expect(defaultSlots()).toBeGreaterThanOrEqual(1)
  })

  it('loads the default without a settings file, then the saved value, then the env override', async () => {
    const { env, home } = await setup()
    expect(await loadMaxSlots(env, home)).toBe(defaultSlots())
    await saveMaxSlots(env, home, 5)
    expect(await loadMaxSlots(env, home)).toBe(5)
    expect(await loadMaxSlots({ CREWBOARD_CHECK_SLOTS: '2' }, home)).toBe(2)
  })

  it('refuses an invalid slot count', async () => {
    const { env, home } = await setup()
    await expect(saveMaxSlots(env, home, 0)).rejects.toThrow()
    await expect(saveMaxSlots(env, home, 1.5)).rejects.toThrow()
  })
})

describe('acquireSlot', () => {
  it('two users of one slot take turns: the second waits for the first to release', async () => {
    const { env, home } = await setup()
    const order: string[] = []
    let waitedAhead: number | undefined
    const first = await acquireSlot({ env, home, maxSlots: 1 })
    order.push('first-acquired')
    const secondPromise = acquireSlot({ env, home, maxSlots: 1, pollMs: 10, onWaiting: (ahead) => { waitedAhead = ahead } }).then((slot) => {
      order.push('second-acquired')
      return slot
    })
    // The second call is left waiting for a moment before the first releases.
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual(['first-acquired'])
    expect(waitedAhead).toBe(1)
    order.push('first-released')
    await first.release()
    const second = await secondPromise
    expect(order).toEqual(['first-acquired', 'first-released', 'second-acquired'])
    await second.release()
  })

  it('a crashed holder (same host, dead pid) is taken over at once', async () => {
    const { env, home } = await setup()
    const dir = slotsDir(env, home)
    await mkdir(dir, { recursive: true })
    // A pid this large is never a real process.
    await writeFile(join(dir, 'slot-stale.lock'), JSON.stringify({ pid: 999_999, host: hostname(), at: new Date().toISOString() }))
    const slot = await acquireSlot({ env, home, maxSlots: 1, pollMs: 10 })
    // The stale file was removed as part of finding the slot free.
    expect(await readdir(dir)).not.toContain('slot-stale.lock')
    await slot.release()
  })

  it('withSlot always releases, even when the function throws', async () => {
    const { env, home } = await setup()
    await expect(withSlot({ env, home, maxSlots: 1 }, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const dir = slotsDir(env, home)
    expect((await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.lock'))).toHaveLength(0)
  })
})
