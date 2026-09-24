import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finishSteers, readSteer, steerIdOfMail, steerMailName, writeSteer } from '../src/runs/steers.js'

describe('terminal steer disposition', () => {
  for (const reason of ['run_finished', 'run_failed', 'cancelled'] as const) it(`abandons queued steers on ${reason} while writing final state`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-steers-'))
    await writeSteer(dir, { id: 'one', createdAt: '2026-09-23T00:00:00Z', mode: 'auto', preview: 'fix it', file: '/tmp/fix', state: 'queued', timestamps: { queued: '2026-09-23T00:00:00Z' } })
    await finishSteers(dir, reason, async () => { expect((await readSteer(dir, 'one'))?.state).toBe('abandoned'); await readFile(join(dir, 'steers', 'one.json')) })
    expect(await readSteer(dir, 'one')).toMatchObject({ state: 'abandoned', reason })
  })
})

describe('mailbox names', () => {
  it('V-st1/mail-id reads the steer id back from the name the backends write', () => {
    const id = '2f832e26-00dd-46f1-8fca-18527f360e6f'
    expect(steerIdOfMail(steerMailName(id, 1790252752226))).toBe(id)
    expect(steerIdOfMail('steer-1790252752226-2f832e26-00dd-46f1-8fca-18527f360e6f.md')).toBe(id)
    expect(steerIdOfMail('cancel')).toBeUndefined()
  })
  it('abandons a direction that was written but never taken by the worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-steers-'))
    await writeSteer(dir, { id: 'one', createdAt: '2026-09-23T00:00:00Z', mode: 'auto', preview: 'fix it', file: '/tmp/fix', state: 'sent', timestamps: { queued: '2026-09-23T00:00:00Z', sent: '2026-09-23T00:00:01Z' } })
    await finishSteers(dir, 'cancelled', async () => {})
    expect(await readSteer(dir, 'one')).toMatchObject({ state: 'abandoned', reason: 'cancelled' })
  })
})
