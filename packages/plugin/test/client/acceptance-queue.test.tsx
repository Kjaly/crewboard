// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { OrchestraSnapshot } from '../../src/shared/types.js'
import { App } from '../../src/client/app.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import {
  FakeEventSource,
  ROOT,
  installEventSource,
  installFetch,
  installMatchMedia,
  jsonFail,
  jsonOk,
  makeDetail,
  makeRepo,
  makeSnapshot,
  makeTask,
} from './helpers.js'

beforeEach(() => setLang('ru'))

const snapshot = makeSnapshot(
  makeRepo([
    makeTask({ id: 'a', title: 'Готова к приёмке', status: 'in_review', worker: 'dsh', runs: 1, lastRunId: 'run-1' }),
    makeTask({ id: 'b', title: 'Вторая готовая', status: 'in_review', worker: 'devin', runs: 1, lastRunId: 'run-2' }),
    makeTask({ id: 'd', title: 'Решение за человеком', kind: 'decision', status: 'ready', needsHuman: true }),
    makeTask({ id: 'go', title: 'Ещё ждёт запуска', status: 'ready' }),
    makeTask({ id: 'run', title: 'В работе', status: 'running', worker: 'codex', runs: 1 }),
  ]),
)

const twoHoursAgo = () => new Date(Date.now() - 2 * 3600_000).toISOString()

async function mount(options: { snapshot?: OrchestraSnapshot; answer?: (url: string) => unknown } = {}) {
  installMatchMedia(false)
  installEventSource()
  const snap = options.snapshot ?? snapshot
  const calls = installFetch((url) => {
    if (url.includes('/api/cost')) {
      return jsonOk({
        generatedAt: '',
        runs: [{ taskId: 'a', taskTitle: 'Готова к приёмке', agent: 'dsh', startedAt: twoHoursAgo(), finishedAt: twoHoursAgo() }],
        totals: {},
        accepted: [],
      })
    }
    if (url.includes('/api/task')) {
      const id = new URL(url, 'http://x').searchParams.get('id') ?? 'a'
      return jsonOk(makeDetail({ id, status: 'in_review', changedFiles: ['src/a.ts', 'src/b.ts'] }))
    }
    return options.answer?.(url) ?? jsonOk(snap)
  })
  render(<App />)
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', snap)
  })
  return calls
}

const openQueue = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /Ждут вас/ }))
  return screen.getByRole('complementary', { name: 'Очередь приёмки' })
}

beforeEach(() => {
  setLang('ru')
  localStorage.clear()
  resetOrchestraStore()
})
afterEach(() => cleanup())

it('counts in_review tasks and ready human decisions in the header pill', async () => {
  setLang('ru')
  const user = userEvent.setup()
  await mount()
  // a and b are in_review, d is a ready human decision — go and run do not count.
  const pill = screen.getByRole('button', { name: 'Ждут вас · 3' })
  const queue = await openQueue(user)
  expect(pill.getAttribute('aria-pressed')).toBe('true')
  for (const title of ['Готова к приёмке', 'Вторая готовая', 'Решение за человеком']) {
    expect(within(queue).getByText(title)).toBeTruthy()
  }
  expect(within(queue).queryByText('Ещё ждёт запуска')).toBeNull()
})

it('«Принять все» posts every queued id to /accept-batch', async () => {
  setLang('ru')
  const user = userEvent.setup()
  const calls = await mount()
  const queue = await openQueue(user)
  await user.click(within(queue).getByRole('button', { name: 'Принять все · 3' }))
  const post = calls.find((c) => c.url.endsWith('/accept-batch'))
  expect(post?.method).toBe('POST')
  expect(post?.headers['x-orchestra-client']).toBe('1')
  expect(post?.headers['content-type']).toBe('application/json')
  expect(post?.body).toMatchObject({ repo: ROOT, tasks: ['a', 'b', 'd'] })
})

