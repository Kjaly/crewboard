// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { OutsidePresetChip } from '../../src/client/outside-preset.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { emptyReviewFilters, filterReviewRows, reviewRows } from '../../src/client/views/review-index.js'
import type { EffectiveRouting, PlanCost, TaskSnapshot } from '../../src/shared/types.js'
import { ROOT, installFetch, installMatchMedia, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

// wp1 (2026-09-24): the screen shows who chose a worker and what runs outside the preset.

const ROUTING: EffectiveRouting = {
  preset: { id: 'claude', label: 'Claude', routing: { code: ['claude/opus'], design: ['claude/opus'], review: ['claude/opus'], research: ['claude/opus'] } },
  source: 'repository',
  routing: { code: ['claude/opus'], design: ['claude/opus'], review: ['claude/opus'], research: ['claude/opus'] },
  dropped: [],
  disabled: {},
}
const handPicked = makeTask({ id: 'hand', title: 'Выбран вручную', status: 'ready', worker: 'devin', workerSource: 'person', outsidePreset: true })
const agentStale = makeTask({ id: 'stale', title: 'Выбран агентом', status: 'ready', worker: 'codex/gpt-6-sol', workerSource: 'agent', outsidePreset: true })
const byPreset = makeTask({ id: 'preset', title: 'По пресету', status: 'ready' })

beforeEach(() => setLang('ru'))
afterEach(() => cleanup())

describe('header «outside preset» count', () => {
  it('counts tasks outside the preset and opens their list; a row selects the task', async () => {
    const user = userEvent.setup()
    const picked: string[] = []
    render(<OutsidePresetChip tasks={[handPicked, agentStale, byPreset]} onPick={(id) => picked.push(id)} />)
    const chip = screen.getByRole('button', { name: /Вне пресета · 2/ })
    await user.click(chip)
    const list = screen.getByRole('list', { name: 'Вне пресета · 2' })
    expect(within(list).getByText(/devin · выбран вами/)).toBeTruthy()
    expect(within(list).getByText(/codex\/gpt-6-sol · выбран агентом · при запуске решит пресет/)).toBeTruthy()
    await user.click(within(list).getByText('Выбран вручную'))
    expect(picked).toEqual(['hand'])
  })

  it('shows nothing when every assignment is inside the preset', () => {
    const { container } = render(<OutsidePresetChip tasks={[byPreset]} onPick={() => {}} />)
    expect(container.textContent).toBe('')
  })
})

describe('task panel worker line', () => {
  const mount = (task: TaskSnapshot) => {
    const calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id })) : url.includes('/api/worktrees') ? jsonOk({ candidates: [], totalBytes: 0, policy: 'после приёмки' }) : jsonOk({ runId: 'run_1', agent: 'claude/opus' })))
    render(<TaskPanel repo={{ ...makeRepo([task]), effectiveRouting: ROUTING }} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    return calls
  }

  it('says who chose the worker and marks a person\'s pick outside the preset', () => {
    mount(handPicked)
    expect(screen.getByText(/Воркер: .* — выбран вами/)).toBeTruthy()
    expect(screen.getByText(/выбран вручную/, { selector: '.orc-panel__hand' })).toBeTruthy()
    cleanup()
    mount(byPreset)
    expect(screen.getByText(/Воркер: .* — выбран пресетом/)).toBeTruthy()
    expect(document.querySelector('.orc-panel__hand')).toBeNull()
    cleanup()
    mount(agentStale)
    expect(screen.getByText(/Воркер: .* — выбран агентом/)).toBeTruthy()
  })

  it('runs the assignment by default; «Auto» clears it', async () => {
    const user = userEvent.setup()
    const calls = mount(handPicked)
    const select = screen.getByRole('combobox', { name: 'Воркер' }) as HTMLSelectElement
    expect(select.value).toBe('keep')
    await user.click(screen.getByRole('button', { name: 'Запустить' }))
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/run'))).toHaveLength(1))
    expect(calls.find((c) => c.url.includes('/api/run'))?.body).toEqual({ repo: ROOT, task: 'hand' })
    await user.selectOptions(select, 'auto')
    await user.click(screen.getByRole('button', { name: 'Запустить' }))
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/run'))).toHaveLength(2))
    expect(calls.filter((c) => c.url.includes('/api/run'))[1]?.body).toEqual({ repo: ROOT, task: 'hand', agent: 'auto' })
  })
})

it('marks a hand-picked node on the graph', async () => {
  installMatchMedia(false)
  render(<GraphView repo={makeRepo([handPicked, byPreset])} selectedId={null} onSelect={() => {}} density="overview" />)
  expect(await screen.findByRole('img', { name: 'выбран вручную' })).toBeTruthy()
  expect(screen.getAllByRole('img', { name: 'выбран вручную' })).toHaveLength(1)
})

it('filters review runs by preset or hand-picked', () => {
  const run = (runId: string, workerChoice?: 'preset' | 'person' | 'agent') => ({ runId, taskId: 'hand', taskTitle: 'T', agent: 'dsh', startedAt: '2026-09-24T10:00:00Z', ...(workerChoice ? { workerChoice } : {}) })
  const cost = { generatedAt: '2026-09-24T12:00:00Z', runs: [run('r1', 'person'), run('r2', 'preset'), run('r3', 'agent')], totals: {}, accepted: [] } as PlanCost
  const rows = reviewRows(makeRepo([handPicked]), cost)
  expect(filterReviewRows(rows, { ...emptyReviewFilters, choice: 'hand' }).map((r) => r.run.runId)).toEqual(['r1'])
  expect(filterReviewRows(rows, { ...emptyReviewFilters, choice: 'preset' }).map((r) => r.run.runId)).toEqual(['r2', 'r3'])
  expect(filterReviewRows(rows, emptyReviewFilters)).toHaveLength(3)
})
