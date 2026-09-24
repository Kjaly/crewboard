// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { EffectiveRouting, WorkerPreset } from '../../src/shared/types.js'
import { setLang } from '../../src/client/i18n.js'
import { PresetPickers } from '../../src/client/preset-picker.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { type FetchCall, ROOT, installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

const empty = { code: [], design: [], review: [], research: [] }
const codex: WorkerPreset = { id: 'codex', label: 'Codex: Luna → Sol', routing: { ...empty, code: ['codex/luna', 'codex/sol'] } }
const claude: WorkerPreset = { id: 'claude', label: 'Claude', routing: { ...empty, code: ['claude/opus'] } }
const effective = (preset: WorkerPreset, source: EffectiveRouting['source'], dropped: EffectiveRouting['dropped'] = []): EffectiveRouting => ({ preset, source, routing: preset.routing, dropped, disabled: {} })
let calls: FetchCall[]
beforeEach(() => setLang('en'))
afterEach(() => cleanup())
const posts = (name: string) => calls.filter((call) => call.method === 'POST' && call.url.includes(`/api/${name}`))

it('assigns a created preset to the repository, overrides it for a plan, then inherits', async () => {
  const user = userEvent.setup()
  calls = installFetch((url) => url.includes('/api/presets') ? jsonOk({ presets: [codex, claude], effectiveRouting: effective(codex, 'repository') }) : jsonOk(effective(codex, 'repository')))
  const { rerender } = render(<PresetPickers repo={ROOT} planId="main" planTitle="Plan P3" effective={effective(codex, 'repository')} workers={[]} />)
  const trigger = screen.getByRole('button', { name: /Workers/ })
  await user.click(trigger)
  await waitFor(() => expect(screen.getAllByRole('option', { name: 'Claude' })).toHaveLength(2))
  expect(screen.getByText('Who runs tasks')).toBeTruthy()
  expect(screen.getByText('In force: Codex: Luna → Sol — from the repository')).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Same as the repository (Codex: Luna → Sol)' })).toBeTruthy()
  await user.selectOptions(screen.getByRole('combobox', { name: 'This repository · repo' }), 'codex')
  await waitFor(() => expect(posts('repo-preset')[0]?.body).toEqual({ repo: ROOT, id: 'codex' }))
  await user.selectOptions(screen.getByRole('combobox', { name: 'This plan · Plan P3' }), 'claude')
  await waitFor(() => expect(posts('plan-preset')[0]?.body).toEqual({ repo: ROOT, planId: 'main', id: 'claude' }))
  rerender(<PresetPickers repo={ROOT} planId="main" planTitle="Plan P3" effective={effective(claude, 'plan')} workers={[]} />)
  expect(screen.getByText('In force: Claude — from the plan')).toBeTruthy()
  expect((screen.getByRole('combobox', { name: 'This plan · Plan P3' }) as HTMLSelectElement).value).toBe('claude')
  await user.selectOptions(screen.getByRole('combobox', { name: 'This plan · Plan P3' }), '')
  await waitFor(() => expect(posts('plan-preset')[1]?.body).toEqual({ repo: ROOT, planId: 'main' }))
  expect(screen.getByRole('row', { name: /code.*claude\/opus/ })).toBeTruthy()
  expect(screen.getByRole('row', { name: /design/ })).toBeTruthy()
  expect(screen.getByRole('row', { name: /review/ })).toBeTruthy()
  expect(screen.getByRole('row', { name: /research/ })).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('combobox', { name: 'This repository · repo' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('names the plan source and reports disabled workers on one line under Run', () => {
  const task = makeTask({ id: 'a', status: 'ready' })
  const route = effective(claude, 'plan', [{ id: 'codex/luna', reason: 'disabled' }, { id: 'codex/sol', reason: 'disabled' }])
  route.disabled = { 'codex/luna': 'quota', 'codex/sol': 'offline' }
  calls = installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a' })) : url.includes('/api/worktrees') ? jsonOk({ candidates: [], totalBytes: 0, policy: 'on request' }) : jsonOk(null))
  render(<TaskPanel repo={{ ...makeRepo([task]), effectiveRouting: route }} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  expect(screen.getByText(/claude\/opus · from the plan preset Claude/)).toBeTruthy()
  const lines = screen.getAllByText(/Unavailable on this machine:/)
  expect(lines).toHaveLength(1)
  expect(lines[0]?.textContent).toContain('codex/luna (quota), codex/sol (offline)')
})

it('shows skipped workers from the effective snapshot', async () => {
  const user = userEvent.setup()
  calls = installFetch((url) => url.includes('/api/presets') ? jsonOk({ presets: [], effectiveRouting: effective(codex, 'repository') }) : jsonOk(null))
  render(<PresetPickers repo={ROOT} planId="main" planTitle="Plan P3" effective={effective(codex, 'plan', [{ id: 'claude/opus', reason: 'disabled' }])} workers={[{ id: 'claude/opus', label: 'Claude Opus 5', provider: 'Claude', billing: 'подписка', main: true, usedIn: [] }]} />)
  await user.click(screen.getByRole('button', { name: /Workers/ }))
  expect(screen.getByText('Claude Opus 5 is off on this machine — skipped')).toBeTruthy()
  expect(await screen.findByRole('option', { name: 'Same as the repository (Codex: Luna → Sol)' })).toBeTruthy()
})

it('opens orchestration settings from the workers popover and closes the popover', async () => {
  const user = userEvent.setup()
  calls = installFetch((url) => url.includes('/api/presets') ? jsonOk({ presets: [codex], effectiveRouting: effective(codex, 'repository') }) : jsonOk(effective(codex, 'repository')))
  let opened = 0
  render(<PresetPickers repo={ROOT} planId="main" effective={effective(codex, 'repository')} workers={[]} onOpenSettings={() => { opened += 1 }} />)
  await user.click(screen.getByRole('button', { name: /Workers/ }))
  await user.click(screen.getByRole('button', { name: /Orchestration settings/ }))
  expect(opened).toBe(1)
  expect(screen.queryByText('Who runs tasks')).toBeNull()
})
