import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { makeRepo } from '../../core/test/git-helpers.js'
import { makeHarness } from './harness.js'

it('creates, selects, reports and removes a repository preset through orch', async () => {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-preset-cli-'))
  const h = makeHarness({ cwd: root, env: { HOME: home } })
  expect(await run(['init'], h.io)).toBe(0)
  expect(await run(['presets', 'add', 'dsh-only', '--label', 'Dsh only', '--code', 'dsh', '--design', 'dsh', '--review', 'dsh', '--research', 'dsh'], h.io)).toBe(0)
  expect(await run(['repo', 'preset', 'dsh-only'], h.io)).toBe(0)
  h.reset()
  expect(await run(['status'], h.io)).toBe(0)
  expect(h.out()).toContain('Preset: Dsh only (source: repository)')
  expect(await run(['plan', 'preset', 'dsh-only'], h.io)).toBe(0)
  h.reset()
  expect(await run(['status', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out())).toMatchObject({ effectiveRouting: { source: 'plan' } })
  h.reset()
  expect(await run(['presets', 'rm', 'dsh-only'], h.io)).toBe(0)
  expect(h.out()).toContain(`${root}:repository`)
  expect(h.out()).toContain(`${root}:plan:main`)
  h.reset()
  expect(await run(['status', '--json'], h.io)).toBe(0)
  expect(JSON.parse(h.out())).toMatchObject({ effectiveRouting: { source: 'builtin' } })
})

it('reports preset source and unknown selection in Russian when requested', async () => {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-preset-cli-'))
  const h = makeHarness({ cwd: root, env: { HOME: home } })
  await run(['init'], h.io)
  h.reset()
  expect(await run(['--lang', 'ru', 'status'], h.io)).toBe(0)
  expect(h.out()).toContain('источник: встроенный')
  h.reset()
  expect(await run(['--lang', 'ru', 'repo', 'preset', 'missing'], h.io)).toBe(1)
  expect(h.err()).toContain('Неизвестный пресет: missing')
})
