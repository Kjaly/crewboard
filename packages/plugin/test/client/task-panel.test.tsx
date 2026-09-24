// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { TaskPanel, dependencyChips, shortPath } from '../../src/client/panel/task-panel.js'
import { resolveTab } from '../../src/client/panel/tabs.js'
import { type FetchCall, ROOT, installFetch, jsonFail, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'
import { setLang } from '../../src/client/i18n.js'

let calls: FetchCall[] = []

function mount(task: TaskSnapshot, postResult: (url: string) => unknown = () => jsonOk(null)) {
  calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id })) : postResult(url)))
  const repo = makeRepo([task], [])
  render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
}

const posts = (name: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(`/api/${name}`))

afterEach(() => cleanup())
beforeEach(() => {
  setLang('ru')
  calls = []
})

describe('main button by status', () => {
  const cases: Array<[string, TaskSnapshot, string]> = [
    ['ready', makeTask({ id: 'a', status: 'ready' }), 'Запустить'],
    ['running', makeTask({ id: 'a', status: 'running' }), 'Поправить…'],
    ['in_review', makeTask({ id: 'a', status: 'in_review' }), 'Принять'],
    ['blocked', makeTask({ id: 'a', status: 'blocked', deps: ['z'], blockedBy: ['z'] }), 'Что блокирует'],
    ['decision', makeTask({ id: 'a', status: 'ready', kind: 'decision', needsHuman: true }), 'Принять решение'],
  ]
  for (const [status, task, label] of cases) {
    it(`offers «${label}» for ${status}`, () => {
      mount(task)
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    })
  }
})

it('maps removed and unknown tab requests to Overview', () => {
  expect(['feed', 'runs', 'notes', 'links', 'unknown', undefined].map(resolveTab)).toEqual(Array(6).fill('overview'))
  expect(['overview', 'activity', 'changes', 'contract'].map(resolveTab)).toEqual(['overview', 'activity', 'changes', 'contract'])
})

it('shows at most two dependency chips and the remaining count', async () => {
  const task = makeTask({ id: 'a', deps: ['fp-t20a', 'fp-t20b', 'fp-ui10', 'base'] })
  expect(dependencyChips(task.deps)).toEqual({ shown: ['fp-t20a', 'fp-t20b'], remaining: 2 })
  mount(task)
  expect(screen.getByTitle(task.deps.join(', ')).textContent).toBe('+2')
})

it('keeps both ends of a long path', () => {
  const path = '/Users/dev/projects/acme-web-orch-fp-t20a'
  expect(shortPath(path)).toMatch(/^\/Users\/d….*fp-t20a$/)
})

it('shows exactly four tabs and no extra contract link', async () => {
  const task = makeTask({ id: 'a', status: 'running' })
  calls = installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, contract: { path: 'a.md', text: 'work', truncated: false } })) : jsonOk(null))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(4))
  expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual(['Обзор', 'Активность', 'Изменения', 'Контракт'])
  expect(screen.queryByRole('button', { name: /Открыть контракт/ })).toBeNull()
})

it('falls back to Overview for a stale external tab request', async () => {
  const task = makeTask({ id: 'a' })
  calls = installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id })) : jsonOk(null))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" tabRequest={{ tab: 'runs', seq: 1 }} />)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Обзор' }).getAttribute('aria-selected')).toBe('true'))
})

it('labels an abandoned correction and offers relaunch with its context', async () => {
  const task = makeTask({ id: 'late', status: 'in_review' })
  const at = '2026-09-23T12:00:00Z'
  calls = installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, steers: [{ id: 'steer-1', createdAt: at, mode: 'auto', preview: 'add a test', file: '/tmp/steer.md', state: 'abandoned', reason: 'run_finished', timestamps: { queued: at, abandoned: at } }] })) : jsonOk(null))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  await waitFor(() => expect(screen.getByText('Не доставлена')).toBeTruthy())
  expect(screen.getByText('Запуск завершился до отправки поправки.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Перезапустить с этой поправкой' })).toBeTruthy()
})

it('shows the renamed registry worker in the task panel', () => {
  const task = makeTask({ id: 'renamed', worker: 'codex' })
  calls = installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id })) : jsonOk(null))
  const workers = [{ id: 'codex/gpt-6-astra', label: 'My review agent', provider: 'Codex' as const, billing: 'подписка' as const, main: true, usedIn: [] }]
  const props = { repo: makeRepo([task]), task, attention: [], onSelect: () => {}, density: 'overview' as const }
  const { rerender } = render(<TaskPanel {...props} workers={[{ ...workers[0], label: 'Codex GPT-6 Astra' }]} />)
  expect(screen.getAllByText('Codex GPT-6 Astra')).toHaveLength(2)
  rerender(<TaskPanel {...props} workers={workers} />)
  expect(screen.getAllByText('My review agent')).toHaveLength(2)
})

it('accepts through the guarded POST and reports a declined dialog', async () => {
  const user = userEvent.setup()
  mount(makeTask({ id: 'a', status: 'in_review' }), () => jsonFail('declined'))
  await user.click(screen.getByRole('button', { name: 'Принять' }))
  await waitFor(() => expect(screen.getByText('Отменено в окне подтверждения')).toBeTruthy())
  const [call] = posts('accept')
  expect(call?.url).toBe('/crewboard/api/accept')
  expect(call?.headers['x-orchestra-client']).toBe('1')
  expect(call?.headers['content-type']).toBe('application/json')
  expect(call?.body).toEqual({ repo: ROOT, task: 'a' })
  expect(screen.getByText('Подтвердите в окне macOS')).toBeTruthy()
})

it('never returns a task without a reason', async () => {
  const user = userEvent.setup()
  mount(makeTask({ id: 'a', status: 'in_review' }))
  await user.click(screen.getByRole('button', { name: 'Вернуть…' }))
  await user.click(screen.getByRole('button', { name: 'Вернуть' }))
  expect(posts('reject')).toHaveLength(0)
  await user.type(screen.getByRole('textbox', { name: 'Причина возврата' }), 'нет тестов')
  await user.click(screen.getByRole('button', { name: 'Вернуть' }))
  await waitFor(() => expect(posts('reject')).toHaveLength(1))
  expect(posts('reject')[0]?.body).toEqual({ repo: ROOT, task: 'a', reason: 'нет тестов' })
})

it('keeps a refused correction and offers relaunch only after an explicit click', async () => {
  const user = userEvent.setup()
  const correction = 'check the empty input case'
  mount(makeTask({ id: 'a', status: 'running', runs: 1 }), (url) => url.includes('/api/steer')
    ? jsonOk({ delivery: 'refused', runId: 'run_dsh-a', state: 'refused', runState: 'completed', steerId: 'steer-1', message: correction, file: '/tmp/steer.md' })
    : jsonOk({ runId: 'run_dsh-new' }))
  await user.click(screen.getByRole('button', { name: 'Поправить…' }))
  await user.type(screen.getByRole('textbox', { name: 'Поправка воркеру' }), correction)
  await user.click(screen.getByRole('button', { name: 'Отправить' }))
  await waitFor(() => expect(screen.getByText(/последний запуск в состоянии completed/)).toBeTruthy())
  expect((screen.getByRole('textbox', { name: 'Поправка воркеру' }) as HTMLTextAreaElement).value).toBe(correction)
  expect(posts('relaunch')).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: 'Перезапустить с этой поправкой' }))
  await waitFor(() => expect(posts('relaunch')).toHaveLength(1))
  expect(posts('relaunch')[0]?.body).toEqual({ repo: ROOT, task: 'a', note: correction })
})
