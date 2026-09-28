import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING } from '../src/routing/routing.js'
import { adoptImportedProfile, loadProfileStore, profileStorePath, writeProfileStore } from '../src/routing/profile-store.js'
import { forgetWorkerId, listPresets, presetsPath, savePreset } from '../src/routing/presets.js'
import { CLI_OF_TRANSPORT, SUBSCRIPTION_CLIS, billingOfTransport, cliRuns, collectWorkerFacts, duplicateKey, hasRunner, placeWorkers, workerTransport } from '../src/routing/worker-sections.js'
import type { Transport } from '../src/routing/profile-store.js'

describe('worker sections (wo1)', () => {
  it('V-wo1/transport places a worker by the transport it runs, never by its id', () => {
    const placed = placeWorkers([
      { id: 'claude/opus', transport: 'claude-cli', model: 'opus', registered: true },
      { id: 'gemini-cli', transport: 'gemini-cli', model: 'gemini-3.1-pro' },
      { id: 'grok', transport: 'grok-build', model: 'grok-5' },
      { id: 'api-looking-name', transport: 'codex-cli', model: 'gpt-6-sol' },
      { id: 'dsh/openrouter/qwen', transport: 'dsh', model: 'openrouter/qwen' },
      { id: 'codex-reserve', referenced: true },
    ])
    expect(Object.fromEntries(placed)).toEqual({
      'claude/opus': { section: 'subscription', cli: 'claude' },
      'gemini-cli': { section: 'subscription', cli: 'gemini' },
      grok: { section: 'subscription', cli: 'grok' },
      'api-looking-name': { section: 'subscription', cli: 'codex' },
      'dsh/openrouter/qwen': { section: 'dsh' },
      'codex-reserve': { section: 'other', other: 'stale' },
    })
    // Gemini CLI and Grok CLI are subscription CLIs; dsh and the API-only Claude route are «API».
    expect(['gemini-cli', 'grok-build', 'opencode', 'claude-cli', 'dsh', undefined].map((t) => billingOfTransport(t as never))).toEqual(['subscription', 'subscription', 'subscription', 'api-claude', 'api-dsh', 'other'])
    expect([workerTransport('claude/x'), workerTransport('codex/y'), workerTransport('dsh/z'), workerTransport('devin'), workerTransport('codex-reserve')]).toEqual(['claude-cli', 'codex-cli', 'dsh', 'devin-acp', undefined])
  })

  it('V-wo1/duplicates finds copies by transport, model and effort, keeping the registered or used one', () => {
    const placed = placeWorkers([
      { id: 'claude-code', transport: 'claude-cli', model: 'claude-sonnet-5', effort: 'high', imported: true, referenced: true },
      { id: 'claude-sonnet', transport: 'claude-cli', model: 'claude-sonnet-5', effort: 'high', imported: true },
      { id: 'claude-sonnet-low', transport: 'claude-cli', model: 'claude-sonnet-5', effort: 'low', imported: true, referenced: true },
      { id: 'claude/sonnet', transport: 'claude-cli', model: 'claude-sonnet-5', effort: 'low', registered: true },
      // dsh spells one model two ways: `deepseek-flash` is `deepseek-official/deepseek-flash`.
      { id: 'dsh/deepseek-flash', transport: 'dsh', model: 'deepseek-flash', registered: true },
      { id: 'flash-profile', transport: 'dsh', model: 'deepseek-official/deepseek-flash' },
    ])
    expect(placed.get('claude-code')).toEqual({ section: 'subscription', cli: 'claude' })
    expect(placed.get('claude-sonnet')).toEqual({ section: 'other', other: 'duplicate', duplicateOf: 'claude-code' })
    expect(placed.get('claude-sonnet-low')).toEqual({ section: 'other', other: 'duplicate', duplicateOf: 'claude/sonnet' })
    expect(placed.get('flash-profile')).toEqual({ section: 'other', other: 'duplicate', duplicateOf: 'dsh/deepseek-flash' })
    // An effort the CLI does not take is no effort: Devin at «high» is Devin.
    expect(duplicateKey({ id: 'a', transport: 'devin-acp', model: 'swe', effort: 'high' })).toBe(duplicateKey({ id: 'b', transport: 'devin-acp', model: 'swe' }))
  })

  it('V-wo1/imported keeps an older tool\'s unused profile in «Other» until a list names it', () => {
    const facts = collectWorkerFacts({
      registry: [{ id: 'codex/gpt-6-astra', kind: 'codex', model: 'gpt-6-astra', label: 'Codex GPT-6 Astra', billing: 'подписка' }],
      profiles: [{ id: 'old-codex', transport: 'codex-cli', model: 'gpt-6-sol', origin: 'porch-import' }, { id: 'used-codex', transport: 'codex-cli', model: 'gpt-6-luna', origin: 'porch-import' }, { id: 'codex', transport: 'codex-cli', model: 'gpt-6-astra' }],
      referenced: ['used-codex', 'codex'],
      aliases: { codex: 'codex/gpt-6-astra' },
    })
    // A saved alias folds into its direct worker, which counts the alias's use.
    expect(facts.map((item) => [item.id, item.referenced ?? false])).toEqual([['codex/gpt-6-astra', true], ['old-codex', false], ['used-codex', true]])
    const placed = placeWorkers(facts)
    expect(placed.get('old-codex')).toEqual({ section: 'other', other: 'imported' })
    expect(placed.get('used-codex')).toEqual({ section: 'subscription', cli: 'codex' })
  })

  it('V-wo1/adopt drops the porch-import tag; forget clears an id from routing and presets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-wo1-'))
    const env = { HOME: home }
    const store = await loadProfileStore(env, home)
    await writeProfileStore(profileStorePath(env, home), {
      ...store,
      profiles: { gemini: { model: 'gemini-3.1', transport: 'gemini-cli', displayName: 'Gemini', enabled: true, origin: 'porch-import' } },
      routing: { classes: { ...DEFAULT_ROUTING.classes, code: ['codex-reserve', 'devin'] }, disabled: { 'codex-reserve': 'x' } },
    })
    expect(await adoptImportedProfile(env, home, 'gemini')).toBe(true)
    expect((await loadProfileStore(env, home)).profiles.gemini).toEqual({ model: 'gemini-3.1', transport: 'gemini-cli', displayName: 'Gemini', enabled: true })
    expect(await adoptImportedProfile(env, home, 'gemini')).toBe(false)

    await mkdir(join(home, '.config', 'crewboard'), { recursive: true })
    await savePreset({ id: 'mine', label: 'Mine', routing: { code: ['codex-reserve'], design: [], review: ['devin', 'codex-reserve'], research: [] } }, env)
    expect(await forgetWorkerId('codex-reserve', env, home)).toEqual({ routing: true, presets: ['mine'] })
    const routing = (await loadProfileStore(env, home)).routing
    expect(routing.classes.code).toEqual(['devin'])
    expect(routing.disabled).toEqual({})
    expect((await listPresets(env))[0]?.routing).toEqual({ code: [], design: [], review: ['devin'], research: [] })
    expect(JSON.parse(await readFile(presetsPath(env), 'utf8'))).toMatchObject({ version: 1 })
  })
  it('V-wo2/runner a CLI runs tasks exactly when a runner backend exists for its transport — one predicate, no names', () => {
    for (const cli of SUBSCRIPTION_CLIS) {
      const transports = Object.entries(CLI_OF_TRANSPORT).flatMap(([transport, of]) => (of === cli ? [transport as Transport] : []))
      expect([cli, cliRuns(cli)]).toEqual([cli, transports.some(hasRunner)])
    }
    // rb1: a runner exists for every subscription CLI Crewboard discovers.
    for (const cli of SUBSCRIPTION_CLIS) expect(cliRuns(cli)).toBe(true)
    expect(hasRunner('dsh')).toBe(true)
  })
})
