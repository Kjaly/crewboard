// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectSummary } from '../src/owner.js'
import { App } from '../src/ui/app.js'
import { node, fakeApi } from './ui-fixtures.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('agent avatars', () => {
  it('draws the icon the server sent, keeps the letter without one, and follows the lead client', async () => {
    const projects: ProjectSummary[] = [
      {
        repo: '/repo/cabinet',
        name: 'cabinet',
        goals: [{ goalId: 'g', title: 'Goal', createdAt: '2026-11-02T10:00:00Z', status: 'running', leadOnline: true, lead: 'Claude Code', counts: { waiting_lead: 0, waiting_owner: 0, running: 2, queued: 0, finished: 0 } }],
      },
    ]
    const tree = node('g', 'running', { parentId: null, title: 'Goal', provider: 'lead', resultKind: 'goal' }, [
      node('logo', 'running', { parentId: 'g', title: 'Logo worker', provider: 'claude' }),
      node('letter', 'running', { parentId: 'g', title: 'Letter worker', provider: 'acme' }),
    ])
    const { api } = fakeApi({
      projects,
      tree,
      agents: [
        { id: 'claude', label: 'Claude', icon: 'claude' },
        { id: 'acme', label: 'Acme' },
      ],
    })
    render(<App api={api} />)
    await screen.findByRole('tree')

    const logoRow = screen.getByRole('treeitem', { name: /Logo worker/ })
    await waitFor(() => expect(logoRow.querySelector('.av.logo svg')).toBeTruthy())
    expect(logoRow.querySelector('.av')?.getAttribute('data-icon')).toBe('claude')

    const letterRow = screen.getByRole('treeitem', { name: /Letter worker/ })
    expect(letterRow.querySelector('.av.logo')).toBeNull()
    expect(letterRow.querySelector('.av.other')?.textContent).toBe('A')

    const goalRow = screen.getByRole('treeitem', { name: /Goal/ })
    expect(goalRow.querySelector('.av.logo')?.getAttribute('data-icon')).toBe('claude')
  })
})
