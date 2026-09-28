// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestraRepoSnapshot, RepoSnapshot, TaskSnapshot } from '../../src/shared/types.js'
import { setLang } from '../../src/client/i18n.js'
import { RepoSidebar } from '../../src/client/sidebar.js'
import { HISTORY_SHOWN } from '../../src/client/sidebar-lanes.js'
import { installFetch, jsonOk, makeRepo, makeSnapshot, makeTask, ROOT } from './helpers.js'

const plan = (p: Record<string, unknown> & { id: string }) => ({
  goal: `Plan ${p.id}`, archived: false, current: false, rev: 1, updatedAt: '2026-09-22T11:00:00Z',
  taskCount: 0, running: 0, inReview: 0, waitingHuman: 0, ready: 0, accepted: 0, attention: [], ...p,
})

const tasks = (): TaskSnapshot[] => [
  makeTask({ id: 'h1', lane: 'Plan 1c', status: 'accepted' }),
  makeTask({ id: 'h2', lane: 'Plan 1c', status: 'accepted' }),
  makeTask({ id: 'q1', lane: 'Queue', status: 'blocked' }),
  makeTask({ id: 'r1', lane: 'Reliability', status: 'running' }),
  makeTask({ id: 'a1', lane: 'Analysis', status: 'in_review' }),
  makeTask({ id: 'u1', status: 'ready' }),
]

const current = (list: TaskSnapshot[] = tasks(), planId = 'main') => makeRepo(list, [], {
  root: ROOT, planId, goal: 'Main goal',
  plans: [plan({ id: 'main', current: planId === 'main', goal: 'Main goal', taskCount: list.length }), plan({ id: 'two', current: planId === 'two', goal: 'Second', taskCount: 1 })],
} as Partial<RepoSnapshot>) as OrchestraRepoSnapshot

function mount(repo = current(), lanes: { highlight?: string | null; selected?: string | null; onPick?: (lane: string) => void; link?: (lane: string) => string } = {}) {
  installFetch(() => jsonOk(null))
  const onPick = lanes.onPick ?? vi.fn()
  const view = render(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={{ highlight: lanes.highlight ?? null, selected: lanes.selected ?? null, onPick, link: lanes.link ?? ((lane) => `#lane=${lane}`) }} />)
  return { ...view, onPick }
}

/** `count` finished lanes, the newest first in display order: `Past 00` is the most recent. */
const historyLanes = (count: number): TaskSnapshot[] =>
  Array.from({ length: count }, (_, i) => makeTask({
    id: `h${i}`, lane: `Past ${String(i).padStart(2, '0')}`, status: 'accepted',
    acceptedAt: new Date(Date.UTC(2026, 0, 1) + (count - i) * 86_400_000).toISOString(),
  }))

const groupOf = (name: string) => screen.getByRole('treeitem', { name }).parentElement!.querySelector('[role="group"]') as HTMLElement

const names = (group: HTMLElement) => within(group).getAllByRole('treeitem').map((row) => row.querySelector('.orc-srow__name')?.textContent)

