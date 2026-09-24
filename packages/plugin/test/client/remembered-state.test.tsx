// @vitest-environment jsdom
// ld1 (owner, 2026-09-24): a bare route stayed on «Loading plans…» for good while a direct
// `#orchestra/…` link opened at once. Remembered screen state is a convenience: whatever it holds —
// stale, corrupted or throwing — the snapshot must reach the screen and a plan must show.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/client/api.js'
import { App } from '../../src/client/app.js'
import { setLang, t } from '../../src/client/i18n.js'
import { formatRoute } from '../../src/client/route.js'
import { STALL_MS, orchestraStore, resetOrchestraStore, useOrchestra } from '../../src/client/store.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

const repo = makeRepo([makeTask({ id: 'a' }), makeTask({ id: 'b' })], [], { planId: 'p' })
const snapshot = makeSnapshot(repo)
const scope = `${ROOT}:p`

function Probe() {
  const { repo: shown, selectedId, view, density, lens } = useOrchestra()
  return <div data-testid="probe">{shown?.goal ?? 'нет плана'}|{selectedId ?? '-'}|{view}|{density}|{lens ?? '-'}</div>
}
const probe = () => screen.getByTestId('probe').textContent

async function loadBare(frames = 1) {
  resetOrchestraStore()
  orchestraStore.startRouting()
  render(<Probe />)
  for (let i = 0; i < frames; i++) await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
  // Restores run in microtasks after the frame.
  await act(async () => {})
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  resetOrchestraStore()
  installEventSource()
  installFetch(() => jsonOk(snapshot))
})
afterEach(() => { cleanup(); resetOrchestraStore(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/') })

describe('stale and corrupted remembered values on a bare route', () => {
  // Each row: what storage holds → the screen still shows the plan with safe defaults.
  const rows: Array<[string, Record<string, string>, string]> = [
    ['a removed repository', { 'crewboard:repo': '/gone' }, 'цель плана|-|graph|overview|-'],
    ['a repository spelled another way (rg1)', { 'crewboard:repo': '/private/repo' }, 'цель плана|-|graph|overview|-'],
    ['a route that is not a route', { 'crewboard:repo': ROOT, [`crewboard:route:${ROOT}`]: 'not a route' }, 'цель плана|-|graph|overview|-'],
    ['a route with broken encoding', { 'crewboard:repo': ROOT, [`crewboard:route:${ROOT}`]: '#orchestra/%E0%A4%A/p/graph' }, 'цель плана|-|graph|overview|-'],
    ['a route to a removed plan and task', { 'crewboard:repo': ROOT, [`crewboard:route:${ROOT}`]: formatRoute({ repo: ROOT, plan: 'gone', view: 'work', task: 'zzz' }) }, 'цель плана|-|work|overview|-'],
    ['a route with unknown view, tab and lens', { 'crewboard:repo': ROOT, [`crewboard:route:${ROOT}`]: '#orchestra/%2Frepo/p/banana/a/nope?lens=nope' }, 'цель плана|a|graph|overview|-'],
    ['a removed task selection', { [`crewboard:task:${scope}`]: 'zzz' }, 'цель плана|-|graph|overview|-'],
    ['unknown view, density and lens', { [`crewboard:view:${scope}`]: 'banana', [`crewboard:density:${scope}`]: 'huge', [`crewboard:lens:${scope}`]: 'nope' }, 'цель плана|-|graph|overview|-'],
  ]
  it.each(rows)('%s', async (_name, stored, expected) => {
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value)
    await loadBare()
    expect(probe()).toBe(expected)
  })

  it('a route whose restore throws is forgotten and told once; the snapshot is still shown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(api, 'planUse').mockImplementation(() => { throw new Error('boom') })
    const withPlans = makeSnapshot({ ...repo, plans: [{ id: 'p', current: true }, { id: 'p2' }] as never })
    localStorage.setItem('crewboard:repo', ROOT)
    localStorage.setItem(`crewboard:route:${ROOT}`, formatRoute({ repo: ROOT, plan: 'p2', view: 'work', task: 'a' }))
    resetOrchestraStore()
    orchestraStore.startRouting()
    render(<Probe />)
    for (let i = 0; i < 3; i++) {
      await act(async () => { FakeEventSource.last?.emit('snapshot', withPlans) })
      await act(async () => {})
    }
    expect(probe()).toBe('цель плана|-|graph|overview|-')
    expect(localStorage.getItem(`crewboard:route:${ROOT}`)).toBeNull()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain(`crewboard:route:${ROOT}`)
  })

  it('a remembered route to another plan asks the host to switch after the first snapshot', async () => {
    const calls = installFetch(() => jsonOk(snapshot))
    const withPlans = makeSnapshot({ ...repo, plans: [{ id: 'p', current: true }, { id: 'p2' }] as never })
    localStorage.setItem('crewboard:repo', ROOT)
    localStorage.setItem(`crewboard:route:${ROOT}`, formatRoute({ repo: ROOT, plan: 'p2', view: 'work' }))
    resetOrchestraStore()
    orchestraStore.startRouting()
    render(<Probe />)
    await act(async () => { FakeEventSource.last?.emit('snapshot', withPlans) })
    await act(async () => {})
    expect(calls.filter((call) => call.url.endsWith('/plan-use')).map((call) => call.body)).toEqual([{ repo: ROOT, plan: 'p2' }])
    // Further frames on the old plan wait for the switch instead of asking again.
    await act(async () => { FakeEventSource.last?.emit('snapshot', withPlans) })
    await act(async () => {})
    expect(calls.filter((call) => call.url.endsWith('/plan-use'))).toHaveLength(1)
  })
})

describe('the snapshot always reaches the screen', () => {
  it('a subscriber that throws does not keep the screen from the snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = orchestraStore.subscribe(() => { throw new Error('bad subscriber') })
    render(<Probe />)
    await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
    expect(probe()).toContain('цель плана')
    stop()
  })

  it('a frame that is not JSON is skipped and told once; the next frame shows', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    installFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'offline' }), text: async () => '' }))
    render(<Probe />)
    const source = FakeEventSource.last!
    await act(async () => { for (let i = 0; i < 5; i++) for (const fn of source.listeners.get('snapshot') ?? []) fn({ data: '{broken' }) })
    expect(probe()).toContain('нет плана')
    await act(async () => { source.emit('snapshot', snapshot) })
    expect(probe()).toContain('цель плана')
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('a route to a missing repository while the chosen one is held does not recurse', async () => {
    orchestraStore.setRepo(ROOT)
    render(<Probe />)
    await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
    await act(async () => { FakeEventSource.last?.emit('snapshot', makeSnapshot(makeRepo([], [], { root: '/other', goal: 'другой' }))) })
    expect(() => act(() => orchestraStore.applyRoute({ repo: '/missing', plan: '_', view: 'graph' }))).not.toThrow()
    expect(orchestraStore.getState().repoRoot).toBe(ROOT)
    expect(probe()).toContain('цель плана')
  })
})

