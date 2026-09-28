// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATTENTION_POLL_MS, ReviewToasts, createReviewCenter, resetReviewCenter, reviewBadgeLabel, reviewBadgeTitle, startReviewCenter } from '../../src/client/notify.js'
import { OrchestraIcon } from '../../src/client/panel.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'
import { bindLayout, resetLayout, selectMainPanel } from '../../src/client/layout.js'
import { setLang } from '../../src/client/i18n.js'

const running = (...ids: string[]) => makeSnapshot(makeRepo(ids.map((id) => makeTask({ id, title: `Задача ${id}`, status: 'running' }))))
const reviewing = (...tasks: Array<{ id: string; title?: string }>) =>
  makeSnapshot(makeRepo(tasks.map((t) => makeTask({ id: t.id, title: t.title ?? `Задача ${t.id}`, status: 'in_review', runs: 1, lastRunId: `run-${t.id}` }))))

beforeEach(() => {
  setLang('ru')
  localStorage.clear()
  resetOrchestraStore()
})
afterEach(() => {
  cleanup()
  resetReviewCenter()
})

it('a task that lands in in_review raises one toast naming it', () => {
  const center = createReviewCenter()
  const { container } = render(<ReviewToasts center={center} />)
  act(() => center.feed(running('f1', 'f2')))
  act(() => center.feed(reviewing({ id: 'f2', title: 'Визуальный проход' })))
  const toasts = container.querySelectorAll('.orc-toast')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.textContent).toContain('f2 «Визуальный проход» готова — ждёт приёмки')
})

it('three transitions in one snapshot are one grouped toast', () => {
  const center = createReviewCenter()
  const { container } = render(<ReviewToasts center={center} />)
  act(() => center.feed(running('f1', 'f2', 'f3')))
  act(() => center.feed(reviewing({ id: 'f1' }, { id: 'f2' }, { id: 'f3' })))
  const toasts = container.querySelectorAll('.orc-toast')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.textContent).toContain('3 задачи ждут ревью — «цель плана»')
})

// at2: a grouped toast says what waits by reason and opens the plan's «Needs you», not one of its tasks.
it('a burst of a review and a decision is one toast grouped by reason that opens the plan queue', async () => {
  const user = userEvent.setup()
  const center = createReviewCenter()
  const { container } = render(<ReviewToasts center={center} />)
  act(() => center.feed(running('f1', 'f2')))
  act(() =>
    center.feed(
      makeSnapshot(
        makeRepo([
          makeTask({ id: 'f1', status: 'in_review', runs: 1, lastRunId: 'run-f1' }),
          makeTask({ id: 'f2', status: 'in_review', runs: 1, lastRunId: 'run-f2' }),
          makeTask({ id: 'd1', kind: 'decision', status: 'ready', needsHuman: true }),
        ]),
      ),
    ),
  )
  const toasts = container.querySelectorAll('.orc-toast')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.textContent).toContain('2 задачи ждут ревью · 1 решение — «цель плана»')
  await user.click(screen.getByRole('button', { name: 'Открыть' }))
  expect(orchestraStore.getState().queueOpen).toBe(true)
})

it('arrivals inside the 5 s window merge into the open toast', () => {
  const center = createReviewCenter()
  const { container } = render(<ReviewToasts center={center} />)
  act(() => center.feed(running('f1', 'f2')))
  act(() => center.feed(reviewing({ id: 'f1' })))
  act(() => center.feed(reviewing({ id: 'f1' }, { id: 'f2' })))
  const toasts = container.querySelectorAll('.orc-toast')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.textContent).toContain('2 задачи ждут ревью — «цель плана»')
})

it('a ready decision task notifies as «решение за вами» and counts toward the badge', () => {
  const center = createReviewCenter()
  const { container } = render(<ReviewToasts center={center} />)
  act(() => center.feed(running('f1')))
  act(() =>
    center.feed(
      makeSnapshot(
        makeRepo([
          makeTask({ id: 'f1', status: 'running' }),
          makeTask({ id: 'd1', title: 'Тон текстов', kind: 'decision', status: 'ready', needsHuman: true }),
        ]),
      ),
    ),
  )
  const toasts = container.querySelectorAll('.orc-toast')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.textContent).toContain('d1 «Тон текстов» — решение за вами')
  expect(center.getState().waiting).toBe(1)
})

it('a new centre with the same localStorage does not repeat seen tasks', () => {
  const snap = reviewing({ id: 'f2', title: 'Визуальный проход' })
  const first = createReviewCenter()
  const one = render(<ReviewToasts center={first} />)
  act(() => first.feed(snap))
  expect(one.container.querySelectorAll('.orc-toast')).toHaveLength(1)
  one.unmount()

  // «Reload»: a fresh centre reads the same persisted seen-set and stays quiet.
  const second = createReviewCenter()
  const two = render(<ReviewToasts center={second} />)
  act(() => second.feed(snap))
  expect(two.container.querySelectorAll('.orc-toast')).toHaveLength(0)
})

