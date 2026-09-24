// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { api } from '../../src/client/api.js'
import { formatRoute } from '../../src/client/route.js'
import { TraceScreen } from '../../src/client/panel/trace.js'
import { LedgerView } from '../../src/client/panel/trace-ledger.js'
import type { LedgerRecord, Trajectory } from '../../src/shared/types.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => { cleanup(); sessionStorage.clear(); window.history.replaceState(null, '', '#'); vi.restoreAllMocks() })
const start = Date.parse('2026-09-23T12:00:00Z')
const records: LedgerRecord[] = Array.from({ length: 550 }, (_, i) => ({ stepId: `step:${i + 1}`, index: i + 1, kind: i === 549 ? 'problem' : 'tool', label: i === 549 ? 'last failure' : `Read file-${i}.ts`, startedAt: start + i * 1000, durationMs: i === 549 ? null : 100, isError: i === 549, turn: Math.floor(i / 100) + 1, input: `file-${i}.ts`, ...(i === 549 ? { output: 'permission denied' } : {}) }))
const trace: Trajectory = { start, end: start + 550_000, turns: [1, 2, 3, 4, 5, 6].map((index) => ({ index, start: start + (index - 1) * 100_000, end: start + index * 100_000 })), spans: [], records, totals: { turns: 6, toolCalls: 549, toolMs: 54900, modelMs: 0, durationMs: 550_000 }, cost: { runId: 'run_test', agent: 'dsh', durationSec: 550, tokens: { input: 1000, output: 200, cacheRead: 300, reasoning: 0 }, cashUsd: { value: .04, currency: 'USD', source: 'test' } }, outcome: 'failed', humanWaitMs: 9000 }

