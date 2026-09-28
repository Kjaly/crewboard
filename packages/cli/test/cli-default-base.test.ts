import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { nodeExec } from '../../core/src/exec.js'
import { makeRepo } from '../../core/test/git-helpers.js'
import { makeHarness } from './harness.js'

const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

// bs1: `repo default-base` and `plan default-base` set the base new copies branch from — never whatever the
// main checkout happens to have checked out.

it('shows the git-derived default with no override, then a repository override, then a plan override', async () => {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-default-base-cli-'))
  const h = makeHarness({ cwd: root, env: { HOME: home } })
  expect(await run(['init'], h.io)).toBe(0)
  h.reset()
  expect(await run(['repo', 'default-base'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base: main (source: repository default (origin/HEAD, else main/master))')

  await git(root, 'branch', 'develop')
  h.reset()
  expect(await run(['repo', 'default-base', 'develop'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base set: develop')
  h.reset()
  expect(await run(['repo', 'default-base'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base: develop (source: repository setting)')

  await git(root, 'branch', 'release')
  h.reset()
  expect(await run(['plan', 'default-base', 'release'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base set: release')
  h.reset()
  expect(await run(['repo', 'default-base'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base: release (source: plan setting)')

  h.reset()
  expect(await run(['plan', 'default-base', '--clear'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base override cleared.')
  h.reset()
  expect(await run(['repo', 'default-base'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base: develop (source: repository setting)')

  h.reset()
  expect(await run(['repo', 'default-base', '--clear'], h.io)).toBe(0)
  h.reset()
  expect(await run(['repo', 'default-base'], h.io)).toBe(0)
  expect(h.out()).toContain('Default base: main (source: repository default')
})

it('renders the same in Russian', async () => {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-default-base-cli-'))
  const h = makeHarness({ cwd: root, env: { HOME: home } })
  await run(['init'], h.io)
  h.reset()
  expect(await run(['--lang', 'ru', 'repo', 'default-base'], h.io)).toBe(0)
  expect(h.out()).toContain('База по умолчанию: main (источник: база репозитория')
})
