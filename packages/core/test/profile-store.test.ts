import { olderConfigPath } from '../src/routing/profile-store.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadProfileStore, loadSidebarOrder, profileStorePath, setSidebarOrder } from '../src/routing/profile-store.js'
import { resolveRouting } from '../src/routing/presets.js'
import { removeWorker } from '../src/routing/delete.js'
import { registryPath } from '../src/routing/registry.js'
import { saveRouting } from '../src/routing/routing.js'
import { resolveProfile } from '../src/orchestration/backends.js'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'orch-profile-migrate-'))
  const legacy = olderConfigPath({}, home)
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  const source = {
    agents: {
      devin: { backend: 'devin-cli', model: 'swe-2-high', enabled: false, label: 'Devin SWE', effort: 'high', supports_delegate: true },
      'opencode-specialist': { backend: 'opencode', model: 'openai/gpt-5', enabled: true, label: 'Specialist', effort: 'xhigh' },
    },
    routing: { classes: { code: ['opencode-specialist', 'devin'], design: ['devin'], review: ['codex', 'devin'], research: ['opencode-specialist'] }, disabled: { devin: 'quota exhausted' } },
    aliases: { 'old-specialist': 'opencode-specialist' },
  }
  await writeFile(legacy, JSON.stringify(source))
  return { home, legacy, source, env: { HOME: home } }
}

it('migrates a real-shaped saved config once with profiles, aliases, routing and disabled reasons', async () => {
  const { home, legacy, source, env } = await fixture()
  const store = await loadProfileStore(env, home)
  expect(store).toMatchObject({ version: 1, routing: source.routing, aliases: source.aliases })
  expect(store.profiles.devin).toMatchObject({ model: 'swe-2-high', transport: 'devin-acp', displayName: 'Devin SWE', effort: 'high' })
  expect(store.profiles['opencode-specialist']).toMatchObject({ model: 'openai/gpt-5', transport: 'opencode', displayName: 'Specialist' })
  expect(await readFile(legacy, 'utf8')).toBe(JSON.stringify(source))
  const saved = JSON.parse(await readFile(profileStorePath(env, home), 'utf8')) as { version: number }
  expect(saved.version).toBe(1)
})

it('second start reads only the migrated file and leaves it byte-for-byte unchanged', async () => {
  const { home, legacy, env } = await fixture()
  const first = await loadProfileStore(env, home)
  const path = profileStorePath(env, home)
  const bytes = await readFile(path, 'utf8')
  await writeFile(legacy, '{ invalid json')
  expect(await loadProfileStore(env, home)).toEqual(first)
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it('keeps an old id routable and refuses a disabled worker after migration', async () => {
  const { home, env } = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'orch-profile-repo-'))
  const route = await resolveRouting(root, undefined, env)
  expect(route.routing.code).toContain('opencode-specialist')
  expect(route.routing.code).not.toContain('devin')
  expect(route.disabled.devin).toBe('quota exhausted')
  expect(await resolveProfile(env, home, 'opencode-specialist')).toMatchObject({ backend: 'opencode', model: 'openai/gpt-5' })
})

it('removes an imported extra profile and its alias without changing the source', async () => {
  const { home, legacy, env } = await fixture()
  await loadProfileStore(env, home)
  const result = await removeWorker(registryPath(env, home), profileStorePath(env, home), 'opencode-specialist', env, home)
  expect(result.removed).toEqual(expect.arrayContaining(['opencode-specialist', 'old-specialist']))
  const store = await loadProfileStore(env, home)
  expect(store.profiles).not.toHaveProperty('opencode-specialist')
  expect(store.aliases).not.toHaveProperty('old-specialist')
  expect(store.routing.classes.code).not.toContain('opencode-specialist')
  expect(JSON.parse(await readFile(legacy, 'utf8'))).toHaveProperty('agents.opencode-specialist')
})

it('saves, merges and resets the manual sidebar order without touching repo flags', async () => {
  const { home, env } = await fixture()
  await setSidebarOrder(env, home, { repos: ['/b', '/a'] })
  await setSidebarOrder(env, home, { plans: { '/a': ['/a/p2', '/a/p1'] } })
  expect(await loadSidebarOrder(env, home)).toEqual({ repos: ['/b', '/a'], plans: { '/a': ['/a/p2', '/a/p1'] } })

  // A later plans patch merges into the stored map; an empty list removes one entry.
  await setSidebarOrder(env, home, { plans: { '/b': ['/b/x'] } })
  await setSidebarOrder(env, home, { plans: { '/a': [] } })
  expect(await loadSidebarOrder(env, home)).toEqual({ repos: ['/b', '/a'], plans: { '/b': ['/b/x'] } })

  // Reset drops the key entirely, so the file carries no empty order.
  await setSidebarOrder(env, home, null)
  expect(await loadSidebarOrder(env, home)).toEqual({})
  expect(JSON.parse(await readFile(profileStorePath(env, home), 'utf8'))).not.toHaveProperty('order')
})

it('serializes concurrent routing writes without losing unrelated changes', async () => {
  const { home, env } = await fixture()
  const path = profileStorePath(env, home)
  const initial = await loadProfileStore(env, home)
  await Promise.all([
    saveRouting(path, { ...initial.routing, disabled: { devin: 'first' } }, env, home),
    saveRouting(path, { ...initial.routing, disabled: { devin: 'second' } }, env, home),
  ])
  expect((await loadProfileStore(env, home)).routing.disabled.devin).toBe('second')
})