it('opens a long run as a virtual ledger with totals, search, and full record inspection', async () => {
  setLang('en')
  const user = userEvent.setup()
  render(<TraceScreen repo={makeRepo([makeTask({ id: 'a' })])} target={{ taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }} density="overview" onClose={() => {}} trace={trace} />)
  expect(screen.getByLabelText('Run totals').textContent).toContain('1.0k / 200 / 300')
  expect(screen.getByLabelText('Run totals').textContent).toContain('9 sec')
  expect(screen.getAllByRole('listitem').length).toBeLessThan(550)
  await user.type(screen.getByRole('searchbox', { name: 'Search records' }), 'last failure')
  await user.click(within(screen.getByRole('list', { name: 'Run records' })).getByRole('button', { name: /#550.*last failure/ }))
  expect(screen.getByLabelText('Record inspector').textContent).toContain('permission denied')
  expect(screen.getByLabelText('Record inspector').textContent).toContain('—')
})

it('I9 restores the selected ledger step after detail remount', async () => {
  setLang('en')
  const user = userEvent.setup()
  const repo = makeRepo([makeTask({ id: 'a' })])
  const target = { taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }
  const first = render(<LedgerView trace={trace} repo={repo} target={target} actions={() => null} />)
  await user.click(within(screen.getByRole('list', { name: 'Run records' })).getByRole('button', { name: /#1.*Read file-0/ }))
  first.unmount()
  render(<LedgerView trace={trace} repo={repo} target={target} actions={() => null} />)
  expect(screen.getByLabelText('Record inspector').textContent).toContain('file-0.ts')
})

it('I10 keeps overview marks out of Tab order and links mark and row focus', async () => {
  setLang('en')
  const user = userEvent.setup()
  render(<LedgerView trace={trace} repo={makeRepo([makeTask({ id: 'a' })])} target={{ taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }} actions={() => null} />)
  const overview = screen.getByRole('slider', { name: /Run timing overview/ })
  expect(within(overview).getAllByRole('button', { hidden: true })).toHaveLength(550)
  expect(within(overview).getAllByRole('button', { hidden: true }).every((mark) => mark.tabIndex === -1)).toBe(true)
  await user.click(within(overview).getByRole('button', { name: 'Tool #1', hidden: true }))
  await waitFor(() => expect(document.activeElement?.getAttribute('data-step-id')).toBe('step:1'))
  expect(screen.getByRole('link', { name: 'Link to this step' }).getAttribute('href')).toContain('step=step%3A1')
  expect(within(overview).getByRole('button', { name: 'Tool #1', hidden: true }).getAttribute('aria-current')).toBe('step')
  await user.click(within(screen.getByRole('list', { name: 'Run records' })).getByRole('button', { name: /Read file-1\.ts/ }))
  expect(within(overview).getByRole('button', { name: 'Tool #2', hidden: true }).getAttribute('aria-current')).toBe('step')
  await waitFor(() => expect(document.activeElement?.getAttribute('data-step-id')).toBe('step:2'))
  overview.focus()
  await user.keyboard('{ArrowRight}')
  expect(within(overview).getByRole('button', { name: 'Tool #3', hidden: true }).getAttribute('aria-current')).toBe('step')
  await waitFor(() => expect(document.activeElement?.getAttribute('data-step-id')).toBe('step:3'))
})

it('I10 loads another page and seeks the last mark outside the loaded page', async () => {
  setLang('en')
  const user = userEvent.setup()
  const paged: Trajectory = { ...trace, records: records.slice(0, 100), totalSteps: 550, nextCursor: 'step:100', retainedRange: { firstStepId: 'step:1', lastStepId: 'step:550', from: 1, to: 550, total: 550 }, completeness: 'complete', overviewMarks: records.map(({ stepId, index, kind, startedAt, durationMs }) => ({ stepId, index, kind, startedAt, durationMs })) }
  const request = vi.spyOn(api, 'trace').mockImplementation(async (_repo, _task, _run, page) => ({ ok: true, value: { ...paged, records: page?.seek ? [records[549]!] : records.slice(100, 200), nextCursor: page?.seek ? null : 'step:200' } }))
  render(<LedgerView trace={paged} repo={makeRepo([makeTask({ id: 'a' })])} target={{ taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }} actions={() => null} />)
  await user.click(screen.getByRole('button', { name: 'Load next 100 steps' }))
  await waitFor(() => expect(screen.getByText('Loaded 200 of 550 steps')).toBeTruthy())
  expect(request).toHaveBeenCalledWith(expect.any(String), 'a', 'run_test', { cursor: 'step:100' })
  await user.click(screen.getByRole('button', { name: 'Jump to latest' }))
  await waitFor(() => expect(screen.getByLabelText('Record inspector').textContent).toContain('last failure'))
  expect(request).toHaveBeenCalledWith(expect.any(String), 'a', 'run_test', { seek: 'step:550' })
})

it('I10 resolves a run and step link beyond the first page', async () => {
  setLang('en')
  const repo = makeRepo([makeTask({ id: 'a' })])
  window.history.replaceState(null, '', formatRoute({ repo: repo.root, plan: repo.planId ?? '_', view: 'review', task: 'a', tab: 'review-run', run: 'run_test', step: 'step:550' }))
  const paged: Trajectory = { ...trace, records: records.slice(0, 100), totalSteps: 550, nextCursor: 'step:100', overviewMarks: records.map(({ stepId, index, kind, startedAt, durationMs }) => ({ stepId, index, kind, startedAt, durationMs })) }
  const request = vi.spyOn(api, 'trace').mockResolvedValue({ ok: true, value: { ...paged, records: [records[549]!], nextCursor: null } })
  render(<LedgerView trace={paged} repo={repo} target={{ taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }} actions={() => null} />)
  await waitFor(() => expect(screen.getByLabelText('Record inspector').textContent).toContain('last failure'))
  await waitFor(() => expect(document.activeElement?.getAttribute('data-step-id')).toBe('step:550'))
  expect(request).toHaveBeenCalledWith(repo.root, 'a', 'run_test', { seek: 'step:550' })
})

it('I10 focuses a linked step even when a frame arrives before the list scrolls to it', async () => {
  // A busy browser can run an animation frame before React renders the scrolled window around the step.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 0 })
  const repo = makeRepo([makeTask({ id: 'a' })])
  window.history.replaceState(null, '', formatRoute({ repo: repo.root, plan: repo.planId ?? '_', view: 'review', task: 'a', tab: 'review-run', run: 'run_test', step: 'step:550' }))
  const paged: Trajectory = { ...trace, records: records.slice(0, 100), totalSteps: 550, nextCursor: 'step:100' }
  vi.spyOn(api, 'trace').mockResolvedValue({ ok: true, value: { ...paged, records: [records[549]!], nextCursor: null } })
  render(<LedgerView trace={paged} repo={repo} target={{ taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }} actions={() => null} />)
  await waitFor(() => expect(document.activeElement?.getAttribute('data-step-id')).toBe('step:550'))
})

it('keeps ledger search complete when only the first page was initially loaded', async () => {
  setLang('en')
  const user = userEvent.setup()
  const paged: Trajectory = { ...trace, records: records.slice(0, 100), totalSteps: 550, nextCursor: 'step:100' }
  vi.spyOn(api, 'trace').mockImplementation(async (_repo, _task, _run, page) => {
    const from = Number(page?.cursor?.split(':')[1] ?? 0)
    return { ok: true, value: { ...paged, records: records.slice(from, from + 100), nextCursor: from + 100 < records.length ? `step:${from + 100}` : null } }
  })
  render(<LedgerView trace={paged} repo={makeRepo([makeTask({ id: 'a' })])} target={{ taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }} actions={() => null} />)
  await user.type(screen.getByRole('searchbox', { name: 'Search records' }), 'last failure')
  await waitFor(() => expect(within(screen.getByRole('list', { name: 'Run records' })).getByRole('button', { name: /#550.*last failure/ })).toBeTruthy())
  expect(screen.getByText('1 matching steps')).toBeTruthy()
})

it('gives every ledger control the plugin button style, so none falls back to a native button', () => {
  setLang('en')
  const long: Trajectory = { ...trace, records: [{ ...records[0]!, output: 'x'.repeat(5000) }, ...records.slice(1)], nextCursor: 'step:100' }
  const repo = makeRepo([makeTask({ id: 'a' })])
  sessionStorage.setItem(`orc-ledger:${repo.root}:${repo.planId ?? ''}:run_test`, JSON.stringify({ selected: 1, scrollTop: 0 }))
  render(<LedgerView trace={long} repo={repo} target={{ taskId: 'a', taskTitle: 'Task', run: { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() } }} actions={() => null} />)
  for (const name of ['Zoom in', 'Zoom out', 'Set range start', 'Set range end', 'Load next 100 steps', 'Jump to latest', /Load more/]) {
    expect(screen.getByRole('button', { name }).className).toContain('orc-btn')
  }
  // Every other button has a style of its own: chart marks, filter chips, rows, the text links.
  const own = ['orc-btn', 'orc-ledger__span', 'orc-ledger__filter', 'orc-ledger__row', 'orc-more']
  const bare = [...document.querySelectorAll('.orc-ledger button')].filter((button) => !own.some((name) => button.classList.contains(name)))
  expect(bare.map((button) => button.textContent)).toEqual([])
})

it('opens a finished run at its first step and a live run at its newest one', () => {
  setLang('en')
  const short: Trajectory = { ...trace, records: records.slice(0, 12) }
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(504)
  const repo = makeRepo([makeTask({ id: 'a' })])
  const run = { runId: 'run_test', agent: 'dsh', startedAt: new Date(start).toISOString() }
  const done = render(<LedgerView trace={short} repo={repo} target={{ taskId: 'a', taskTitle: 'Task', run }} actions={() => null} />)
  expect(screen.getByRole('list', { name: 'Run records' }).scrollTop).toBe(0)
  done.unmount()
  sessionStorage.clear()
  render(<LedgerView trace={short} repo={repo} target={{ taskId: 'a', taskTitle: 'Task', run: { ...run, active: true } }} actions={() => null} />)
  expect(screen.getByRole('list', { name: 'Run records' }).scrollTop).toBe(504)
  height.mockRestore()
})
