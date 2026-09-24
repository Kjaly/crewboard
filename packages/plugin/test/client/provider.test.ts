import { setLang } from '../../src/client/i18n.js'
import { beforeEach, expect, it } from 'vitest'
import { identityLabel, runFact, workerIdentity } from '../../src/client/provider.js'
import { makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))

it('names direct workers with the same model language as the registry', () => {
  expect(workerIdentity('codex/gpt-6-sol')).toEqual({ provider: 'Codex', mark: 'CX', model: 'GPT-6 Sol' })
  expect(identityLabel(workerIdentity('dsh/deepseek-flash'))).toBe('DeepSeek V4 Flash')
  expect(identityLabel(workerIdentity('claude/opus'))).toBe('Claude Opus 5')
  expect(identityLabel(workerIdentity('devin'))).toBe('Devin SWE-2')
})

it('resolves saved aliases and preserves an unknown id', () => {
  expect(workerIdentity('codex-gpt-6-sol')).toEqual(workerIdentity('codex/gpt-6-sol'))
  expect(workerIdentity('claude-opus')).toEqual(workerIdentity('claude/opus'))
  expect(workerIdentity('custom/model')).toEqual({ provider: 'Другие', mark: '··', model: 'custom/model' })
})

it('shows elapsed running time and accepted time without inventing a completion time', () => {
  const now = new Date('2026-09-22T12:00:00Z')
  expect(runFact(makeTask({ id: 'live', status: 'running', activeSince: '2026-09-22T11:19:00Z' }), now)).toBe('41 мин')
  expect(runFact(makeTask({ id: 'done', status: 'accepted', runs: 1, acceptedAt: '2026-09-22T10:00:00Z' }), now)).toBe('2 часа назад')
  expect(runFact(makeTask({ id: 'decision', kind: 'decision', status: 'accepted', acceptedAt: '2026-09-22T10:00:00Z' }), now)).toBe('—')
  expect(runFact(makeTask({ id: 'review', status: 'in_review', runs: 1 }), now)).toBe('—')
})
