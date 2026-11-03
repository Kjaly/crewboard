// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tree } from '../src/ui/components/tree.js'
import { setLang } from '../src/ui/text.js'
import type { Step } from '../src/workers/steps.js'
import { fakeApi, node } from './ui-fixtures.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  setLang('en')
})

const step = (i: number, extra: Partial<Step> = {}): Step => ({ i, ts: new Date(Date.UTC(2026, 10, 3, 10, 0, i)).toISOString(), kind: 'command', text: `step ${i}`, status: 'done', ...extra })

function setup(status: 'running' | 'done') {
  setLang('en')
  localStorage.setItem('crewboard.feed.view.w', 'all')
  const f = fakeApi()
  f.state.runSteps.r1 = { steps: [0, 1, 2, 3, 4].map((i) => step(i)), next: 5, done: false }
  const view = (s: 'running' | 'done') => (
    <Tree api={f.api} project="/repo" selectedId="w" onSelect={() => {}} open={new Set()} onToggle={() => {}} root={node('w', s, { parentId: null, runId: 'r1', runOpen: s === 'running' })} />
  )
  const r = render(view(status))
  return { view, ...r }
}

describe('run feed', () => {
  it('shows the last steps under a running node and more once expanded', async () => {
    setup('running')
    expect(await screen.findByText('step 4')).toBeTruthy()
    expect(screen.queryByText('step 1')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Expand the feed' }))
    expect(screen.getByText('step 0')).toBeTruthy()
  })

  it('shows no feed under a running node whose own run has ended, such as one waiting for its parts', async () => {
    const f = fakeApi()
    f.state.runSteps.r1 = { steps: [step(0)], next: 1, done: true }
    render(<Tree api={f.api} project="/repo" selectedId="w" onSelect={() => {}} open={new Set()} onToggle={() => {}} root={node('w', 'running', { parentId: null, runId: 'r1', runOpen: false })} />)
    await screen.findByText('w')
    expect(screen.queryByRole('region', { name: 'Run feed' })).toBeNull()
    expect(screen.queryByText('step 0')).toBeNull()
  })

  it('folds to a one-line summary when the run ends, and can be expanded again', async () => {
    const { view, rerender } = setup('running')
    await screen.findByText('step 4')
    rerender(view('done'))
    expect(await screen.findByText('5 steps · 4 s')).toBeTruthy()
    expect(screen.queryByText('step 4')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Expand the feed' }))
    expect(screen.getByText('step 4')).toBeTruthy()
  })
})

describe('run feed, readable view', () => {
  const messageRun = (): Step[] => [
    step(0, { kind: 'message', text: 'Looking at the tests', status: undefined }),
    step(1), step(2, { kind: 'read' }), step(3),
    step(4, { kind: 'thought' as Step['kind'], text: 'Maybe the cache', status: undefined }),
    step(5, { kind: 'final', text: 'All done', status: undefined }),
  ]
  const mount = (steps: Step[], status: 'running' | 'done' = 'running', f = fakeApi()) => {
    setLang('en')
    f.state.runSteps.r1 = { steps, next: steps.length, done: false }
    render(<Tree api={f.api} project="/repo" selectedId="w" onSelect={() => {}} open={new Set()} onToggle={() => {}} root={node('w', status, { parentId: null, runId: 'r1', runOpen: status === 'running' })} />)
    return f
  }

  it('shows messages as rows, folds the commands between them into one row that expands, and All steps shows everything', async () => {
    mount(messageRun())
    await userEvent.click(await screen.findByRole('button', { name: 'Expand the feed' }))
    expect(screen.getByText('Looking at the tests')).toBeTruthy()
    expect(screen.getByText('All done')).toBeTruthy()
    expect(screen.queryByText('step 1')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '2 commands, 1 file' }))
    expect(screen.getByText('step 1')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '2 commands, 1 file' }))
    await userEvent.click(screen.getByRole('button', { name: 'All steps' }))
    expect(screen.getByText('step 3')).toBeTruthy()
  })

  it('shows no silent marker while the last step is still running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.UTC(2026, 10, 3, 10, 30) })
    try {
      mount([step(0, { status: 'running' })])
      await screen.findByText('1 step')
      expect(screen.queryByText(/silent for/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling a run the server answers 404 for', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const f = fakeApi()
      const calls = vi.fn(async () => {
        throw new Error('404 no such run')
      })
      f.api.steps = calls
      mount([], 'running', f)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
