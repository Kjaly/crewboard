import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Exec } from '../src/exec.js'
import { registryPath, saveWorker } from '../src/routing/registry.js'
import { CLAUDE_MODELS, addSubscriptionWorkers, listSubscriptionModels, parseCodexModels, parseDevinModels, subscriptionEntries, subscriptionWorkerId } from '../src/routing/subscription-models.js'

// Trimmed from `codex debug models --bundled` (codex-cli 0.155) and `devin models list --format json` (devin 3000.11).
const CODEX = JSON.stringify({
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'x' }, { effort: 'high', description: 'y' }] },
    { slug: 'gpt-daybreak-blue-latest', display_name: 'Daybreak Blue', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_reasoning_levels: [] },
  ],
})
const DEVIN = JSON.stringify({
  families: [
    { family_label: 'Adaptive', variants: [{ model_uid: 'adaptive', label: 'Adaptive' }] },
    { family_label: 'SWE-2', variants: [{ model_uid: 'swe-2-high', label: 'SWE-2 High' }, { model_uid: 'swe-2-medium', label: 'SWE-2 Medium' }, { label: 'no uid' }] },
  ],
})

const execOf = (stdout: string, code = 0): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = []
  return { calls, exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code, stdout, stderr: code ? 'not logged in' : '', timedOut: false } } }
}

describe('subscription models (pv1)', () => {
  it('lists the models Codex shows in its picker, with their efforts', () => {
    expect(parseCodexModels(CODEX)).toEqual([
      { model: 'gpt-6-astra', label: 'Codex GPT-6-Astra', efforts: ['low', 'high'], defaultEffort: 'low' },
      { model: 'gpt-5.6-sol', label: 'Codex GPT-5.6-Sol', efforts: [] },
    ])
  })

  it('lists every Devin variant without an effort', () => {
    expect(parseDevinModels(DEVIN).map((m) => [m.model, m.label, m.efforts])).toEqual([
      ['adaptive', 'Devin Adaptive', []],
      ['swe-2-high', 'Devin SWE-2 High', []],
      ['swe-2-medium', 'Devin SWE-2 Medium', []],
    ])
  })

  it('asks each CLI its own catalog, through the configured binary, and Claude from the built-in list', async () => {
    const codex = execOf(CODEX)
    expect((await listSubscriptionModels('codex', { exec: codex.exec, commands: { codex: '/opt/codex' } })).models).toHaveLength(2)
    expect(codex.calls).toEqual([['/opt/codex', 'debug', 'models', '--bundled']])
    const devin = execOf(DEVIN)
    await listSubscriptionModels('devin', { exec: devin.exec })
    expect(devin.calls).toEqual([['devin', 'models', 'list', '--format', 'json']])
    const claude = execOf('')
    expect(await listSubscriptionModels('claude', { exec: claude.exec })).toMatchObject({ source: 'builtin', models: CLAUDE_MODELS })
    expect(claude.calls).toEqual([])
  })

  it('gemini and grok come from the built-in rows — no listing command is invoked', async () => {
    const fake = execOf('')
    const gemini = await listSubscriptionModels('gemini', { exec: fake.exec })
    expect(gemini.source).toBe('builtin')
    // Only the documented `--model` aliases (gemini-cli docs/cli/cli-reference.md) — never a versioned slug.
    expect(gemini.models.map((m) => m.model)).toEqual(['auto', 'pro', 'flash', 'flash-lite'])
    const grok = await listSubscriptionModels('grok', { exec: fake.exec })
    expect(grok).toMatchObject({ source: 'builtin', models: [{ model: 'grok-4.7' }] })
    expect(fake.calls).toEqual([])
  })

  it('names a failed or unreadable listing by its code', async () => {
    await expect(listSubscriptionModels('devin', { exec: execOf('', 1).exec })).rejects.toMatchObject({ code: 'cli_failed' })
    await expect(listSubscriptionModels('codex', { exec: execOf('not json').exec })).rejects.toMatchObject({ code: 'bad_output' })
  })

  it('makes one worker per model and effort with the documented ids', () => {
    expect(subscriptionWorkerId('claude', 'claude-sonnet-5', 'high')).toBe('claude/sonnet-5-high')
    expect(subscriptionEntries('claude', [{ model: 'claude-sonnet-5', label: 'Claude Sonnet 5' }], ['high', 'medium'])).toEqual([
      { id: 'claude/sonnet-5-high', kind: 'claude', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', effort: 'high', billing: 'подписка' },
      { id: 'claude/sonnet-5-medium', kind: 'claude', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', effort: 'medium', billing: 'подписка' },
    ])
    expect(subscriptionEntries('codex', [{ model: 'gpt-6-astra', label: 'Codex GPT-6-Astra' }]).map((e) => e.id)).toEqual(['codex/gpt-6-astra'])
    expect(subscriptionEntries('devin', [{ model: 'swe-2-high', label: 'Devin SWE-2 High' }], ['high'])).toEqual([{ id: 'devin/swe-2-high', kind: 'devin', model: 'swe-2-high', label: 'Devin SWE-2 High', billing: 'промо' }])
  })

  it('registers new workers with their profiles and leaves an existing one as the person named it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pv1-home-'))
    const file = registryPath({}, home)
    await saveWorker(file, { id: 'claude/sonnet-5-high', kind: 'claude', model: 'claude-sonnet-5', label: 'My Sonnet', effort: 'high', billing: 'подписка' })
    const result = await addSubscriptionWorkers({}, home, file, subscriptionEntries('claude', [{ model: 'claude-sonnet-5', label: 'Claude Sonnet 5' }], ['high', 'low']))
    expect(result).toEqual({ added: ['claude/sonnet-5-low'], existing: ['claude/sonnet-5-high'] })
    const registry = JSON.parse(await readFile(file, 'utf8')) as { workers: Array<{ id: string; label: string }> }
    expect(registry.workers.find((w) => w.id === 'claude/sonnet-5-high')?.label).toBe('My Sonnet')
    const profiles = JSON.parse(await readFile(join(home, '.config/crewboard/profiles.json'), 'utf8')) as { profiles: Record<string, unknown> }
    expect(profiles.profiles['claude/sonnet-5-low']).toMatchObject({ model: 'claude-sonnet-5', transport: 'claude-cli', effort: 'low' })
  })
})
