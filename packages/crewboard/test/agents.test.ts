import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentsFileError, type AgentIcon, type AgentRun, BUILTIN_AGENTS, createAgents, resolveAgentIcon } from '../src/workers/agents.js'
import { leadLabel } from '../src/lead/clients.js'

const withFile = async (file?: unknown) => {
  const home = await mkdtemp(join(tmpdir(), 'cb-agents-'))
  if (file !== undefined) await writeFile(join(home, 'agents.json'), typeof file === 'string' ? file : JSON.stringify(file))
  return { home, agents: createAgents({ CREWBOARD_HOME: home }) }
}

describe('lead clients', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['codex-mcp-client', 'Codex'],
    ['dsh-acp', 'dsh'],
    ['claude-desktop', 'claude-desktop'],
    ['my-agent', 'my-agent'],
    ['', undefined],
  ])('%s is shown as %s', (client, label) => {
    expect(leadLabel(client)).toBe(label)
  })
})

describe('agent icons', () => {
  const cases: Array<[AgentRun, string, AgentIcon | undefined]> = [
    ['claude', 'sonnet', 'claude'],
    ['codex', 'gpt-6.1-sol', 'codex'],
    ['gemini', 'gemini-3-pro', 'gemini'],
    ['grok', 'grok-4', 'grok'],
    ['cursor', 'default', 'cursor'],
    ['devin', 'default', 'devin'],
    ['opencode', 'zai/glm-5.2', 'opencode'],
    ['dsh', 'deepseek-flash', 'deepseek'],
    ['dsh', 'moonshot/kimi-k3', 'kimi'],
    ['dsh', 'kimi-k3', 'kimi'],
    ['dsh', 'zhipu/glm-5.2', 'zhipu'],
    ['dsh', 'glm-5.2', 'zhipu'],
    ['dsh', 'qwen3-max', 'qwen'],
    ['dsh', 'mistral-large', 'mistral'],
    ['dsh', 'openrouter/other', undefined],
  ]

  it.each(cases)('%s with %s uses %s', (run, model, icon) => {
    expect(resolveAgentIcon(run, model)).toBe(icon)
  })

  it('lets a registry entry name the icon over the run and model', async () => {
    const { agents } = await withFile({ agents: { kimi: { run: 'dsh', model: 'moonshot/kimi-k3', icon: 'openai' } } })
    expect((await agents.get('kimi'))?.icon).toBe('openai')
  })

  it('rejects an unknown icon with the field and the allowed names', async () => {
    const { agents } = await withFile({ agents: { x: { run: 'dsh', model: 'm', icon: 'not-a-logo' } } })
    await expect(agents.list()).rejects.toThrow(/agents\.x\.icon: an icon is one of: claude/)
  })
})

describe('agent registry', () => {
  it.each([
    ['claude', 'high', undefined],
    ['codex', 'ultra', undefined],
    ['claude', 'ultra', 'allowed levels: low, medium, high, xhigh, max'],
    ['deepseek', 'high', 'takes no effort'],
  ])('validates the default effort for %s: %s', async (id, effort, error) => {
    const { agents } = await withFile({ agents: { [id]: { effort } } })
    if (error) await expect(agents.list()).rejects.toThrow(error)
    else expect(await agents.get(id)).toMatchObject({ effort })
  })

  it.each([
    ['no file: the built-in three', undefined, ['claude', 'codex', 'deepseek']],
    ['adds an agent through dsh', { agents: { kimi: { label: 'Kimi', run: 'dsh', model: 'moonshot/kimi-k3' } } }, ['claude', 'codex', 'deepseek', 'kimi']],
    ['turns a built-in off', { agents: { deepseek: { enabled: false } } }, ['claude', 'codex']],
  ])('%s', async (_n, file, ids) => {
    const { agents } = await withFile(file)
    expect((await agents.list()).map((a) => a.id)).toEqual(ids)
  })

  it('builds the core id from the entry, with a model override', async () => {
    const { agents } = await withFile({ agents: { kimi: { label: 'Kimi', run: 'dsh', model: 'moonshot/kimi-k3' } } })
    expect(agents.coreId((await agents.get('kimi'))!)).toBe('dsh/moonshot/kimi-k3')
    expect(agents.coreId((await agents.get('codex'))!, 'gpt-6-luna')).toBe('codex/gpt-6-luna')
  })

  it('keeps model suggestions and their optional labels and notes when defaults change', async () => {
    const models = [{ id: 'custom-fast', label: 'Fast', note: 'For short tasks' }, { id: 'custom-large' }]
    const { agents } = await withFile({ agents: { codex: { model: 'another-model', models, effort: 'high' }, claude: { effort: 'medium' } } })
    expect(await agents.get('codex')).toMatchObject({ model: 'another-model', models, effort: 'high' })
    expect((await agents.get('claude'))?.models).toEqual(BUILTIN_AGENTS.find((a) => a.id === 'claude')?.models)
  })

  it.each([
    ['an unknown run', { x: { run: 'nope', model: 'm' } }],
    ['the reserved id lead', { lead: { run: 'dsh', model: 'm' } }],
    ['an id a split tag cannot name', { 'my agent': { run: 'dsh', model: 'm' } }],
  ])('reports a broken file with its path: %s', async (_n, entries) => {
    const { home, agents } = await withFile({ agents: entries })
    await expect(agents.list()).rejects.toBeInstanceOf(AgentsFileError)
    await expect(agents.list()).rejects.toMatchObject({ path: join(home, 'agents.json') })
  })
})
