import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAgents } from '../src/workers/agents.js'
import { ConflictError } from '../src/owner.js'

it('layers presets over defaults, disables them and round-trips model metadata with an exact backup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cb-config-'))
  const path = join(home, 'agents.json')
  const original = JSON.stringify({ agents: { codex: { models: [{ id: 'custom', note: 'keep', efforts: ['medium', 'high'] }] } }, presets: { cheap: false, normal: { agent: 'codex', model: 'custom', effort: 'high', note: 'use this' } } })
  await writeFile(path, original)
  const agents = createAgents({ CREWBOARD_HOME: home })
  const before = await agents.config()
  expect(await agents.presets()).toMatchObject({ normal: { model: 'custom', effort: 'high' }, hard: { effort: 'high' }, review: { model: 'opus' } })
  expect((await agents.presets()).cheap).toBeUndefined()
  const saved = await agents.save({ ...before.config, agents: { ...before.config.agents, claude: { enabled: false } } }, before.revision)
  expect(await readFile(`${path}.bak`, 'utf8')).toBe(original)
  expect((await agents.config()).revision).toBe(saved.revision)
  expect((await agents.get('codex'))?.models).toEqual([{ id: 'custom', note: 'keep', efforts: ['medium', 'high'] }])
  expect(await agents.get('claude')).toBeUndefined()
  expect(saved.agents.find((a) => a.id === 'claude')?.enabled).toBe(false)
})

it('refuses stale reads and serializes simultaneous saves, including creation of a missing registry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cb-config-'))
  const path = join(home, 'agents.json')
  const agents = createAgents({ CREWBOARD_HOME: home })
  const before = await agents.config()
  const attempts = await Promise.allSettled([
    agents.save({ agents: { codex: { effort: 'medium' } } }, before.revision),
    agents.save({ agents: { codex: { effort: 'high' } } }, before.revision),
  ])
  expect(attempts.map((a) => a.status)).toEqual(['fulfilled', 'rejected'])
  const current = await agents.config()
  await writeFile(path, '{"agents":{"codex":{"enabled":false}}}')
  await expect(agents.save(current.config, current.revision)).rejects.toBeInstanceOf(ConflictError)
  expect(await agents.get('codex')).toBeUndefined()
})

it.each([
  { agents: { codex: { models: [{ id: 'm', efforts: [42] }] } } },
  { agents: { codex: { effort: 'bogus' } } },
  { presets: { custom: { agent: 'missing' } } },
])('rejects invalid settings without modifying the file: %j', async (value) => {
  const home = await mkdtemp(join(tmpdir(), 'cb-config-'))
  const path = join(home, 'agents.json')
  await writeFile(path, '{"agents":{}}')
  const agents = createAgents({ CREWBOARD_HOME: home })
  const before = await agents.config()
  await expect(agents.save(value, before.revision)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{"agents":{}}')
})
