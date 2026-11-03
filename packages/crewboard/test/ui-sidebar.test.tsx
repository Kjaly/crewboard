// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoalSummary, ProjectSummary } from '../src/owner.js'
import { Sidebar } from '../src/ui/components/sidebar.js'
import { UsagePanel } from '../src/ui/components/usage-panel.js'
import { fakeApi } from './ui-fixtures.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const goal = (goalId: string, over: Partial<GoalSummary> = {}, counts: Partial<GoalSummary['counts']> = {}): GoalSummary => ({
  goalId, title: goalId, createdAt: '2026-11-02T10:00:00Z', status: 'running', leadOnline: true,
  counts: { waiting_owner: 0, waiting_lead: 0, running: 0, queued: 0, finished: 0, ...counts }, ...over,
})
const show = (goals: GoalSummary[]) => {
  const projects: ProjectSummary[] = [{ repo: '/repo/cabinet', name: 'cabinet', goals }]
  render(<Sidebar projects={projects} onPick={() => undefined} drawer={false} open={false} />)
}
const titles = () => screen.getAllByRole('button').filter((b) => b.classList.contains('sb-goal')).map((b) => b.querySelector('.sb-title')?.textContent)

describe('sidebar', () => {
  it('sorts waiting for you first, running, waiting for the lead, then paused', () => {
    show([goal('paused', { status: 'paused' }), goal('lead', { status: 'waiting_answer' }, { waiting_lead: 1 }), goal('run', {}, { running: 1 }), goal('ask', {}, { waiting_owner: 1 })])
    expect(titles()).toEqual(['ask', 'run', 'lead', 'paused'])
  })

  it('keeps a paused goal with a question for you at the top', () => {
    show([goal('run', {}, { running: 1 }), goal('asked', { status: 'paused' }, { waiting_owner: 1 })])
    expect(titles()).toEqual(['asked', 'run'])
  })

  it('folds finished goals under Finished N and remembers it', () => {
    show([goal('live', {}, { running: 1 }), goal('old1', { status: 'done', finishedAt: '2026-11-01T10:00:00Z' }), goal('old2', { status: 'done', finishedAt: '2026-11-02T10:00:00Z' })])
    expect(titles()).toEqual(['live'])
    const fold = screen.getByRole('button', { name: /^(Завершено|Finished) 2$/ })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(fold)
    expect(titles()).toEqual(['live', 'old2', 'old1'])
    cleanup()
    show([goal('live', {}, { running: 1 }), goal('old1', { status: 'done' })])
    expect(titles()).toEqual(['live', 'old1'])
  })

  it('collapsing a project hides its goals but keeps the waiting badge, and is remembered', () => {
    show([goal('ask', {}, { waiting_owner: 2 })])
    const head = screen.getByRole('button', { name: /cabinet/ })
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /^ask\./ })).toBeNull()
    expect(within(head).getByText('2')).toBeTruthy()
    cleanup()
    show([goal('ask', {}, { waiting_owner: 2 })])
    expect(screen.getByRole('button', { name: /cabinet/ }).getAttribute('aria-expanded')).toBe('false')
  })
})

describe('providers panel', () => {
  it('shows how much of each limit is used, the money left, and what is missing to see the rest', async () => {
    const f = fakeApi()
    f.state.usage = [
      { id: 'codex', label: 'Codex', icon: 'codex', state: 'ok', plan: 'pro', windows: [{ minutes: 10080, usedPercent: 13 }], balances: [] },
      { id: 'deepseek', label: 'DeepSeek', icon: 'deepseek', state: 'ok', windows: [], balances: [{ currency: 'USD', amount: 4.5 }] },
      { id: 'claude', label: 'Claude', icon: 'claude', state: 'no_data', windows: [], balances: [], hint: 'claude_statusline' },
    ]
    render(<UsagePanel api={f.api} />)
    expect((await screen.findByTitle('Неделя: использовано 13%')).textContent).toContain('13%')
    expect(screen.getByText(/4,50\s\$|\$4\.50/)).toBeTruthy()
    expect(screen.getByText(/войдите в Claude Code/)).toBeTruthy()
  })
})