describe('no snapshot on a live connection', () => {
  beforeEach(() => setLang('en'))

  it('shows what is happening and resets Crewboard storage only', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    installFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'offline' }), text: async () => '' }))
    localStorage.setItem('crewboard:repo', '/gone')
    localStorage.setItem('dsh-orchestra:view:/gone', 'work')
    localStorage.setItem('dsh:theme', 'dark')
    render(<App />)
    expect(screen.getByText(t('panel.app.loading'))).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(STALL_MS) })
    expect(screen.getByRole('alert').textContent).toContain(t('panel.app.stalled'))
    fireEvent.click(screen.getByRole('button', { name: t('panel.app.resetState') }))
    expect(localStorage.getItem('crewboard:repo')).toBeNull()
    expect(localStorage.getItem('dsh-orchestra:view:/gone')).toBeNull()
    expect(localStorage.getItem('dsh:theme')).toBe('dark')
    expect(FakeEventSource.opened).toBe(2)
    expect(screen.getByText(t('panel.app.loading'))).toBeTruthy()
    await act(async () => { FakeEventSource.last?.emit('snapshot', snapshot) })
    expect(screen.queryByText(t('panel.app.loading'))).toBeNull()
    expect(screen.queryByRole('button', { name: t('panel.app.resetState') })).toBeNull()
  })

  it('keeps «Loading plans…» while the connection is reconnecting', async () => {
    vi.useFakeTimers()
    installFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'offline' }), text: async () => '' }))
    render(<App />)
    await act(async () => { FakeEventSource.last?.onerror?.() })
    await act(async () => { vi.advanceTimersByTime(STALL_MS * 2) })
    expect(screen.getByText(t('panel.app.loading'))).toBeTruthy()
  })

  it('offers the reset in both languages', () => {
    setLang('ru')
    expect(t('panel.app.resetState')).toBe('Сбросить состояние экрана')
    setLang('en')
    expect(t('panel.app.resetState')).toBe('Reset screen state')
  })
})

describe('fold choices with corrupted storage', () => {
  it('side folds keep only yes/no choices', async () => {
    const { readSideFolds } = await import('../../src/client/sidebar-model.js')
    for (const raw of ['null', '[true]', '7', '{broken']) {
      localStorage.setItem('crewboard:side-folds', raw)
      expect(readSideFolds()).toEqual({})
    }
    localStorage.setItem('crewboard:side-folds', JSON.stringify({ a: 'yes', b: false, c: true }))
    expect(readSideFolds()).toEqual({ b: false, c: true })
  })

  it('a lane fold is read and saved over a stored null', async () => {
    const { readManualFolds, writeManualFold } = await import('../../src/client/fold.js')
    const key = `crewboard:fold:${ROOT}:p`
    localStorage.setItem(key, 'null')
    expect(readManualFolds(repo)).toEqual({})
    localStorage.setItem(key, JSON.stringify({ implement: { folded: true } }))
    expect(readManualFolds(repo)).toEqual({})
    localStorage.setItem(key, 'null')
    writeManualFold(repo, 'implement', true)
    expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toHaveProperty('implement.folded', true)
  })
})
