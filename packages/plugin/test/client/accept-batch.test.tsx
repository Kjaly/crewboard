// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AcceptBatch, acceptableTasks } from '../../src/client/views/accept-batch.js'
import { ROOT, installFetch, jsonFail, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))
afterEach(() => cleanup())

const NOW = '2026-09-22T12:00:00Z'

const repo = makeRepo([
  makeTask({ id: 'a', title: 'Готова к приёмке', status: 'in_review', worker: 'dsh' }),
  makeTask({ id: 'b', title: 'Тоже на приёмке', status: 'in_review', worker: 'devin' }),
  makeTask({ id: 'd', title: 'Выбрать движок', kind: 'decision', status: 'ready', needsHuman: true }),
  makeTask({ id: 'blocked-decision', title: 'Решение заблокировано', kind: 'decision', status: 'blocked', needsHuman: true }),
  makeTask({ id: 'go', title: 'Можно запускать', status: 'ready' }),
  makeTask({ id: 'run', title: 'Идёт сейчас', status: 'running' }),
])

const cost = {
  generatedAt: NOW,
  runs: [{ runId: 'run_dsh-a', agent: 'dsh', taskId: 'a', taskTitle: 'Готова к приёмке', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T11:19:00Z' }],
  totals: {},
  accepted: [],
}

function mount(r = repo, answer: unknown = jsonOk({ accepted: ['a', 'b', 'd'] })) {
  const calls = installFetch((url) => (url.includes('/cost') ? jsonOk(cost) : answer))
  const onSelect = vi.fn()
  render(<AcceptBatch repo={r} onSelect={onSelect} />)
  return { calls, onSelect, user: userEvent.setup() }
}

const sheet = () => within(screen.getByRole('dialog', { name: /Принять задачи/ }))

it('counts tasks waiting for review together with human decisions, and hides itself when there are none', () => {
  setLang('ru')
  expect(acceptableTasks(repo).map((t) => t.id)).toEqual(['a', 'b', 'd'])
  mount()
  expect(screen.getByRole('button', { name: 'Принять все · 3' })).toBeTruthy()
  cleanup()
  mount(makeRepo([makeTask({ id: 'go', status: 'ready' }), makeTask({ id: 'run', status: 'running' })]))
  expect(screen.queryByRole('button', { name: /Принять все/ })).toBeNull()
})

it('sends the checked ids to the guarded batch route', async () => {
  setLang('ru')
  const { calls, user } = mount()
  await user.click(screen.getByRole('button', { name: 'Принять все · 3' }))
  expect(sheet().getByRole('button', { name: 'Принять выбранные · 3' })).toBeTruthy()
  expect(sheet().getByText(/Подтвердите в окне macOS/)).toBeTruthy()

  await user.click(sheet().getByRole('checkbox', { name: /Тоже на приёмке/ }))
  const accept = sheet().getByRole('button', { name: 'Принять выбранные · 2' })
  await user.click(accept)

  const post = calls.find((c) => c.url.endsWith('/accept-batch'))
  expect(post).toMatchObject({ method: 'POST', body: { repo: ROOT, tasks: ['a', 'd'] } })
  expect(post?.headers['x-orchestra-client']).toBe('1')
  expect(screen.queryByRole('dialog', { name: /Принять задачи/ })).toBeNull()
})

it('keeps the sheet open and explains a refusal', async () => {
  setLang('ru')
  const { user } = mount(repo, jsonFail('declined'))
  await user.click(screen.getByRole('button', { name: 'Принять все · 3' }))
  await user.click(sheet().getByRole('button', { name: 'Принять выбранные · 3' }))
  expect(sheet().getByText('Отменено в окне подтверждения')).toBeTruthy()
  cleanup()

  const second = mount(repo, jsonFail('not_reviewable'))
  await second.user.click(screen.getByRole('button', { name: 'Принять все · 3' }))
  await second.user.click(sheet().getByRole('button', { name: 'Принять выбранные · 3' }))
  expect(sheet().getByText('Часть задач уже не ждёт приёмки — обновите выбор')).toBeTruthy()
})

it('shows how long each task has been waiting and opens one in the panel', async () => {
  setLang('ru')
  const { onSelect, user } = mount()
  await user.click(screen.getByRole('button', { name: 'Принять все · 3' }))
  expect(sheet().getByRole('checkbox', { name: /Готова к приёмке/ })).toBeTruthy()
  expect(sheet().getByText(/^a · dsh · ждёт /)).toBeTruthy()
  expect(sheet().getByText('d')).toBeTruthy()
  await user.click(sheet().getAllByRole('button', { name: 'Открыть' })[0] as HTMLElement)
  expect(onSelect).toHaveBeenCalledWith('a')
})

it.each(['ru', 'en'] as const)('names selected negative and disputed tasks in the %s sheet', async (lang) => {
  setLang(lang)
  installFetch((url) => {
    if (url.includes('/cost')) return jsonOk(cost)
    if (url.includes('/task?')) {
      const id = new URL(url, 'http://localhost').searchParams.get('id')!
      return jsonOk(makeDetail({ id, verdict: id === 'a'
        ? { kind: 'negative', why: 'blocked', facts: [] }
        : { kind: 'disputed', mismatch: 'no_files', facts: [] } }))
    }
    return jsonOk({ accepted: ['a', 'b', 'd'] })
  })
  const user = userEvent.setup()
  render(<AcceptBatch repo={repo} onSelect={() => {}} />)
  await user.click(screen.getByRole('button', { name: lang === 'ru' ? 'Принять все · 3' : 'Accept all · 3' }))
  const dialog = screen.getByRole('dialog')
  await waitFor(() => expect(dialog.textContent).toContain(lang === 'ru' ? 'работа заблокирована' : 'work is blocked'))
  expect(dialog.textContent).toContain(lang === 'ru' ? 'изменённых файлов нет' : 'no files changed')
  await user.click(within(dialog).getByRole('checkbox', { name: /Готова к приёмке/ }))
  expect(dialog.textContent).not.toContain(lang === 'ru' ? 'работа заблокирована' : 'work is blocked')
})
