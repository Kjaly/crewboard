// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskDetail, TaskSnapshot } from '../../src/shared/types.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { LiveActivity, activityPhase, overlapCount, runIsLive, stabilizeGroupKeys } from '../../src/client/panel/live-activity.js'
import { groupEvents } from '../../src/client/panel/tabs.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

type Event = TaskDetail['events'][number]
type Run = TaskDetail['runs'][number]

const RUN: Run = { runId: 'r1', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z' }
const at = (n: number) => `2026-09-22T12:${String(n).padStart(2, '0')}:00Z`
const action = (n: number, text = `step ${n}`): Event => ({ ts: at(n), kind: 'action', text })
const message = (n: number, text: string): Event => ({ ts: at(n), kind: 'message', text })
const detailWith = (events: Event[], over: Partial<TaskDetail> = {}): TaskDetail =>
  makeDetail({ id: 'a', status: 'running', runs: [RUN], events, ...over })

beforeEach(() => setLang('ru'))
afterEach(() => cleanup())

describe('rolling-window overlap', () => {
  it('finds the retained tail when one event leaves as another arrives', () => {
    const prev = [action(0), action(1), action(2), action(3)]
    const next = [action(1), action(2), action(3), action(4)]
    expect(overlapCount(prev, next)).toBe(3)
  })

  it('treats a grown message as an update, not a new line', () => {
    const prev = [message(1, 'Hel')]
    const next = [message(1, 'Hello')]
    expect(overlapCount(prev, next)).toBe(1)
  })

  it('reports no overlap for a replaced window', () => {
    expect(overlapCount([action(0), action(1)], [action(5), action(6)])).toBe(0)
  })
})

describe('live run phase', () => {
  const task = (status: TaskSnapshot['status']) => ({ status })

  it('is working only for the latest open run of a running task', () => {
    const runs = [{ ...RUN }, { ...RUN, runId: 'r2' }]
    expect(runIsLive(task('running'), runs, runs[1])).toBe(true)
    expect(runIsLive(task('running'), runs, runs[0])).toBe(false)
    expect(runIsLive(task('in_review'), runs, runs[1])).toBe(false)
  })

  it('never pulses a terminal run even when a legacy snapshot omits finishedAt', () => {
    const runs: Run[] = [{ ...RUN, outcome: 'failed' }]
    expect(runIsLive(task('running'), runs, runs[0])).toBe(false)
    expect(activityPhase(task('running'), runs, runs[0])).toEqual({ kind: 'terminal', outcome: 'failed' })
  })

  it('reads a current open tool as the working step and no open tool as waiting', () => {
    const runs = [RUN]
    expect(activityPhase(task('running'), runs, RUN, [action(0)])).toEqual({ kind: 'waiting' })
    expect(activityPhase(task('running'), runs, RUN, [{ ...action(0), open: true }])).toEqual({ kind: 'working', step: 'step 0' })
  })

  it('reads an older unfinished run as history, never as live', () => {
    const runs = [RUN, { ...RUN, runId: 'r2' }]
    expect(activityPhase(task('running'), runs, runs[0])).toEqual({ kind: 'past' })
  })
})

describe('stable group keys across a rolling tail', () => {
  it('keeps the key of a group whose oldest event expired and that gained a new one', () => {
    const first = stabilizeGroupKeys([], groupEvents([action(0), action(1), message(2, 'ready')]), 0)
    const second = stabilizeGroupKeys(first.state, groupEvents([action(1), action(2), message(2, 'ready'), message(3, 'done')]), first.seq)
    expect(second.keys[0]).toBe(first.keys[0])
    expect(second.keys[1]).toBe(first.keys[1])
    expect(second.keys[2]).not.toBe(first.keys[1])
  })
})

describe('TaskPanel default tab policy', () => {
  const repoFor = (tasks: TaskSnapshot[]) => makeRepo(tasks)
  const mount = (task: TaskSnapshot, extra: { tabRequest?: { tab: string; seq: number; taskId?: string } } = {}) => {
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, status: task.status, runs: [] })) : jsonOk(null)))
    const repo = repoFor([task])
    const renderPanel = (t: TaskSnapshot) => (
      <TaskPanel repo={repo} task={t} attention={[]} onSelect={() => {}} density="overview" {...extra} />
    )
    return { repo, renderPanel, ...render(renderPanel(task)) }
  }
  const selected = (name: string) => screen.getByRole('tab', { name }).getAttribute('aria-selected')

  it('opens Activity for a running worker task and Overview for a finished one', () => {
    mount(makeTask({ id: 'a', status: 'running' }))
    expect(selected('Активность')).toBe('true')
    cleanup()
    mount(makeTask({ id: 'a', status: 'in_review' }))
    expect(selected('Обзор')).toBe('true')
  })

  it('opens Activity when a ready task starts, and keeps reading on completion', async () => {
    const { renderPanel, rerender } = mount(makeTask({ id: 'a', status: 'ready' }))
    expect(selected('Обзор')).toBe('true')
    rerender(renderPanel(makeTask({ id: 'a', status: 'running' })))
    expect(selected('Активность')).toBe('true')
    rerender(renderPanel(makeTask({ id: 'a', status: 'in_review' })))
    expect(selected('Активность')).toBe('true')
  })

  it('does not steal a manual tab on a same-task snapshot', async () => {
    const user = userEvent.setup()
    const { renderPanel, rerender } = mount(makeTask({ id: 'a', status: 'running' }))
    await user.click(screen.getByRole('tab', { name: 'Обзор' }))
    expect(selected('Обзор')).toBe('true')
    rerender(renderPanel(makeTask({ id: 'a', status: 'running', runs: 1 })))
    expect(selected('Обзор')).toBe('true')
  })

  it('resets to the default on a task switch', async () => {
    const user = userEvent.setup()
    const a = makeTask({ id: 'a', status: 'running' })
    const b = makeTask({ id: 'b', status: 'running' })
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'running', runs: [] })) : jsonOk(null)))
    const repo = makeRepo([a, b])
    const { rerender } = render(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
    await user.click(screen.getByRole('tab', { name: 'Обзор' }))
    expect(selected('Обзор')).toBe('true')
    rerender(<TaskPanel repo={repo} task={b} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(selected('Активность')).toBe('true'))
  })

  it('honours an explicit scoped tab request', () => {
    mount(makeTask({ id: 'a', status: 'running' }), { tabRequest: { tab: 'contract', taskId: 'a', seq: 1 } })
    expect(selected('Контракт')).toBe('true')
  })
})

