// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../../src/client/app.js'
import { setLang } from '../../src/client/i18n.js'
import { ReviewToasts, createReviewCenter, resetReviewCenter, reviewCenter } from '../../src/client/notify.js'
import { OrchestraIcon } from '../../src/client/panel.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { FakeEventSource, installEventSource, installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const plan = (id: string, goal: string, current: boolean, waitingHuman: number, running = 0) => ({
  id, goal, current, archived: false, rev: 1, updatedAt: '', taskCount: waitingHuman + running,
  running, inReview: waitingHuman, waitingHuman, ready: 0, accepted: 0, attention: [],
})
const a = makeRepo([makeTask({ id: 'a1', title: 'A review', status: 'in_review' })], [], {
  root: '/work/ap-a', goal: 'A plan', planId: 'a', plans: [plan('a', 'A plan', true, 1, 1)],
})
const b = makeRepo([makeTask({ id: 'b1', title: 'B decision', kind: 'decision', status: 'ready' })], [], {
  root: '/work/ap-b', goal: 'B plan', planId: 'b', plans: [plan('b', 'B plan', true, 1), { ...plan('later', 'Later plan', false, 2, 1), inReview: 0 }],
})

beforeEach(() => { setLang('en'); localStorage.clear(); resetOrchestraStore(); installEventSource() })
afterEach(() => { cleanup(); resetReviewCenter() })

it('shows both repositories, names the other one, and agrees with the queue and badge', async () => {
  const snap = makeSnapshot(a, b)
  installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a1' })) : jsonOk(snap))
  render(<><App /><OrchestraIcon size={16} active={false} /></>)
  await act(async () => { FakeEventSource.last?.emit('snapshot', snap); reviewCenter().feed(snap) })
  const tree = screen.getByRole('navigation', { name: 'Repositories' })
  // Busy groups expand by default, so each plan row carries one status mark, not text badges.
  expect(within(tree).getByRole('treeitem', { name: /A plan/ }).querySelector('.orc-srow__state')?.getAttribute('aria-label')).toBe('1 running · 1 waiting')
  expect(within(tree).getByRole('treeitem', { name: /Later plan/ }).querySelector('.orc-srow__state')?.getAttribute('aria-label')).toBe('1 running · 2 waiting')
  // The inbox lists every repository's waits: both current-plan tasks and the background plan.
  const inboxRows = [...document.querySelectorAll<HTMLElement>('.orc-ibrow')]
  expect(inboxRows.map((row) => row.querySelector('.orc-ibrow__line')?.textContent)).toEqual(['A review', 'B decision', 'Later plan'])
  expect(screen.getByTitle('Orchestration · 4 waiting — ap-a: A plan (1); ap-b: B plan (1), Later plan (2)')).toBeTruthy()
  expect(document.querySelector('.orc-icon__badge')?.textContent).toBe('4')
  await userEvent.setup().click(screen.getByRole('button', { name: /Waiting for you · 1/ }))
  const queue = screen.getByRole('complementary', { name: 'Review queue' })
  expect(within(queue).getByText('A review')).toBeTruthy()
  expect(within(queue).queryByText('B decision')).toBeNull()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /B decision/ }))
  expect(orchestraStore.getState().repoRoot).toBe('/work/ap-b')
  expect(localStorage.getItem('crewboard:task:/work/ap-b:b')).toBe('b1')
  await user.click(screen.getByRole('button', { name: /Waiting for you · 3/ }))
  expect(within(screen.getByRole('complementary', { name: 'Review queue' })).getByText('2 waiting for you')).toBeTruthy()
  await user.click(document.querySelector('.orc-icon__badge') as HTMLElement)
  expect(orchestraStore.getState().repoRoot).toBe('/work/ap-a')
  expect(localStorage.getItem('crewboard:task:/work/ap-a:a')).toBe('a1')
})

it('a toast for a background plan opens its repository, then selects the task when the plan arrives', async () => {
  const user = userEvent.setup()
  const quietB = { ...b, tasks: [], plans: [plan('b', 'B plan', true, 0), plan('later', 'Later plan', false, 0)] }
  const before = makeSnapshot(a, quietB)
  const after = makeSnapshot(a, { ...quietB, plans: [plan('b', 'B plan', true, 0), plan('later', 'Later plan', false, 1)] })
  const calls = installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: 'later-task' })) : jsonOk(before))
  const center = createReviewCenter({ selectPanel: vi.fn() })
  render(<><App /><ReviewToasts center={center} /></>)
  const source = FakeEventSource.last
  await act(async () => { source?.emit('snapshot', before); center.feed(before); center.getState().toasts.forEach((toast) => { center.dismiss(toast.id) }) })
  await act(async () => { source?.emit('snapshot', after); center.feed(after) })
  await user.click(screen.getByRole('button', { name: 'Open' }))
  expect(orchestraStore.getState().repoRoot).toBe('/work/ap-b')
  expect(calls.find((call) => call.url.endsWith('/plan-use'))?.body).toMatchObject({ repo: '/work/ap-b', plan: 'later' })
  const opened = makeSnapshot(a, makeRepo([makeTask({ id: 'later-task', status: 'in_review' })], [], {
    root: '/work/ap-b', goal: 'Later plan', planId: 'later', plans: [plan('later', 'Later plan', true, 1), plan('b', 'B plan', false, 1)],
  }))
  await act(async () => source?.emit('snapshot', opened))
  expect(localStorage.getItem('crewboard:task:/work/ap-b:later')).toBe('later-task')
  expect(orchestraStore.getState().queueOpen).toBe(false)
})
