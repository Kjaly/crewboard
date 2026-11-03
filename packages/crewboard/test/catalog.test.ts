import { afterEach, expect, it, vi } from 'vitest'
import type { Exec } from '@crewboard/core'
import { createLeadCommands } from '../src/lead/commands.js'
import { BUILTIN_AGENTS, builtinAgents, type AgentEntry } from '../src/workers/agents.js'
import { createModelCatalog } from '../src/workers/catalog.js'

const agent = (run: AgentEntry['run'], model = 'listed'): AgentEntry => ({ ...BUILTIN_AGENTS[0]!, id: run, run, model, models: [{ id: model, label: 'Registry label', efforts: ['low'] }, { id: 'missing' }] })
afterEach(() => vi.useRealTimers())

it.each([
  { run: 'codex' as const, output: '{"models":[{"slug":"listed","display_name":"CLI label"},{"id":"new","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]}]}', args: ['debug', 'models'], found: true },
  { run: 'opencode' as const, output: 'provider/listed\nprovider/new\n', args: ['models'], found: true },
  { run: 'codex' as const, output: 'Usage: codex debug <COMMAND>', args: ['debug', 'models'], found: false },
  { run: 'codex' as const, output: 'hang', args: ['debug', 'models'], found: false },
])('merges $run models without treating an unavailable catalog as an exclusion ($output)', async ({ run, output, args, found }) => {
  vi.useFakeTimers()
  const calls: unknown[] = []
  const exec: Exec = async (cmd, argv, opts) => {
    calls.push([cmd, argv, opts?.timeoutMs])
    if (output === 'hang') return new Promise(() => {})
    return { code: 0, stdout: output, stderr: '', timedOut: false }
  }
  const catalog = createModelCatalog({ env: { CREWBOARD_CODEX_COMMAND: 'my-codex' }, exec })
  const a = agent(run, run === 'opencode' ? 'provider/listed' : 'listed')
  const pending = catalog.get(a)
  await vi.advanceTimersByTimeAsync(10_000)
  const models = await pending
  expect(calls).toEqual([[run === 'codex' ? 'my-codex' : run, args, 10_000]])
  expect(models.find((m) => m.id === a.model)).toMatchObject({ label: 'Registry label', efforts: ['low'], source: found ? 'discovered' : 'suggested' })
  expect(models.find((m) => m.id === 'missing')?.status).toBe(found ? 'not_listed' : undefined)
  expect(models.filter((m) => m.source === 'discovered')).toHaveLength(found ? 2 : 0)
  if (run === 'codex' && found) expect(models.find((m) => m.id === 'new')?.efforts).toEqual(['low', 'high'])
  // A failed CLI source cannot stop the built-in alias source.
  expect((await catalog.get(agent('claude', 'sonnet'))).some((m) => m.id === 'opus' && m.discoveredAt !== null)).toBe(true)
})

it('caches per agent, refreshes on demand and reads public OpenRouter prices with a bounded fallback', async () => {
  vi.useFakeTimers()
  let now = 0
  let reads = 0
  const requests: RequestInit[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    reads++
    requests.push(init ?? {})
    return new Response(JSON.stringify({ data: [
      { id: 'author/model', name: 'Router model', pricing: { prompt: '0.000002', completion: '0' }, supported_parameters: ['tools'] },
      { id: 'author/plain', pricing: { prompt: '-1', completion: 'bad' }, supported_parameters: [] },
      ...Array.from({ length: 32 }, (_, i) => ({ id: `author/extra-${i}` })),
    ] }))
  }
  const catalog = createModelCatalog({ env: {}, exec: async () => { throw new Error('missing CLI') }, fetch: fetcher, now: () => new Date(now) })
  const a = agent('dsh', 'openrouter/author/model')
  const [first, concurrent] = await Promise.all([catalog.get(a), catalog.get(a)])
  expect(concurrent).toEqual(first)
  expect(first[0]).toMatchObject({ id: a.model, source: 'discovered', discoveredAt: new Date(0).toISOString(), pricing: { prompt: 2, completion: 0 }, tools: true })
  expect(first.find((m) => m.id === 'openrouter/author/plain')).toMatchObject({ tools: false })
  expect(first.find((m) => m.id === 'openrouter/author/plain')?.pricing).toBeUndefined()
  await Promise.all([catalog.get(a), catalog.get(a)])
  expect(reads).toBe(1)
  expect(requests[0]?.headers).toBeUndefined()
  now = 600_000
  await catalog.get(a)
  await catalog.get(a, true)
  expect(reads).toBe(3)
  const updated = await catalog.get({ ...a, models: [{ id: 'updated' }] })
  expect(updated.some((m) => m.id === 'updated')).toBe(true)
  expect(reads).toBe(3)
  const commands = createLeadCommands(async () => { throw new Error('not used') }, () => new Date(now), { ...builtinAgents, list: async () => [a] }, catalog)
  const compact = (await commands.agents()).agents[0]!.catalog
  expect(compact).toHaveLength(30)
  expect(compact.every((m) => m.source === 'discovered')).toBe(true)
  expect((await catalog.get({ ...a, id: 'another' })).length).toBeGreaterThan(30)
  expect(reads).toBe(4)
  let executions = 0
  const disabled = createModelCatalog({ env: { CREWBOARD_NO_CATALOG: '1' }, exec: async () => { executions++; throw new Error('must not run') }, fetch: fetcher })
  expect((await disabled.get(a, true)).every((m) => m.source === 'suggested')).toBe(true)
  await disabled.get(agent('codex'))
  expect((await disabled.get(agent('claude', 'sonnet'))).some((m) => m.source === 'discovered')).toBe(true)
  expect(executions).toBe(0)
  expect(reads).toBe(4)
  const stalled = createModelCatalog({ env: {}, exec: async () => { throw new Error('missing') }, fetch: async () => new Promise(() => {}) })
  const pending = stalled.get(a)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await pending).every((m) => m.source === 'suggested' && !m.status)).toBe(true)
})
