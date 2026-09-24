import { setLang } from '../src/client/i18n.js'
import { expect, it } from 'vitest'
import type { RepoSnapshot } from '@crewboard/core'
import { STATUS_GLYPH, attentionCount, repoHeadline } from '../src/client/summary.js'

const repo = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  root: '/r',
  goal: 'g',
  rev: 1,
  updatedAt: 't',
  tasks: [
    { id: 'a', title: 'A', kind: 'implement', status: 'running', deps: [], blockedBy: [], needsHuman: false, runs: 1 },
    { id: 'b', title: 'B', kind: 'implement', status: 'in_review', deps: [], blockedBy: [], needsHuman: false, runs: 1 },
    { id: 'c', title: 'C', kind: 'decision', status: 'ready', deps: [], blockedBy: [], needsHuman: true, runs: 0 },
  ],
  ready: [],
  criticalPath: [],
  attention: [{ kind: 'stalled', severity: 'alert', taskId: 'a', runId: 'r', message: 'm' }],
  degraded: false,
  ...over,
})

it('summarises a repo in one line', () => {
  setLang('ru')
  expect(repoHeadline(repo())).toBe('3 задачи · 1 идёт · 1 ждёт приёмки · 1 решение за вами · 1 требует внимания')
  expect(repoHeadline(repo({ tasks: [], attention: [] }))).toBe('Задач нет')
  expect(repoHeadline(repo({ degraded: true, error: 'plan not found: /r' }))).toBe('⚠ plan not found: /r')
})

it('names a plan from a newer build in the reader\'s language, not by the host\'s two-language message', () => {
  const newer = repo({ degraded: true, error: 'x was written by a newer Crewboard / План записан…', errorCode: 'plan_incompatible' })
  setLang('en')
  expect(repoHeadline(newer)).toBe('⚠ This plan was written by a newer Crewboard. Update Crewboard to open or change it.')
  setLang('ru')
  expect(repoHeadline(newer)).toMatch(/^⚠ План записан более новой версией Crewboard/)
})

it('counts attention across repos and maps every status to a glyph', () => {
  expect(attentionCount({ generatedAt: 't', repos: [repo(), repo()], workers: [] })).toBe(2)
  expect(Object.keys(STATUS_GLYPH).sort()).toEqual(['accepted', 'backlog', 'blocked', 'closed', 'dropped', 'in_review', 'ready', 'running', 'superseded'])
})

it('V-B01/now-rate-limit shows a rate limit with its reset time and a retry-after-reset action, in both languages', async () => {
  const { nowPhrase } = await import('../src/client/summary.js')
  const task = repo().tasks[0]!
  const limited = [{ kind: 'failed' as const, severity: 'alert' as const, taskId: 'a', runId: 'r', message: 'Лимит Claude исчерпан', hint: 'crewboard run a', reason: { code: 'rate_limited' as const, resetsAt: '2026-09-24T19:00:00' } }]
  setLang('en')
  expect(nowPhrase(task, limited)).toEqual({ text: 'Claude usage limit reached — resets at 19:00', hint: 'Start the task again after the reset.', tone: 'alert' })
  setLang('ru')
  expect(nowPhrase(task, limited).text).toBe('Лимит Claude исчерпан — сброс в 19:00')
  const orphan = [{ ...limited[0]!, reason: { code: 'interrupted' as const, workerPid: 42, workerStopped: true } }]
  expect(nowPhrase(task, orphan).text).toBe('Супервизор запуска исчез; его воркер (pid 42) остановлен.')
})
