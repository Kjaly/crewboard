// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { SettingsView } from '../src/ui/components/settings-view.js'
import { T } from '../src/ui/text.js'
import { fakeApi } from './ui-fixtures.js'
import type { AgentsConfig, AgentsConfigView } from '../src/workers/agents.js'

afterEach(cleanup)
const snapshot = (): AgentsConfigView => ({ revision: 'r1', config: { agents: { codex: { models: [{ id: 'gpt-6.1-sol', note: 'keep', efforts: ['medium', 'high'] }] } } }, agents: [
  { id: 'claude', label: 'Claude', run: 'claude', model: 'sonnet', models: [{ id: 'sonnet' }], enabled: true, readOnly: true, efforts: ['medium', 'high'] },
  { id: 'codex', label: 'Codex', run: 'codex', model: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol' }], enabled: true, readOnly: true, efforts: ['medium', 'high', 'ultra'] },
], presets: { cheap: { agent: 'codex' } }, builtinPresets: { cheap: { agent: 'codex' } } })

it('saves catalog model levels, cleared defaults, disabled agents and edited presets without dropping metadata', async () => {
  const { api } = fakeApi()
  const initial = snapshot()
  const saved: AgentsConfig[] = []
  api.agentsConfig = async () => initial
  api.models = async () => [{ id: 'catalog-model', label: 'Catalog', efforts: ['high', 'ultra'], source: 'discovered', discoveredAt: 'now' }]
  api.saveAgentsConfig = async (config, revision) => { expect(revision).toBe('r1'); saved.push(config); return { ...initial, config, revision: 'r2' } }
  let refreshed = 0
  render(<SettingsView api={api} onSaved={() => refreshed++} />)
  const selects = await screen.findAllByRole('combobox')
  await waitFor(() => expect(selects[2].querySelector('[value="catalog-model"]')).not.toBeNull())
  await userEvent.selectOptions(selects[2], 'catalog-model')
  expect(Array.from(selects[3].querySelectorAll('option')).map((o) => o.value)).toEqual(['', 'high', 'ultra'])
  await userEvent.selectOptions(selects[3], 'ultra')
  await userEvent.click(screen.getAllByRole('checkbox')[1])
  await userEvent.type(screen.getAllByRole('textbox')[0], 'routine')
  await userEvent.click(screen.getByRole('button', { name: T.settings.save }))
  expect(saved[0]?.agents.codex).toMatchObject({ model: 'catalog-model', effort: 'ultra', enabled: false, models: [{ id: 'gpt-6.1-sol', note: 'keep', efforts: ['medium', 'high'] }, { id: 'catalog-model', efforts: ['high', 'ultra'] }] })
  expect(saved[0]?.presets?.cheap).toMatchObject({ note: 'routine' })
  expect(refreshed).toBe(1)
})

it('reloads an externally changed registry on conflict and requires a fresh edit before another save', async () => {
  const { api } = fakeApi()
  let current = snapshot()
  let reads = 0
  api.agentsConfig = async () => { reads++; return current }
  let writes = 0
  api.saveAgentsConfig = async () => {
    writes++
    current = { ...current, revision: 'r2', config: { agents: { codex: { enabled: false } } }, agents: current.agents.map((a) => a.id === 'codex' ? { ...a, enabled: false } : a) }
    return 'conflict'
  }
  render(<SettingsView api={api} onSaved={() => {}} />)
  await screen.findAllByRole('checkbox')
  await userEvent.click(screen.getAllByRole('checkbox')[0])
  await userEvent.click(screen.getByRole('button', { name: T.settings.save }))
  await waitFor(() => expect(reads).toBe(2))
  expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true)
  expect((screen.getAllByRole('checkbox')[1] as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('button', { name: T.settings.save }) as HTMLButtonElement).disabled).toBe(true)
  expect(writes).toBe(1)
})

it('clears default effort without discarding registered model levels when discovery has no levels', async () => {
  const { api } = fakeApi()
  const initial = snapshot()
  initial.config.agents.codex = { ...initial.config.agents.codex, effort: 'high' }
  api.agentsConfig = async () => initial
  api.models = async () => [{ id: 'gpt-6.1-sol', label: 'Sol', source: 'discovered', discoveredAt: 'now' }]
  const saved: AgentsConfig[] = []
  api.saveAgentsConfig = async (config) => { saved.push(config); return { ...initial, config } }
  render(<SettingsView api={api} onSaved={() => {}} />)
  const selects = await screen.findAllByRole('combobox')
  await userEvent.selectOptions(selects[3], '')
  await userEvent.click(screen.getByRole('button', { name: T.settings.save }))
  expect(saved[0]?.agents.codex?.effort).toBeUndefined()
  expect(saved[0]?.agents.codex?.models).toEqual(initial.config.agents.codex.models)
})
