// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { createReviewCenter, resetReviewCenter } from '../../src/client/notify.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { snapshotWaiting } from '../../src/client/review.js'
import { inboxItems } from '../../src/client/sidebar-model.js'
import { taskTone } from '../../src/client/styles.js'
import { acceptableTasks } from '../../src/client/views/accept-batch.js'
import { workColumns } from '../../src/client/views/work.js'
import { plansOf } from '../../src/client/plans.js'
import { setLang } from '../../src/client/i18n.js'
import { type FetchCall, installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

// vr1: finished work the orchestrator is checking is not the person's turn yet.
const finished = (check?: TaskSnapshot['check'], patch: Partial<TaskSnapshot> = {}) => makeTask({ id: 'a', title: 'Alpha', status: 'in_review', runs: 1, lastRunId: 'run-a', ...(check ? { check } : {}), ...patch })

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  resetReviewCenter()
})

describe('orchestrator check keeps finished work off the person\'s lists until checked', () => {
  for (const check of ['pending', 'checking'] as const) {
    it(`${check}: not in Needs you, the queue, the inbox or the counts`, () => {
      const repo = makeRepo([finished(check)])
      expect(acceptableTasks(repo)).toEqual([])
      expect(workColumns(repo).needsYou).toEqual([])
      expect(workColumns(repo).running.map((task) => task.id)).toEqual(['a'])
      expect(inboxItems(makeSnapshot(repo))).toEqual([])
      expect(snapshotWaiting(makeSnapshot(repo))).toBe(0)
      expect(plansOf(repo)[0]?.waitingHuman).toBe(0)
      expect(taskTone(repo.tasks[0]!)).toMatchObject({ label: 'orchestrator is checking', glyph: '◌' })
    })
  }

  it('checked: waits for the person like today', () => {
    const repo = makeRepo([finished('checked', { checkNote: 'gates green' })])
    expect(acceptableTasks(repo).map((task) => task.id)).toEqual(['a'])
    expect(workColumns(repo).needsYou.map((task) => task.id)).toEqual(['a'])
    expect(snapshotWaiting(makeSnapshot(repo))).toBe(1)
  })

  it('the review toast and tab count arrive only when the orchestrator finishes', () => {
    const center = createReviewCenter()
    act(() => center.feed(makeSnapshot(makeRepo([makeTask({ id: 'a', status: 'running' })]))))
    act(() => center.feed(makeSnapshot(makeRepo([finished('pending')]))))
    expect(center.getState()).toMatchObject({ waiting: 0, toasts: [] })
    act(() => center.feed(makeSnapshot(makeRepo([finished('checking')]))))
    expect(center.getState().waiting).toBe(0)
    act(() => center.feed(makeSnapshot(makeRepo([finished('checked')]))))
    expect(center.getState().waiting).toBe(1)
    expect(center.getState().toasts).toHaveLength(1)
  })
})

describe('task panel', () => {
  let calls: FetchCall[] = []
  const mount = (task: TaskSnapshot) => {
    calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, status: 'in_review' })) : jsonOk({ task: task.id, status: 'accepted', worktreeRemoved: false })))
    render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  }
  const accepts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/api/accept'))

  it('shows the calm mark and asks before accepting ahead of the check', async () => {
    mount(finished('checking'))
    expect(screen.getByRole('status').textContent).toContain('Orchestrator is checking')
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(accepts()).toHaveLength(0)
    expect(screen.getByText('The orchestrator has not finished checking — accept without it?')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Accept without the check' }))
    expect(accepts()).toHaveLength(1)
  })

  it('shows the orchestrator\'s note above the buttons and accepts directly once checked', async () => {
    mount(finished('checked', { checkNote: 'pnpm test green; stand ok at 1440' }))
    const note = screen.getByRole('note')
    expect(note.textContent).toContain('Checked by the orchestrator')
    expect(note.textContent).toContain('pnpm test green; stand ok at 1440')
    expect(note.compareDocumentPosition(screen.getByRole('button', { name: 'Accept' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(accepts()).toHaveLength(1)
  })

  it('keeps today\'s panel when there is no check', async () => {
    mount(finished())
    expect(screen.queryByRole('note')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(accepts()).toHaveLength(1)
  })

  it('reads in Russian', () => {
    setLang('ru')
    mount(finished('pending'))
    expect(screen.getByRole('status').textContent).toContain('Проверяет оркестратор')
  })
})
