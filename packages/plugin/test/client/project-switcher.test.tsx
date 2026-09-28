// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestraSnapshot, RepoSnapshot } from '../../src/shared/types.js'
import { ProjectSwitcher } from '../../src/client/project-switcher.js'
import { resetNowOrder } from '../../src/client/now.js'
import { familyCopyOf, resetSessionMemory } from '../../src/client/store.js'
import { makeRepo, makeSnapshot, makeTask } from './helpers.js'

const repoAt = (root: string, patch: Record<string, unknown>) => makeRepo([makeTask({ id: 't' })], [], { root, planId: 'main', ...patch } as unknown as Partial<RepoSnapshot>)
const plan = (patch: Record<string, unknown>) => ({ id: 'main', goal: 'g', archived: false, current: false, rev: 1, updatedAt: 't', taskCount: 1, running: 0, inReview: 0, waitingHuman: 0, ready: 0, accepted: 0, attention: [], ...patch })

const snapshot = (): OrchestraSnapshot => ({
  ...makeSnapshot(
    repoAt('/repo/main', { family: { root: '/repo/main', name: 'app' }, plans: [plan({ current: true, waitingHuman: 1 })] }),
    repoAt('/repo/.worktrees/feat', { family: { root: '/repo/main', name: 'app' }, plans: [plan({ running: 1 })] }),
    repoAt('/other/main', { title: 'other', plans: [plan({ current: true })] }),
    repoAt('/quiet/main', { title: 'quiet', plans: [plan({})] }),
    repoAt('/gone', { missing: true }),
  ),
  now: {
    coverage: 'known',
    unknown: [],
    items: [
      { root: '/repo/.worktrees/feat', planId: 'main', taskId: 't', title: 't', kind: 'implement', stage: 'worker' },
      { root: '/other/main', planId: 'main', taskId: 't', title: 't', kind: 'implement', stage: 'checking' },
    ],
  },
})

beforeEach(() => { resetNowOrder(); resetSessionMemory() })
afterEach(() => cleanup())

describe('ProjectSwitcher', () => {
  it('shows only active/pinned/current families with canonical names and relevant copy chips', () => {
    const onOpen = vi.fn()
    render(<ProjectSwitcher snapshot={snapshot()} currentRoot="/repo/main" onOpen={onOpen} />)
    expect(screen.getByRole('button', { name: /app/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /other/ })).toBeTruthy()
    // A quiet family and a missing checkout are behind the search overflow, not dumped into the strip.
    expect(screen.queryByRole('button', { name: /quiet/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /gone/ })).toBeNull()
    // The family with several copies offers them; the copy with work is the default click target.
    const select = screen.getByRole('combobox', { name: /app/ })
    fireEvent.click(screen.getByRole('button', { name: /app/ }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ root: '/repo/.worktrees/feat' }))
    fireEvent.change(select, { target: { value: '/repo/main' } })
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ root: '/repo/main' }))
  })

  it('does not count a plan’s own current flag as the reader’s current project', () => {
    render(<ProjectSwitcher snapshot={snapshot()} currentRoot="/repo/main" onOpen={vi.fn()} />)
    // `/other/main` carries `current: true` in its plan, yet the reader is on `app`.
    expect(screen.getByRole('button', { name: /app/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /other/ }).getAttribute('aria-current')).toBeNull()
  })

  it('reopens the exact copy the reader last used in a family, and names it when the family has a choice', () => {
    const onOpen = vi.fn()
    render(<ProjectSwitcher snapshot={snapshot()} currentRoot="/repo/main" onOpen={onOpen} />)
    const select = screen.getByRole('combobox', { name: /app/ }) as HTMLSelectElement
    // Before any choice, the busy worktree copy is the target.
    expect(select.value).toBe('/repo/.worktrees/feat')
    fireEvent.change(select, { target: { value: '/repo/main' } })
    expect(familyCopyOf('/repo/main')).toBe('/repo/main')
    // A later family click returns to the copy the reader actually used, not the busy one.
    fireEvent.click(screen.getByRole('button', { name: /app/ }))
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ root: '/repo/main' }))
    // The ambiguous family names the copy it will open.
    expect(screen.getByRole('button', { name: /app/ }).textContent).toContain('main')
  })

  it('keeps the project order stable when a poll changes activity and reveals the rest via More', () => {
    const onMore = vi.fn()
    const { rerender } = render(<ProjectSwitcher snapshot={snapshot()} currentRoot="/repo/main" onOpen={vi.fn()} onMore={onMore} />)
    const names = () => screen.getAllByRole('button').map((button) => button.textContent)
    const first = names()
    // The host now serves the families in the other order; the first-seen order stands.
    const base = snapshot()
    const flipped = { ...makeSnapshot(...[...base.repos].reverse()), now: base.now }
    rerender(<ProjectSwitcher snapshot={flipped} currentRoot="/repo/main" onOpen={vi.fn()} onMore={onMore} />)
    expect(names()).toEqual(first)
    fireEvent.click(screen.getByRole('button', { name: /More/ }))
    expect(onMore).toHaveBeenCalled()
  })
})


it('does not mark planless siblings as the current physical copy', () => {
  const data = snapshot()
  data.repos.push(repoAt('/repo/.worktrees/scratch', { hasPlan: false, tasks: [], plans: [], family: { root: '/repo/main', name: 'app' } }))
  render(<ProjectSwitcher snapshot={data} currentRoot="/repo/.worktrees/feat" onOpen={vi.fn()} />)
  const options = screen.getByRole('combobox', { name: /app/ }).querySelectorAll('option')
  expect(Array.from(options).map((option) => option.value)).not.toContain('/repo/.worktrees/scratch')
})