it('a declined confirmation is named at the row', async () => {
  setLang('ru')
  const user = userEvent.setup()
  await mount({ answer: (url) => (url.endsWith('/accept') ? jsonFail('declined') : jsonOk(snapshot)) })
  const queue = await openQueue(user)
  const row = within(queue).getByText('Готова к приёмке').closest('li')!
  await user.click(within(row).getByRole('button', { name: 'Принять' }))
  expect(await within(row).findByText('Отменено в окне подтверждения')).toBeTruthy()
})

it('rows carry worker and wait; expanding a row reveals the changed files', async () => {
  setLang('ru')
  const user = userEvent.setup()
  await mount()
  const queue = await openQueue(user)
  const row = within(queue).getByText('Готова к приёмке').closest('li')!
  expect(await within(row).findByText(/dsh · ждёт 2 ч 00 м/)).toBeTruthy()
  // The detail is fetched at mount for the report line; the file list itself stays behind the expander.
  expect(within(row).queryByText('src/a.ts')).toBeNull()

  await user.click(within(row).getByRole('button', { name: 'a Готова к приёмке' }))
  expect(await within(row).findByText(/2 файла/)).toBeTruthy()
  expect(within(row).getByText('src/a.ts')).toBeTruthy()
})

it('«Изменения» swaps the queue for the task panel on the Changes tab', async () => {
  setLang('ru')
  const user = userEvent.setup()
  await mount()
  const queue = await openQueue(user)
  const row = within(queue).getByText('Готова к приёмке').closest('li')!
  await user.click(within(row).getByRole('button', { name: 'Изменения' }))
  expect(screen.queryByRole('complementary', { name: 'Очередь приёмки' })).toBeNull()
  const panel = screen.getByRole('complementary', { name: 'Задача: Готова к приёмке' })
  expect(within(panel).getByRole('tab', { name: /Изменения/ }).getAttribute('aria-selected')).toBe('true')
})

it('Escape folds the queue', async () => {
  setLang('ru')
  const user = userEvent.setup()
  await mount()
  await openQueue(user)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('complementary', { name: 'Очередь приёмки' })).toBeNull()
})

it('background plans appear as «ещё M» and offer «Перейти»', async () => {
  setLang('ru')
  const user = userEvent.setup()
  const plan = (id: string, current: boolean, inReview: number) => ({
    id,
    goal: id === 'main' ? 'цель плана' : 'Релиз',
    archived: false,
    current,
    rev: 1,
    updatedAt: '2026-09-22T12:00:00Z',
    taskCount: 4,
    running: 0,
    inReview,
    waitingHuman: inReview,
    ready: 0,
    accepted: 0,
    attention: [],
  })
  const repo = makeRepo([makeTask({ id: 'x', title: 'Одна', status: 'in_review' })], [], {
    planId: 'main',
    plans: [plan('main', true, 1), plan('release', false, 2)],
  })
  const calls = await mount({ snapshot: makeSnapshot(repo) })
  await user.click(screen.getByRole('button', { name: /Ждут вас · 3/ }))
  const queue = screen.getByRole('complementary', { name: 'Очередь приёмки' })
  await user.click(within(queue).getByRole('button', { name: 'Перейти' }))
  const post = calls.find((c) => c.url.endsWith('/plan-use'))
  expect(post?.body).toMatchObject({ repo: ROOT, plan: 'release' })
})

it('an empty queue reads «Ждут вас»', async () => {
  setLang('ru')
  const user = userEvent.setup()
  await mount({ snapshot: makeSnapshot(makeRepo([makeTask({ id: 'x', title: 'Одна', status: 'running' })])) })
  await user.click(screen.getByRole('button', { name: 'Ждут вас' }))
  const queue = screen.getByRole('complementary', { name: 'Очередь приёмки' })
  expect(within(queue).getByRole('button', { name: 'Принять все' })).toHaveProperty('disabled', true)
})