beforeEach(() => { setLang('en'); localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('lane tree in the sidebar', () => {
  it('shows Now open and History folded under the open plan, live lanes first', () => {
    mount()
    const now = screen.getByRole('treeitem', { name: 'Now · 4' })
    const history = screen.getByRole('treeitem', { name: 'History · 1' })
    expect(now.getAttribute('aria-expanded')).toBe('true')
    expect(history.getAttribute('aria-expanded')).toBe('false')
    const group = now.parentElement!.querySelector('[role="group"]') as HTMLElement
    expect(names(group)).toEqual(['Analysis', 'Reliability', 'Queue', 'No lane'])
    // History stays folded: its lanes are not in the tree until it opens.
    expect(screen.queryByRole('treeitem', { name: /^Plan 1c/ })).toBeNull()
    // Only the open plan carries a tree: the other plan is one row.
    expect(screen.getByRole('treeitem', { name: /^Second/ }).getAttribute('aria-expanded')).toBeNull()
    expect(screen.getByRole('treeitem', { name: /^Main goal/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('marks each lane with its dot and counts, spelled out for the screen reader', () => {
    mount()
    const analysis = screen.getByRole('treeitem', { name: /^Analysis/ })
    expect(analysis.getAttribute('aria-label')).toBe('Analysis · 1 in review queue')
    expect(analysis.querySelector('.orc-lanedot--waiting')).toBeTruthy()
    expect(analysis.querySelector('.orc-lanecounts')?.textContent).toBe('◐1')
    const reliability = screen.getByRole('treeitem', { name: /^Reliability/ })
    expect(reliability.querySelector('.orc-lanedot--running')).toBeTruthy()
    expect(reliability.querySelector('.orc-lanecounts')?.textContent).toBe('●1')
    expect(screen.getByRole('treeitem', { name: /^Queue/ }).querySelector('.orc-lanedot--idle')).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /^Queue/ }).getAttribute('aria-label')).toBe('Queue · 1 queued')
    expect(screen.getByRole('treeitem', { name: /^No lane/ }).querySelector('.orc-lanecounts')?.textContent).toBe('○1')
  })

  it('remembers Now per plan but never reopens History on a new mount', async () => {
    const user = userEvent.setup()
    const view = mount()
    await user.click(screen.getByRole('treeitem', { name: 'Now · 4' }))
    await user.click(screen.getByRole('treeitem', { name: 'History · 1' }))
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('true')
    const past = screen.getByRole('treeitem', { name: /^Plan 1c/ })
    expect(past.className).toContain('orc-srow__main--past')
    expect(past.querySelector('.orc-lanecounts')?.textContent).toBe('✓2')
    view.unmount()

    mount()
    // «Now» was folded by hand and stays folded; an open History is not inherited from the last visit.
    expect(screen.getByRole('treeitem', { name: 'Now · 4' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('false')
    cleanup()
    // Another plan starts from the defaults.
    mount(current([makeTask({ id: 'x', lane: 'Done', status: 'accepted' }), makeTask({ id: 'y', lane: 'Live', status: 'running' })], 'two'))
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps History folded on mount even with a stored open state and a restored historical selection', () => {
    localStorage.setItem(`crewboard:lane-tree:${ROOT}:main`, JSON.stringify({ now: true, history: true }))
    mount(current(), { selected: 'h1' })
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('treeitem', { name: /^Plan 1c/ })).toBeNull()
  })

  it('opens only Now for a live selection, never the legacy stored History', () => {
    // A previous visit left History open and Now folded; the live selection must not revive History.
    localStorage.setItem(`crewboard:lane-tree:${ROOT}:main`, JSON.stringify({ now: false, history: true }))
    mount(current(), { selected: 'r1' })
    expect(screen.getByRole('treeitem', { name: 'Now · 4' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('treeitem', { name: /^Plan 1c/ })).toBeNull()
  })

  it('keeps a hand-opened History open when a live selection reopens Now', async () => {
    localStorage.setItem(`crewboard:lane-tree:${ROOT}:main`, JSON.stringify({ now: false, history: false }))
    const user = userEvent.setup()
    const view = mount(current(), { selected: null })
    expect(screen.getByRole('treeitem', { name: 'Now · 4' }).getAttribute('aria-expanded')).toBe('false')
    await user.click(screen.getByRole('treeitem', { name: 'History · 1' }))
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('true')
    // The live selection reveals Now; the reader's open History is not closed or copied over.
    const repo = current()
    view.rerender(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={{ highlight: null, selected: 'r1', onPick: vi.fn(), link: () => '' }} />)
    expect(screen.getByRole('treeitem', { name: 'Now · 4' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('picks a lane on click and highlights the lane in view', async () => {
    const user = userEvent.setup()
    const { onPick, rerender } = mount(current(), { highlight: 'Reliability' })
    expect(screen.getByRole('treeitem', { name: /^Reliability/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('treeitem', { name: /^Analysis/ }).getAttribute('aria-selected')).toBe('false')
    await user.click(screen.getByRole('treeitem', { name: /^Queue/ }))
    expect(onPick).toHaveBeenCalledWith('Queue')
    const repo = current()
    rerender(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={{ highlight: 'Queue', onPick, link: () => '' }} />)
    expect(screen.getByRole('treeitem', { name: /^Queue/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('treeitem', { name: /^Queue/ }).className).toContain('orc-srow__main--inview')
  })

  it('copies a link to the lane from its row menu', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount(current(), { link: (lane) => `https://x/#orchestra/r/main/graph?lane=${lane}` })
    await user.click(screen.getByRole('button', { name: 'Actions for lane Reliability' }))
    await user.click(screen.getByRole('menuitem', { name: 'Copy link to lane' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x/#orchestra/r/main/graph?lane=Reliability'))
  })

  it('walks the tree with the arrow keys and folds groups with Left/Right', () => {
    mount()
    const planRow = screen.getByRole('treeitem', { name: /^Main goal/ })
    planRow.focus()
    fireEvent.keyDown(planRow, { key: 'ArrowRight' })
    const now = screen.getByRole('treeitem', { name: 'Now · 4' })
    expect(document.activeElement).toBe(now)
    fireEvent.keyDown(now, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /^Analysis/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /^Reliability/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(now)
    fireEvent.keyDown(now, { key: 'ArrowLeft' })
    expect(now.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(now)
    fireEvent.keyDown(now, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(planRow)
    const history = screen.getByRole('treeitem', { name: 'History · 1' })
    history.focus()
    fireEvent.keyDown(history, { key: 'ArrowRight' })
    expect(history.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('tree', { name: 'Repositories' })).toBeTruthy()
  })

  it('keeps a History folded by hand closed through selection and polling', async () => {
    const user = userEvent.setup()
    const view = mount()
    const history = () => screen.getByRole('treeitem', { name: 'History · 1' })
    await user.click(history())
    await user.click(history())
    expect(history().getAttribute('aria-expanded')).toBe('false')
    const lanes = { highlight: null, selected: 'h1', onPick: vi.fn(), link: () => '' }
    // Selecting the finished task does not unfold History again...
    const repo = current()
    view.rerender(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={lanes} />)
    expect(history().getAttribute('aria-expanded')).toBe('false')
    // ...and neither does the next poll.
    const poll = current()
    view.rerender(<RepoSidebar snapshot={makeSnapshot(poll)} repo={poll} open onToggle={() => {}} lanes={lanes} />)
    expect(history().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens History on the four most recently completed lanes, newest first', async () => {
    const user = userEvent.setup()
    mount(current([
      makeTask({ id: 'a', lane: 'Alpha', status: 'accepted', acceptedAt: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 'b', lane: 'Beta', status: 'accepted', acceptedAt: '2026-03-01T00:00:00Z' }),
      makeTask({ id: 'c', lane: 'Gamma', status: 'accepted', acceptedAt: '2026-02-01T00:00:00Z' }),
      makeTask({ id: 'd', lane: 'Delta', status: 'accepted', acceptedAt: '2026-04-01T00:00:00Z' }),
      makeTask({ id: 'e', lane: 'Echo', status: 'accepted' }),
      makeTask({ id: 'live', lane: 'Live', status: 'running' }),
    ]))
    await user.click(screen.getByRole('treeitem', { name: 'History · 5' }))
    expect(names(groupOf('History · 5'))).toEqual(['Delta', 'Beta', 'Gamma', 'Alpha'])
    // → from the group steps into the first displayed row, so the rail follows the sorted order.
    expect(screen.getByRole('treeitem', { name: 'History · 5' }).getAttribute('data-children')).toBe(`lane:${ROOT}/main:Delta`)
    // The undated lane and the fifth dated one wait behind the count, not dumped whole.
    expect(screen.queryByRole('treeitem', { name: /^Echo/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeTruthy()
  })

  it('pages History four lanes at a time, the last batch bounded', async () => {
    const user = userEvent.setup()
    mount(current([...historyLanes(14), makeTask({ id: 'live', lane: 'Live', status: 'running' })]))
    await user.click(screen.getByRole('treeitem', { name: 'History · 14' }))
    const shown = () => screen.getAllByRole('treeitem', { name: /^Past \d+/ }).length
    expect(shown()).toBe(HISTORY_SHOWN)
    await user.click(screen.getByRole('button', { name: 'Show 4 more' }))
    expect(shown()).toBe(8)
    await user.click(screen.getByRole('button', { name: 'Show 4 more' }))
    expect(shown()).toBe(12)
    await user.click(screen.getByRole('button', { name: 'Show 2 more' }))
    // The last batch is bounded: all fourteen, and no «more» row.
    expect(shown()).toBe(14)
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull()
  })

  it('resets History to four lanes when it is folded and opened again', async () => {
    const user = userEvent.setup()
    mount(current([...historyLanes(10), makeTask({ id: 'live', lane: 'Live', status: 'running' })]))
    const history = () => screen.getByRole('treeitem', { name: 'History · 10' })
    const shown = () => screen.getAllByRole('treeitem', { name: /^Past \d+/ }).length
    await user.click(history())
    await user.click(screen.getByRole('button', { name: 'Show 4 more' }))
    expect(shown()).toBe(8)
    await user.click(history())
    expect(screen.queryByRole('treeitem', { name: /^Past \d+/ })).toBeNull()
    await user.click(history())
    expect(shown()).toBe(HISTORY_SHOWN)
    expect(screen.getByRole('button', { name: 'Show 4 more' })).toBeTruthy()
  })

  it('keeps the open History and its page across a poll', async () => {
    const user = userEvent.setup()
    const same = [...historyLanes(10), makeTask({ id: 'live', lane: 'Live', status: 'running' })]
    const view = mount(current(same, 'main'))
    await user.click(screen.getByRole('treeitem', { name: 'History · 10' }))
    await user.click(screen.getByRole('button', { name: 'Show 4 more' }))
    // A poll is a new snapshot: a live lane appears, the finished lanes do not change.
    const poll = current([...same, makeTask({ id: 'ready', lane: 'Next', status: 'ready' })], 'main')
    view.rerender(<RepoSidebar snapshot={makeSnapshot(poll)} repo={poll} open onToggle={() => {}} lanes={{ highlight: null, onPick: vi.fn(), link: () => '' }} />)
    expect(screen.getByRole('treeitem', { name: 'History · 10' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('treeitem', { name: /^Past \d+/ })).toHaveLength(8)
  })

  it('folds History and resets its page when the plan or repository changes', async () => {
    const user = userEvent.setup()
    const many = [...historyLanes(10), makeTask({ id: 'live', lane: 'Live', status: 'running' })]
    const view = mount(current(many, 'main'))
    await user.click(screen.getByRole('treeitem', { name: 'History · 10' }))
    await user.click(screen.getByRole('button', { name: 'Show 4 more' }))
    expect(screen.getAllByRole('treeitem', { name: /^Past \d+/ })).toHaveLength(8)
    const other = current(many, 'two')
    view.rerender(<RepoSidebar snapshot={makeSnapshot(other)} repo={other} open onToggle={() => {}} lanes={{ highlight: null, onPick: vi.fn(), link: () => '' }} />)
    expect(screen.getByRole('treeitem', { name: 'History · 10' }).getAttribute('aria-expanded')).toBe('false')
    await user.click(screen.getByRole('treeitem', { name: 'History · 10' }))
    expect(screen.getAllByRole('treeitem', { name: /^Past \d+/ })).toHaveLength(HISTORY_SHOWN)
    // A repository switch behaves the same.
    const moved = { ...current(many, 'main'), root: '/other' } as OrchestraRepoSnapshot
    view.rerender(<RepoSidebar snapshot={makeSnapshot(moved)} repo={moved} open onToggle={() => {}} lanes={{ highlight: null, onPick: vi.fn(), link: () => '' }} />)
    expect(screen.getByRole('treeitem', { name: 'History · 10' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves Now uncapped while History pages, and keeps accepted-unmerged there', async () => {
    const user = userEvent.setup()
    const now = Array.from({ length: 6 }, (_, i) => makeTask({ id: `n${i}`, lane: `Live ${i}`, status: 'running' }))
    mount(current([...historyLanes(6), ...now, makeTask({ id: 'm', lane: 'Merge', status: 'accepted', unmerged: true })]))
    // All seven live lanes show; only History is capped.
    expect(names(groupOf('Now · 7'))).toContain('Merge')
    expect(names(groupOf('Now · 7'))).toHaveLength(7)
    await user.click(screen.getByRole('treeitem', { name: 'History · 6' }))
    expect(screen.getAllByRole('treeitem', { name: /^Past \d+/ })).toHaveLength(HISTORY_SHOWN)
  })

  it('speaks both languages', () => {
    setLang('ru')
    mount()
    expect(screen.getByRole('treeitem', { name: 'Сейчас · 4' })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: 'История · 1' })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /^Без дорожки/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /^Analysis/ }).getAttribute('aria-label')).toBe('Analysis · 1 на разборе')
  })
})
