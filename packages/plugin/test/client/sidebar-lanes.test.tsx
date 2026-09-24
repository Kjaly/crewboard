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

function mount(repo = current(), lanes: { highlight?: string | null; onPick?: (lane: string) => void; link?: (lane: string) => string } = {}) {
  installFetch(() => jsonOk(null))
  const onPick = lanes.onPick ?? vi.fn()
  const view = render(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} lanes={{ highlight: lanes.highlight ?? null, onPick, link: lanes.link ?? ((lane) => `#lane=${lane}`) }} />)
  return { ...view, onPick }
}

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
    expect(analysis.getAttribute('aria-label')).toBe('Analysis · 1 waiting for you')
    expect(analysis.querySelector('.orc-lanedot--waiting')).toBeTruthy()
    expect(analysis.querySelector('.orc-lanecounts')?.textContent).toBe('◐1')
    const reliability = screen.getByRole('treeitem', { name: /^Reliability/ })
    expect(reliability.querySelector('.orc-lanedot--running')).toBeTruthy()
    expect(reliability.querySelector('.orc-lanecounts')?.textContent).toBe('●1')
    expect(screen.getByRole('treeitem', { name: /^Queue/ }).querySelector('.orc-lanedot--idle')).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /^Queue/ }).getAttribute('aria-label')).toBe('Queue · 1 queued')
    expect(screen.getByRole('treeitem', { name: /^No lane/ }).querySelector('.orc-lanecounts')?.textContent).toBe('○1')
  })

  it('remembers the open state of each group per plan', async () => {
    const user = userEvent.setup()
    const view = mount()
    await user.click(screen.getByRole('treeitem', { name: 'History · 1' }))
    const past = screen.getByRole('treeitem', { name: /^Plan 1c/ })
    expect(past.className).toContain('orc-srow__main--past')
    expect(past.querySelector('.orc-lanecounts')?.textContent).toBe('✓2')
    await user.click(screen.getByRole('treeitem', { name: 'Now · 4' }))
    expect(screen.queryByRole('treeitem', { name: /^Analysis/ })).toBeNull()
    view.unmount()

    mount()
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 'Now · 4' }).getAttribute('aria-expanded')).toBe('false')
    cleanup()
    // Another plan starts from the defaults.
    mount(current([makeTask({ id: 'x', lane: 'Done', status: 'accepted' }), makeTask({ id: 'y', lane: 'Live', status: 'running' })], 'two'))
    expect(screen.getByRole('treeitem', { name: 'History · 1' }).getAttribute('aria-expanded')).toBe('false')
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

  it('shows a long History in part, behind «… N more»', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: HISTORY_SHOWN + 5 }, (_, i) => makeTask({ id: `h${i}`, lane: `L${i}`, status: 'accepted' }))
    mount(current([...many, makeTask({ id: 'live', lane: 'Live', status: 'running' })]))
    await user.click(screen.getByRole('treeitem', { name: `History · ${HISTORY_SHOWN + 5}` }))
    expect(screen.getAllByRole('treeitem', { name: /^L\d+/ })).toHaveLength(HISTORY_SHOWN)
    await user.click(screen.getByRole('button', { name: '… 5 more' }))
    expect(screen.getAllByRole('treeitem', { name: /^L\d+/ })).toHaveLength(HISTORY_SHOWN + 5)
  })

  it('speaks both languages', () => {
    setLang('ru')
    mount()
    expect(screen.getByRole('treeitem', { name: 'Сейчас · 4' })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: 'История · 1' })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /^Без дорожки/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /^Analysis/ }).getAttribute('aria-label')).toBe('Analysis · 1 ждёт вас')
  })
})