it('«Открыть» selects the panel and the task', async () => {
  const user = userEvent.setup()
  const selectPanel = vi.fn()
  const center = createReviewCenter({ selectPanel })
  render(<ReviewToasts center={center} />)
  act(() => center.feed(running('f2')))
  act(() => center.feed(reviewing({ id: 'f2', title: 'Визуальный проход' })))
  await user.click(screen.getByRole('button', { name: 'Открыть' }))
  expect(selectPanel).toHaveBeenCalledWith('crewboard')
  expect(orchestraStore.getState().queueOpen).toBe(false)
  expect(localStorage.getItem(`crewboard:task:${ROOT}`)).toBe('f2')
})

it('the app-level centre feeds the icon badge and the toast root without a stream of its own', async () => {
  installEventSource()
  let state = running('f1')
  installFetch((url) => (url.endsWith('/state') ? jsonOk(state) : jsonOk(null)))
  vi.useFakeTimers()
  try {
    const { container } = render(<OrchestraIcon size={16} active={false} />)
    const selectPanel = vi.fn()
    // Boot: the badge reads /state once and opens no EventSource (fx: 6 connections per host).
    await act(async () => {
      startReviewCenter({ inject: (_names, fn) => fn({ layout: { selectPanel } }) })
    })
    expect(FakeEventSource.opened).toBe(0)
    state = reviewing({ id: 'f1' }, { id: 'f2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS) })
    expect(container.querySelector('.orc-icon__badge')?.textContent).toBe('2')
    // The item's name stays plain; the count is on the badge and in the icon's hover title.
    expect(reviewBadgeLabel()).toBe('Оркестрация')
    expect(reviewBadgeTitle()).toBe('Оркестрация, очередь разбора: 2 — repo · цель плана: 2 задачи ждут ревью')
    // The toast root lives outside the rendered tree — under document.body.
    expect(document.querySelector('[data-orchestra-toasts] .orc-toast__text')?.textContent).toContain('2 задачи ждут ревью')

    // The screen opens the tab's one stream; the badge hears its frames and stops polling while it is live.
    const off = orchestraStore.subscribe(() => {})
    expect(FakeEventSource.opened).toBe(1)
    const source = FakeEventSource.last
    await act(async () => {
      source?.onopen?.()
      source?.emit('snapshot', reviewing({ id: 'f1' }, { id: 'f2' }, { id: 'f3' }))
    })
    expect(container.querySelector('.orc-icon__badge')?.textContent).toBe('3')
    const polls = vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).endsWith('/state')).length
    await act(async () => { await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS) })
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).endsWith('/state'))).toHaveLength(polls)
    off()
    expect(source?.closed).toBe(true)
  } finally {
    resetReviewCenter()
    vi.useRealTimers()
  }
  expect(document.querySelector('[data-orchestra-toasts]')).toBeNull()
})

it('names a ready task in English when no language is chosen', () => {
  setLang('en')
  const center = createReviewCenter()
  const { container } = render(<ReviewToasts center={center} />)
  act(() => center.feed(running('f1')))
  act(() => center.feed(reviewing({ id: 'f1', title: 'Visual pass' })))
  expect(container.querySelector('.orc-toast__text')?.textContent).toContain('f1 “Visual pass” is ready — waiting for acceptance')
})

describe('«Открыть» и сервис layout', () => {
  it('берёт selectPanel через инъекцию сервиса, а не со свойства контекста', async () => {
    resetLayout()
    const selected: string[] = []
    const layout = { selectPanel: (key: string) => selected.push(key) }
    // dsh отдаёт layout только инъекцией: свойства на самом контексте нет.
    const ctx = {
      get: (name: string) => (name === 'layout' ? undefined : undefined),
      inject: (names: string[], fn: (child: { layout: typeof layout }) => void) => {
        if (names.includes('layout')) fn({ layout })
      },
    }
    bindLayout(ctx)
    expect(selectMainPanel('crewboard')).toBe(true)
    expect(selected).toEqual(['crewboard'])
  })

  it('не падает, когда оболочка не даёт сервис', () => {
    resetLayout()
    bindLayout({})
    expect(selectMainPanel('crewboard')).toBe(false)
  })
})

it('waits for the full snapshot: a quick first paint of the host reaches neither the badge nor the toasts (pf1)', async () => {
  installEventSource()
  const quick = reviewing({ id: 'f1' }, { id: 'f2' })
  installFetch((url) => (url.endsWith('/state') ? jsonOk({ ...quick, repos: quick.repos.map((repo) => ({ ...repo, partial: true })) }) : jsonOk(null)))
  try {
    const { container } = render(<OrchestraIcon size={16} active={false} />)
    await act(async () => {
      startReviewCenter({ inject: (_names, fn) => fn({ layout: { selectPanel: vi.fn() } }) })
    })
    const off = orchestraStore.subscribe(() => {})
    await act(async () => { FakeEventSource.last?.onopen?.(); FakeEventSource.last?.emit('snapshot', { ...quick, repos: quick.repos.map((repo) => ({ ...repo, partial: true })) }) })
    expect(container.querySelector('.orc-icon__badge')).toBeNull()
    expect(document.querySelector('[data-orchestra-toasts] .orc-toast__text')).toBeNull()
    await act(async () => { FakeEventSource.last?.emit('snapshot', quick) })
    expect(container.querySelector('.orc-icon__badge')?.textContent).toBe('2')
    off()
  } finally {
    resetReviewCenter()
  }
})
