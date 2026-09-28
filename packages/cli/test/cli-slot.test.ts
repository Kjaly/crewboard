import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { slotsSettingsPath } from '@crewboard/core'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// ql1: `crewboard slot -- <command…>` waits for a free machine-wide slot, then runs the command unchanged.

async function place() {
  const home = await mkdtemp(join(tmpdir(), 'orch-slot-cli-'))
  const env = { ...process.env, HOME: home }
  return { home, env, h: makeHarness({ cwd: home, env }) }
}

it('runs the command and passes its exit code and output through unchanged', async () => {
  const { h } = await place()
  expect(await run(['slot', '--', 'sh', '-c', 'echo out-line; echo err-line 1>&2; exit 3'], h.io)).toBe(3)
  expect(h.out()).toBe('out-line\n')
  expect(h.err()).toBe('err-line\n')
})

it('reports success at exit 0', async () => {
  const { h } = await place()
  expect(await run(['slot', '--', 'sh', '-c', 'echo hi'], h.io)).toBe(0)
  expect(h.out()).toBe('hi\n')
})

it('--set persists the slot count, a bare slot shows it', async () => {
  const { h, env, home } = await place()
  expect(await run(['slot', '--set', '3'], h.io)).toBe(0)
  expect(h.out()).toContain('3')
  expect(JSON.parse(await readFile(slotsSettingsPath(env, home), 'utf8'))).toMatchObject({ maxSlots: 3 })
  h.reset()
  expect(await run(['slot'], h.io)).toBe(0)
  expect(h.out()).toContain('3')
})

it('refuses an invalid --set value', async () => {
  const { h } = await place()
  expect(await run(['slot', '--set', 'nope'], h.io)).toBe(2)
})

it('a second caller waits for the first to release the one slot it configured', async () => {
  const { h } = await place()
  expect(await run(['slot', '--set', '1'], h.io)).toBe(0)
  h.reset()
  const order: string[] = []
  const first = run(['slot', '--', 'sh', '-c', 'sleep 0.3; echo first'], h.io).then((code) => {
    order.push('first')
    return code
  })
  await new Promise((r) => setTimeout(r, 50))
  const second = run(['slot', '--', 'sh', '-c', 'echo second'], h.io).then((code) => {
    order.push('second')
    return code
  })
  expect(await Promise.all([first, second])).toEqual([0, 0])
  expect(order).toEqual(['first', 'second'])
  expect(h.err()).toContain('waiting for a check slot (1 ahead)')
})
