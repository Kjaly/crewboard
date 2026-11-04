// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { GoalEvent } from '../src/model/types.js'
import { App } from '../src/ui/app.js'
import { T, setLang } from '../src/ui/text.js'
import { fakeApi, kitchen } from './ui-fixtures.js'

setLang('ru')
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const escalation = (seq: number, text: string): GoalEvent => ({ seq, ts: '2026-11-04T10:00:00Z', goalId: 'g', assignmentId: 'ux', actor: 'lead', type: 'escalated', text, options: [], why: 'choice' })

it('restores drafts by assignment, action and question, and clears only a successfully sent draft', async () => {
  const first = escalation(1, 'First question')
  const second = escalation(2, 'Second question')
  const f = fakeApi({ events: { ux: [first] } })
  render(<App api={f.api} />)
  await userEvent.type(await screen.findByRole('textbox', { name: T.question.own }), 'First answer')
  const pickBox = async () => {
    await userEvent.click(screen.getByRole('treeitem', { name: /Модель короба/ }))
    await userEvent.click(screen.getByRole('button', { name: new RegExp(T.actionTitle.clarify) }))
    return screen.getByRole('textbox', { name: T.actionText }) as HTMLTextAreaElement
  }
  await userEvent.type(await pickBox(), 'Clarification draft')
  await userEvent.click(screen.getByRole('treeitem', { name: /Мобильная панель/ }))
  expect((await screen.findByRole('textbox', { name: T.question.own }) as HTMLInputElement).value).toBe('First answer')
  f.state.tree = structuredClone(f.state.tree)
  f.state.events.ux = [first, second]
  act(() => f.emit({ project: '/repo/cabinet', goalId: 'g', seq: 2 }))
  await screen.findByRole('region', { name: second.type === 'escalated' ? second.text : '' })
  const answer = screen.getByRole('textbox', { name: T.question.own }) as HTMLInputElement
  expect(answer.value).toBe('')
  await userEvent.type(answer, 'Second answer')
  f.state.tree = structuredClone(f.state.tree)
  f.state.events.ux = [first]
  act(() => f.emit({ project: '/repo/cabinet', goalId: 'g', seq: 3 }))
  await waitFor(() => expect((screen.getByRole('textbox', { name: T.question.own }) as HTMLInputElement).value).toBe('First answer'))
  expect((await pickBox()).value).toBe('Clarification draft')
  await userEvent.click(screen.getByRole('button', { name: T.actionSendLead }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: T.actionText })).toBeNull())
  await userEvent.click(screen.getByRole('treeitem', { name: /Сборочная инструкция/ }))
  expect((await pickBox()).value).toBe('')
  expect(f.state.requests).toEqual([{ id: 'box', action: 'clarify', text: 'Clarification draft' }])
})

it('keeps a selected completed node mounted, tabbable and its expanded feed readable', async () => {
  const tree = kitchen()
  Object.assign(tree.children[1]!, { runId: 'r1', runOpen: true })
  const f = fakeApi({ tree })
  f.state.runSteps.r1 = { steps: Array.from({ length: 5 }, (_, i) => ({ i, ts: '2026-11-04T10:00:00Z', kind: 'message' as const, text: `message ${i}` })), next: 5, done: false }
  render(<App api={f.api} />)
  const row = await screen.findByRole('treeitem', { name: /Модель короба/ })
  await userEvent.click(row)
  await screen.findByText('message 4')
  await userEvent.click(screen.getByRole('button', { name: T.feed.expand }))
  const firstMessage = screen.getByText('message 0')
  act(() => row.focus())
  f.state.tree = { ...tree, children: tree.children.map((child) => child.id === 'box' ? { ...child, status: 'done', runOpen: false } : child) }
  act(() => f.emit({ project: '/repo/cabinet', goalId: 'g', seq: 4 }))
  await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(T.actionTitle.reopen) })).toBeTruthy())
  expect(screen.getByRole('treeitem', { name: /Модель короба/ })).toBe(row)
  expect(document.activeElement).toBe(row)
  expect(row.tabIndex).toBe(0)
  expect(screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0)).toEqual([row])
  expect(firstMessage.isConnected).toBe(true)
})

it('navigates without opening the mobile sheet, traps Tab in both drawers and returns focus', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }))
  const f = fakeApi()
  render(<App api={f.api} />)
  const ux = await screen.findByRole('treeitem', { name: /Мобильная панель/ })
  act(() => ux.focus())
  await userEvent.keyboard('{ArrowDown}')
  const box = screen.getByRole('treeitem', { name: /Модель короба/ })
  expect(document.activeElement).toBe(box)
  expect(screen.queryByRole('dialog')).toBeNull()
  await userEvent.keyboard('{Enter}')
  const dialog = screen.getByRole('dialog', { name: T.context })
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(screen.getByRole('tree').closest('[inert]')).toBeTruthy()
  const close = within(dialog).getByRole('button', { name: T.close })
  expect(document.activeElement).toBe(close)
  await userEvent.tab({ shift: true })
  const last = document.activeElement
  expect(dialog.contains(last)).toBe(true)
  expect(last).not.toBe(close)
  await userEvent.tab()
  expect(document.activeElement).toBe(close)
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(box)
  expect(screen.getByRole('tree').closest('[inert]')).toBeNull()
  const goals = screen.getByRole('button', { name: T.goalsButton })
  await userEvent.click(goals)
  const drawer = screen.getByRole('dialog', { name: T.sidebar })
  expect(drawer.contains(document.activeElement)).toBe(true)
  const first = document.activeElement
  await userEvent.tab({ shift: true })
  expect(drawer.contains(document.activeElement)).toBe(true)
  await userEvent.tab()
  expect(document.activeElement).toBe(first)
  await userEvent.keyboard('{Escape}')
  expect(document.activeElement).toBe(goals)
})
