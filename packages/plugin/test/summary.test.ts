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
  expect(Object.keys(STATUS_GLYPH).sort()).toEqual(['accepted', 'backlog', 'blocked', 'closed', 'in_review', 'ready', 'running', 'superseded'])
})
