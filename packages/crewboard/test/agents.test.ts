import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentsFileError, createAgents } from '../src/workers/agents.js'
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

describe('agent registry', () => {
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
