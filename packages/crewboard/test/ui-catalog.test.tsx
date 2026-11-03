// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { Handoff } from '../src/ui/components/handoff.js'
import { AGENTS, setAgents } from '../src/ui/agents.js'
import { T } from '../src/ui/text.js'
import type { HandoffPick } from '../src/ui/api.js'
import type { CatalogModel } from '../src/workers/catalog.js'

const original = AGENTS
afterEach(() => { cleanup(); setAgents(original) })

it('filters discovered choices, refreshes them and still sends a manually entered model', async () => {
  setAgents([{ id: 'router', label: 'Router', model: 'old' }])
  const calls: Array<[string, boolean | undefined]> = []
  const sent: HandoffPick[] = []
  const models: CatalogModel[] = Array.from({ length: 10 }, (_, i) => ({ id: `model-${i}`, label: `Model ${i}`, source: 'discovered', discoveredAt: '2026-11-03T00:00:00Z', pricing: { prompt: 1, completion: 2 } }))
  render(<Handoff from="lead" sending={false} onSend={(_id, pick) => sent.push(pick)} loadModels={async (id, refresh) => { calls.push([id, refresh]); return refresh ? models.slice(0, 2) : models }} />)
  const chip = screen.getAllByRole('button').find((b) => b.getAttribute('aria-haspopup') === 'dialog')!
  await userEvent.click(chip)
  const dialog = screen.getByRole('dialog')
  await userEvent.type(await screen.findByRole('searchbox'), 'model-9')
  expect(within(dialog).getAllByRole('option')).toHaveLength(1)
  await userEvent.click(within(dialog).getByRole('option'))
  await userEvent.click(within(dialog).getByRole('button', { name: T.catalogRefresh }))
  await waitFor(() => expect(calls).toEqual([['router', false], ['router', true]]))
  await userEvent.clear(screen.getByRole('searchbox'))
  expect(within(dialog).getAllByRole('option')).toHaveLength(3)
  await userEvent.click(screen.getByRole('button', { name: T.handoffSend }))
  expect(sent).toEqual([{ model: 'model-9' }])
  await userEvent.click(chip)
  await userEvent.type(screen.getByRole('textbox', { name: T.otherModel }), 'custom/model{Enter}')
  await userEvent.click(screen.getByRole('button', { name: T.handoffSend }))
  expect(sent.at(-1)).toEqual({ model: 'custom/model' })
})

it('sends an explicit effort reset when handing work to the same agent', async () => {
  setAgents([{ id: 'codex', label: 'Codex', model: 'gpt-6.1-sol', efforts: ['medium', 'high'] }])
  const sent: HandoffPick[] = []
  render(<Handoff from="codex" fromModel="gpt-6.1-sol" fromEffort="high" sending={false} onSend={(_id, pick) => sent.push(pick)} />)
  await userEvent.click(screen.getAllByRole('button').find((b) => b.getAttribute('aria-haspopup') === 'dialog')!)
  await userEvent.click(screen.getByRole('button', { name: T.effortDefault }))
  await userEvent.click(screen.getByRole('button', { name: T.handoffSend }))
  expect(sent).toEqual([{ model: 'gpt-6.1-sol', effort: null }])
})
