// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AcceptBatch, acceptableTasks } from '../../src/client/views/accept-batch.js'
import type { TaskDetail } from '../../src/shared/types.js'
import { ROOT, installFetch, jsonFail, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))
afterEach(() => cleanup())

const NOW = '2026-09-22T12:00:00Z'

const repo = makeRepo([
  makeTask({ id: 'a', title: 'Готова к приёмке', status: 'in_review', worker: 'dsh' }),
  makeTask({ id: 'b', title: 'Тоже на приёмке', status: 'in_review', worker: 'devin' }),
  makeTask({ id: 'd', title: 'Выбрать движок', kind: 'decision', status: 'ready', needsHuman: true, check: 'checked' }),
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

type Verdicts = Record<string, TaskDetail['verdict']>
const clean: Verdicts = { a: { kind: 'result', facts: [] }, b: { kind: 'result', facts: [] }, d: undefined }

function mount(r = repo, answer: unknown = jsonOk({ accepted: ['a', 'b', 'd'] }), verdicts: Verdicts = clean) {
  const calls = installFetch((url) => {
    if (url.includes('/cost')) return jsonOk(cost)
    if (url.includes('/task?')) {
      const id = new URL(url, 'http://localhost').searchParams.get('id')!
      return jsonOk({ ...makeDetail({ id }), verdict: verdicts[id] })
    }
    return answer
  })
  const onSelect = vi.fn()
  render(<AcceptBatch repo={r} onSelect={onSelect} />)
  return { calls, onSelect, user: userEvent.setup() }
}

const sheet = () => within(screen.getByRole('dialog', { name: /Принять задачи/ }))
const loaded = () => waitFor(() => expect(sheet().queryByText('Читаю вердикты…')).toBeNull())

it('counts tasks waiting for review together with human decisions, and hides itself when there are none', () => {
  setLang('ru')
  expect(acceptableTasks(repo).map((t) => t.id)).toEqual(['a', 'b', 'd'])
  mount()
  expect(screen.getByRole('button', { name: 'Принять пакетом · 3' })).toBeTruthy()
  cleanup()
  mount(makeRepo([makeTask({ id: 'go', status: 'ready' }), makeTask({ id: 'run', status: 'running' })]))
  expect(screen.queryByRole('button', { name: /Принять пакетом/ })).toBeNull()
})

it('sends the checked ids to the guarded batch route', async () => {
  setLang('ru')
  const { calls, user } = mount()
  await user.click(screen.getByRole('button', { name: 'Принять пакетом · 3' }))
  await loaded()
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
  await user.click(screen.getByRole('button', { name: 'Принять пакетом · 3' }))
  await loaded()
  await user.click(sheet().getByRole('button', { name: 'Принять выбранные · 3' }))
  expect(sheet().getByText('Отменено в окне подтверждения')).toBeTruthy()
  cleanup()

  const second = mount(repo, jsonFail('not_reviewable'))
  await second.user.click(screen.getByRole('button', { name: 'Принять пакетом · 3' }))
  await loaded()
  await second.user.click(sheet().getByRole('button', { name: 'Принять выбранные · 3' }))
  expect(sheet().getByText('Часть задач уже не ждёт приёмки — обновите выбор')).toBeTruthy()
})

it('shows how long each task has been waiting and opens one in the panel', async () => {
  setLang('ru')
  const { onSelect, user } = mount()
  await user.click(screen.getByRole('button', { name: 'Принять пакетом · 3' }))
  expect(sheet().getByRole('checkbox', { name: /Готова к приёмке/ })).toBeTruthy()
  expect(sheet().getByText(/^a · dsh · ждёт /)).toBeTruthy()
  expect(sheet().getByText('d')).toBeTruthy()
  await loaded()
  await user.click(sheet().getAllByRole('button', { name: 'Открыть' })[0] as HTMLElement)
  expect(onSelect).toHaveBeenCalledWith('a')
})

it('selects nothing until the verdicts are read', async () => {
  setLang('ru')
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  installFetch(async (url) => {
    if (url.includes('/cost')) return jsonOk(cost)
    const id = new URL(url, 'http://localhost').searchParams.get('id')!
    await held
    return jsonOk({ ...makeDetail({ id }), verdict: clean[id] })
  })
  const user = userEvent.setup()
  render(<AcceptBatch repo={repo} onSelect={() => {}} />)
  await user.click(screen.getByRole('button', { name: 'Принять пакетом · 3' }))
  expect(sheet().getByText('Читаю вердикты…')).toBeTruthy()
  expect(sheet().getByRole('button', { name: 'Принять выбранные · 0' })).toHaveProperty('disabled', true)
  release()
  await loaded()
  expect(sheet().getByRole('button', { name: 'Принять выбранные · 3' })).toBeTruthy()
})

const risky: Verdicts = {
  a: { kind: 'negative', why: 'blocked', facts: [] },
  b: { kind: 'disputed', mismatch: 'no_files', facts: [] },
  c: { kind: 'result', facts: [] },
  u: { kind: 'result', facts: [] },
  d: undefined,
}
const mixed = makeRepo([
  makeTask({ id: 'a', title: 'Готова к приёмке', status: 'in_review', worker: 'dsh' }),
  makeTask({ id: 'b', title: 'Тоже на приёмке', status: 'in_review', worker: 'devin' }),
  makeTask({ id: 'c', title: 'Чистый результат', status: 'in_review', worker: 'codex' }),
  makeTask({ id: 'u', title: 'Своя работа без проверки', kind: 'root', status: 'in_review' }),
  makeTask({ id: 'd', title: 'Выбрать движок', kind: 'decision', status: 'ready', needsHuman: true }),
])

it.each(['ru', 'en'] as const)('pre-selects only clean results and groups risky work without ticks in the %s sheet (w1b, B03)', async (lang) => {
  setLang(lang)
  const { calls, user } = mount(mixed, jsonOk({ accepted: ['c'] }), risky)
  await user.click(screen.getByRole('button', { name: lang === 'ru' ? 'Принять пакетом · 5' : 'Accept in batch · 5' }))
  const dialog = screen.getByRole('dialog')
  await waitFor(() => expect(within(dialog).getByRole('region', { name: lang === 'ru' ? 'Чистые · 1' : 'Clean · 1' })).toBeTruthy())
  const cleanGroup = within(within(dialog).getByRole('region', { name: lang === 'ru' ? 'Чистые · 1' : 'Clean · 1' }))
  const riskyGroup = within(within(dialog).getByRole('region', { name: lang === 'ru' ? 'Сначала открыть · 4' : 'Open first · 4' }))
  expect(cleanGroup.getByRole('checkbox', { name: /Чистый результат/ })).toHaveProperty('checked', true)
  for (const title of [/Готова к приёмке/, /Тоже на приёмке/, /Своя работа без проверки/, /Выбрать движок/]) {
    expect(riskyGroup.getByRole('checkbox', { name: title })).toHaveProperty('checked', false)
  }
  expect(dialog.textContent).toContain(lang === 'ru' ? 'работа заблокирована' : 'work is blocked')
  expect(dialog.textContent).toContain(lang === 'ru' ? 'изменённых файлов нет' : 'no files changed')
  expect(dialog.textContent).toContain(lang === 'ru' ? 'Выбрано: чистых 1, с риском 0' : 'Selected: 1 clean, 0 at risk')

  // A deliberate tick includes risky work, and the summary counts it.
  await user.click(riskyGroup.getByRole('checkbox', { name: /Тоже на приёмке/ }))
  expect(dialog.textContent).toContain(lang === 'ru' ? 'Выбрано: чистых 1, с риском 1' : 'Selected: 1 clean, 1 at risk')
  await user.click(within(dialog).getByRole('button', { name: lang === 'ru' ? 'Принять выбранные · 2' : 'Accept selected · 2' }))
  expect(calls.find((c) => c.url.endsWith('/accept-batch'))?.body).toMatchObject({ tasks: ['b', 'c'] })
})

it('treats a verdict that could not be read as risk', async () => {
  setLang('en')
  const { user } = mount(repo, jsonOk({ accepted: [] }), { a: { kind: 'result', facts: [] }, d: undefined })
  await user.click(screen.getByRole('button', { name: 'Accept in batch · 3' }))
  const dialog = screen.getByRole('dialog')
  await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Тоже на приёмке/ })).toHaveProperty('checked', false))
  expect(dialog.textContent).toContain('Verdict unavailable')
})
