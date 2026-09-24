// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orchestraStore, resetOrchestraStore, useOrchestra } from '../../src/client/store.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, makeRepo, makeSnapshot, makeTask } from './helpers.js'

function Probe() {
  const { repo, view, density, connection, lens } = useOrchestra()
  return (
    <div>
      <span data-testid="goal">{repo?.goal ?? 'нет плана'}</span>
      <span data-testid="tasks">{repo?.tasks.length ?? 0}</span>
      <span data-testid="view">{view}</span>
      <span data-testid="density">{density}</span>
      <span data-testid="connection">{connection}</span>
      <span data-testid="lens">{lens ?? 'нет'}</span>
    </div>
  )
}

const failingState = () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'offline' }), text: async () => '' })

async function pushSnapshot() {
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', makeSnapshot(makeRepo([makeTask({ id: 'a' }), makeTask({ id: 'b', status: 'running' })])))
  })
}

describe('useOrchestra', () => {
  it('copies legacy localStorage keys at module startup, before store access', async () => {
    localStorage.setItem('dsh-orchestra:view:/startup', 'review')
    vi.resetModules()
    await import('../../src/client/store.js')
    expect(localStorage.getItem('crewboard:view:/startup')).toBe('review')
  })
  // The screen «jumped home» after an acceptance (owner, 2026-09-23): the host lists only the
  // repositories whose snapshot is built, so the chosen one can vanish for a beat — and the screen
  // used to land on repos[0], a different repository with a different plan and the default view.
  it('holds the chosen repository while it is missing from a snapshot', async () => {
    orchestraStore.setRepo(ROOT)
    render(<Probe />)
    await act(async () => { FakeEventSource.last?.emit('snapshot', makeSnapshot(makeRepo([makeTask({ id: 'a' })]))) })
    expect(screen.getByTestId('goal').textContent).toBe('цель плана')
    const other = makeRepo([makeTask({ id: 'z' })], [], { root: '/other', goal: 'чужой репозиторий' })
    await act(async () => { FakeEventSource.last?.emit('snapshot', makeSnapshot(other)) })
    expect(screen.getByTestId('goal').textContent).toBe('цель плана')
    await act(async () => { FakeEventSource.last?.emit('snapshot', makeSnapshot(makeRepo([makeTask({ id: 'a' }), makeTask({ id: 'b' })]))) })
    expect(screen.getByTestId('tasks').textContent).toBe('2')
  })

  beforeEach(() => {
    localStorage.clear()
    resetOrchestraStore()
    installEventSource()
    installFetch(() => failingState())
  })
  afterEach(() => cleanup())

  it('shows the snapshot that arrives over SSE', async () => {
    render(<Probe />)
    expect(screen.getByTestId('goal').textContent).toBe('нет плана')
    await pushSnapshot()
    expect(screen.getByTestId('goal').textContent).toBe('цель плана')
    expect(screen.getByTestId('tasks').textContent).toBe('2')
    expect(screen.getByTestId('connection').textContent).toBe('live')
  })

  it('restores the view and the density from localStorage', async () => {
    localStorage.setItem(`crewboard:view:${ROOT}`, 'console')
    localStorage.setItem('crewboard:density', 'detail')
    resetOrchestraStore()
    render(<Probe />)
    await pushSnapshot()
    expect(screen.getByTestId('view').textContent).toBe('graph')
    expect(screen.getByTestId('density').textContent).toBe('detail')
  })

  it('keeps the lens per plan in localStorage', async () => {
    render(<Probe />)
    await pushSnapshot()
    expect(screen.getByTestId('lens').textContent).toBe('нет')
    act(() => orchestraStore.setLens('ready'))
    expect(screen.getByTestId('lens').textContent).toBe('ready')
    expect(localStorage.getItem(`crewboard:lens:${ROOT}`)).toBe('ready')
    act(() => orchestraStore.setLens(null))
    expect(screen.getByTestId('lens').textContent).toBe('нет')
  })

  it('migrates an old «filter» value into the lens key', async () => {
    localStorage.setItem('crewboard:filter', 'attention')
    resetOrchestraStore()
    render(<Probe />)
    await pushSnapshot()
    expect(screen.getByTestId('lens').textContent).toBe('attention')
    expect(localStorage.getItem('crewboard:filter')).toBeNull()
    expect(localStorage.getItem(`crewboard:lens:${ROOT}`)).toBe('attention')
  })

  it('renders when localStorage throws', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled')
      },
    })
    try {
      resetOrchestraStore()
      render(<Probe />)
      await pushSnapshot()
      expect(screen.getByTestId('goal').textContent).toBe('цель плана')
      expect(screen.getByTestId('view').textContent).toBe('graph')
      expect(screen.getByTestId('density').textContent).toBe('overview')
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
    }
  })
})