describe('LiveActivity following', () => {
  let scrollEl: HTMLDivElement | null = null
  function Harness({ detail, task, run }: { detail: TaskDetail; task: TaskSnapshot; run: Run }) {
    const ref = useRef<HTMLDivElement | null>(null)
    return (
      <div ref={(el) => { ref.current = el; scrollEl = el }}>
        <LiveActivity detail={detail} task={task} run={run} scrollRef={ref} />
      </div>
    )
  }
  const setMetrics = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  }

  it('follows two consecutive equal-sized appends while already at the bottom', () => {
    const task = makeTask({ id: 'a', status: 'running' })
    const { rerender } = render(<Harness detail={detailWith([action(0)])} task={task} run={RUN} />)
    const el = scrollEl!
    setMetrics(el, 1000, 300)
    el.scrollTop = 0
    rerender(<Harness detail={detailWith([action(0), action(1)])} task={task} run={RUN} />)
    expect(el.scrollTop).toBeGreaterThan(0)
    el.scrollTop = 0
    rerender(<Harness detail={detailWith([action(0), action(1), action(2)])} task={task} run={RUN} />)
    expect(el.scrollTop).toBeGreaterThan(0)
  })

  it('pauses following when the reader scrolled up and offers a localized catch-up', async () => {
    const user = userEvent.setup()
    const task = makeTask({ id: 'a', status: 'running' })
    const { rerender } = render(<Harness detail={detailWith([action(0)])} task={task} run={RUN} />)
    const el = scrollEl!
    setMetrics(el, 1000, 300)
    el.scrollTop = 0
    fireEvent.scroll(el)
    rerender(<Harness detail={detailWith([action(0), action(1)])} task={task} run={RUN} />)
    const jump = screen.getByRole('button', { name: '1 новая строка' })
    expect(el.scrollTop).toBe(0)
    await user.click(jump)
    expect(el.scrollTop).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '1 новая строка' })).toBeNull()
  })

  it('marks only the appended line, including one added inside the last tools group', () => {
    const task = makeTask({ id: 'a', status: 'running' })
    const { container, rerender } = render(<Harness detail={detailWith([action(0), action(1)])} task={task} run={RUN} />)
    expect(container.querySelectorAll('.orc-ev--enter')).toHaveLength(0)
    rerender(<Harness detail={detailWith([action(0), action(1), action(2)])} task={task} run={RUN} />)
    const entered = [...container.querySelectorAll('.orc-ev--enter')]
    expect(entered).toHaveLength(1)
    expect(entered[0]?.textContent).toBe('step 2')
  })

  it('does not re-animate retained history after a same-length window shift', () => {
    const task = makeTask({ id: 'a', status: 'running' })
    const { container, rerender } = render(<Harness detail={detailWith([action(0), action(1), action(2)])} task={task} run={RUN} />)
    rerender(<Harness detail={detailWith([action(1), action(2), action(3)])} task={task} run={RUN} />)
    const entered = [...container.querySelectorAll('.orc-ev--enter')]
    expect(entered).toHaveLength(1)
    expect(entered[0]?.textContent).toBe('step 3')
  })

  it('does not animate an in-place message text update', () => {
    const task = makeTask({ id: 'a', status: 'running' })
    const { container, rerender } = render(<Harness detail={detailWith([message(1, 'Hel')])} task={task} run={RUN} />)
    rerender(<Harness detail={detailWith([message(1, 'Hello')])} task={task} run={RUN} />)
    expect(container.querySelectorAll('.orc-ev--enter')).toHaveLength(0)
    expect(screen.getByText('Hello')).toBeTruthy()
  })

  it('pauses the pulse while the page is hidden, live run or not', () => {
    const task = makeTask({ id: 'a', status: 'running' })
    const detail = makeDetail({ id: 'a', status: 'running', runs: [RUN], events: [{ ...action(0), open: true }] })
    const { container } = render(<LiveActivity detail={detail} task={task} run={RUN} scrollRef={{ current: null }} />)
    const live = container.querySelector('.orc-live')
    expect(live?.getAttribute('data-paused')).toBe('false')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(live?.getAttribute('data-paused')).toBe('true')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('starts a live feed at its latest activity without animating history', () => {
    const task = makeTask({ id: 'a', status: 'running' })
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 })
    const { container } = render(<LiveActivity detail={detailWith([action(0), action(1), action(2)])} task={task} run={RUN} scrollRef={{ current: el }} />)
    expect(el.scrollTop).toBeGreaterThan(0)
    expect(container.querySelectorAll('.orc-ev--enter')).toHaveLength(0)
  })

  it('does not jump to the end when the run completes while the reader is above', () => {
    const running = makeTask({ id: 'a', status: 'running' })
    const task = makeTask({ id: 'a', status: 'in_review' })
    const ended: Run = { ...RUN, finishedAt: '2026-09-22T12:30:00Z', outcome: 'completed' }
    const { rerender } = render(<Harness detail={detailWith([action(0), action(1)])} task={running} run={RUN} />)
    const el = scrollEl!
    setMetrics(el, 1000, 300)
    el.scrollTop = 0
    fireEvent.scroll(el)
    rerender(<Harness detail={detailWith([action(0), action(1)], { status: 'in_review', runs: [ended] })} task={task} run={ended} />)
    expect(el.scrollTop).toBe(0)
  })

  it('shows a true terminal outcome and offers the report without leaving Activity', async () => {
    const user = userEvent.setup()
    const task = makeTask({ id: 'a', status: 'in_review' })
    const ended: Run = { ...RUN, finishedAt: '2026-09-22T12:30:00Z', outcome: 'completed' }
    const detail = makeDetail({ id: 'a', status: 'in_review', runs: [ended], events: [action(0)], report: { text: '# Report' } as unknown as TaskDetail['report'] })
    let opened = false
    render(
      <LiveActivity detail={detail} task={task} run={ended} scrollRef={{ current: null }} onOpenReport={() => { opened = true }} />,
    )
    expect(screen.getByText('завершён')).toBeTruthy()
    expect(screen.queryByText('Работает')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Открыть отчёт' }))
    expect(opened).toBe(true)
  })
})
