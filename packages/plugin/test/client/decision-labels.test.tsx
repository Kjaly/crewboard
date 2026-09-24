// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { TaskDetail, TaskSnapshot } from '../../src/shared/types.js'
import { FeedTab } from '../../src/client/panel/tabs.js'
import { clock, nowPhrase, taskEssence } from '../../src/client/summary.js'

const AT = '2026-09-22T16:11:05.712Z'
const decision = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: 'q5', title: 'Живая проверка 2b', kind: 'decision', status: 'accepted', deps: ['q2', 'q4'], blockedBy: [], needsHuman: false, runs: 0, ...over,
})

it('labels human decisions by who and when, never by a worker', () => {
  setLang('ru')
  expect(taskEssence(decision({ acceptedAt: AT }))).toBe(`решение · принято вами ${clock(AT)}`)
  expect(taskEssence(decision({ status: 'ready', needsHuman: true }))).toBe('решение за вами')
  expect(nowPhrase(decision({ acceptedAt: AT }), []).text).toBe(`Решение принято вами в ${clock(AT)}.`)
  expect(taskEssence({ ...decision(), kind: 'implement', worker: 'claude-opus' })).toBe('принята · claude-opus')
})

it('explains in the feed that a decision has no runs instead of «nothing happened yet»', () => {
  setLang('ru')
  const detail = {
    id: 'q5', title: 'Живая проверка 2b', kind: 'decision', status: 'accepted', deps: ['q2', 'q4'], dependents: [], runs: [],
    notes: [{ at: AT, type: 'accept', text: 'принято человеком (пачкой)' }], steers: [], events: [], changedFiles: [],
    verdict: { kind: 'result', facts: [] },
  } as TaskDetail
  render(<FeedTab detail={detail} />)
  expect(screen.getByText(/решение человека: воркера и модели у него нет/)).toBeTruthy()
  expect(screen.getByText(/после задач q2, q4/)).toBeTruthy()
  expect(screen.getByText(/принято человеком \(пачкой\)/)).toBeTruthy()
})

it('does not ask for a decision that is still waiting for its tasks', () => {
  setLang('ru')
  const blocked = decision({ status: 'blocked', needsHuman: true, blockedBy: ['f1', 'f2', 'f3'] })
  expect(nowPhrase(blocked, []).text).toBe('Ждёт задач f1, f2, f3 — решать пока рано.')
  expect(nowPhrase(blocked, []).tone).toBe('plain')
  expect(nowPhrase(decision({ status: 'ready', needsHuman: true }), []).text).toBe('Решение за вами: план ждёт вашего ответа.')
})
