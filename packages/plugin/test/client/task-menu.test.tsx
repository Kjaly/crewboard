// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskMenu, nextTaskId } from '../../src/client/task-menu.js'
import { api } from '../../src/client/api.js'
import { setLang } from '../../src/client/i18n.js'
import { makeDetail, makeRepo, makeTask } from './helpers.js'

beforeEach(() => setLang('en'))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup(status: 'ready' | 'running' | 'in_review' | 'backlog' = 'ready') {
  const task = makeTask({ id: 'parent', title: 'Parent task', status, runs: status === 'in_review' ? 1 : 0, lastRunId: status === 'in_review' ? 'run-1' : undefined })
  const repo = makeRepo([task])
  const origin = document.createElement('button')
  origin.textContent = 'origin'
  document.body.append(origin)
  vi.spyOn(api, 'task').mockResolvedValue({ ok: true, value: makeDetail({ id: task.id, title: task.title, status, contract: { path: 'contract.md', text: 'work', truncated: false }, report: { text: 'Review found a bug' } as never, verdict: { kind: 'disputed', facts: [{ code: 'tests', text: 'Failing check', tone: 'warn' }] } as never }) })
  const onClose = vi.fn()
  const onSelect = vi.fn()
  render(<TaskMenu request={{ taskId: task.id, x: 90, y: 80, origin }} repo={repo} workers={[]} onClose={onClose} onSelect={onSelect} onTab={vi.fn()} onTrace={vi.fn()} onGraph={vi.fn()} />)
  return { repo, origin, onClose, onSelect }
}

it('shows actions that match the task state', async () => {
  setup('ready')
  expect(screen.getByRole('menuitem', { name: 'Launch' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Stop' })).toBeNull()
  cleanup()
  setup('running')
  expect(screen.getByRole('menuitem', { name: 'Stop' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Accept…' })).toBeNull()
  cleanup()
  setup('in_review')
  expect(screen.getByRole('menuitem', { name: 'Accept…' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Send back with reason…' })).toBeTruthy()
})

it('offers batch acceptance for several selected review tasks', () => {
  const tasks = [makeTask({ id: 'a', status: 'in_review' }), makeTask({ id: 'b', status: 'in_review' })]
  const origin = document.createElement('button')
  document.body.append(origin)
  vi.spyOn(api, 'task').mockResolvedValue({ ok: true, value: makeDetail({ id: 'a' }) })
  render(<TaskMenu request={{ taskId: 'a', selectedIds: ['a', 'b'], x: 20, y: 20, origin }} repo={makeRepo(tasks)} workers={[]} onClose={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onTrace={vi.fn()} onGraph={vi.fn()} />)
  expect(screen.getByRole('menuitem', { name: 'Accept selected…' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Launch' })).toBeNull()
})

it('moves by arrow keys and returns focus on Escape', async () => {
  const user = userEvent.setup()
  const { origin, onClose } = setup()
  await user.keyboard('{ArrowDown}{Escape}')
  expect(onClose).toHaveBeenCalled()
  expect(document.activeElement).toBe(origin)
})

it('uses the existing accept API', async () => {
  const user = userEvent.setup()
  const accept = vi.spyOn(api, 'accept').mockResolvedValue({ ok: true, value: { task: 'parent', status: 'accepted' } as never })
  setup('in_review')
  await user.click(screen.getByRole('menuitem', { name: 'Accept…' }))
  expect(accept).toHaveBeenCalledWith('/repo', 'parent')
})

it('creates a dependent follow-up with its parent link and typed content', async () => {
  const user = userEvent.setup()
  const upsert = vi.spyOn(api, 'taskUpsert').mockResolvedValue({ ok: true, value: { id: 'fix-review' } })
  const { onSelect } = setup('in_review')
  await user.click(screen.getByRole('menuitem', { name: 'Follow-up task…' }))
  await user.type(screen.getByRole('textbox', { name: 'Task title' }), 'Fix review')
  await user.type(screen.getByRole('textbox', { name: 'What to do' }), 'Fix the failing check')
  await user.click(screen.getByRole('button', { name: 'Create task' }))
  await waitFor(() => expect(upsert).toHaveBeenCalledWith('/repo', expect.objectContaining({ id: 'fix-review', parent: 'parent', depends: true, note: 'Fix the failing check' })))
  expect(onSelect).toHaveBeenCalledWith('fix-review')
})

it('includes report and findings in the chat hand-off', async () => {
  const user = userEvent.setup()
  const chat = vi.spyOn(api, 'chatOpen').mockResolvedValue({ ok: true, value: { sessionId: 'session', created: true } })
  setup('in_review')
  await screen.findByRole('menuitem', { name: 'Contract' })
  await user.click(screen.getByRole('menuitem', { name: 'Ask the agent to plan follow-ups' }))
  await waitFor(() => expect(chat).toHaveBeenCalled())
  const prompt = chat.mock.calls[0]?.[2] ?? ''
  expect(prompt).toContain('parent')
  expect(prompt).toContain('Review found a bug')
  expect(prompt).toContain('Failing check')
  expect(prompt).toContain('orchestra_task_upsert')
})

it('generates unique short ids', () => {
  expect(nextTaskId('Fix review', [makeTask({ id: 'fix-review' })])).toBe('fix-review-2')
})

it('clamps the menu inside the viewport', async () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 260 } as DOMRect)
  const task = makeTask({ id: 'edge' })
  const origin = document.createElement('button')
  document.body.append(origin)
  vi.spyOn(api, 'task').mockResolvedValue({ ok: true, value: makeDetail({ id: 'edge' }) })
  const { container } = render(<TaskMenu request={{ taskId: 'edge', x: window.innerWidth - 2, y: window.innerHeight - 2, origin }} repo={makeRepo([task])} workers={[]} onClose={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onTrace={vi.fn()} onGraph={vi.fn()} />)
  await waitFor(() => expect((container.querySelector('.orc-task-menu') as HTMLElement).style.left).toBe(`${window.innerWidth - 308}px`))
  expect((container.querySelector('.orc-task-menu') as HTMLElement).style.top).toBe(`${window.innerHeight - 268}px`)
  rect.mockRestore()
})

// w1f: a task no longer needed is closed from the menu with a reason; the host asks the person to confirm.
it('closes a task as not needed with a reason, and offers it only while the task is open', async () => {
  const user = userEvent.setup()
  const drop = vi.spyOn(api, 'drop').mockResolvedValue({ ok: true, value: { task: 'parent', status: 'dropped' } as never })
  setup('ready')
  await user.click(screen.getByRole('menuitem', { name: 'Close as not needed…' }))
  await user.type(screen.getByRole('textbox', { name: 'Why is the task not needed?' }), 'Done by hand')
  await user.click(screen.getByRole('button', { name: 'Close task' }))
  expect(drop).toHaveBeenCalledWith('/repo', 'parent', 'Done by hand')
  cleanup()
  setup('running')
  expect(screen.queryByRole('menuitem', { name: 'Close as not needed…' })).toBeNull()
})
