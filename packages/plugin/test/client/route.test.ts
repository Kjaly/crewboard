// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouteController, formatRoute, parseRoute } from '../../src/client/route.js'

describe('orchestration hash route', () => {
  const route = { repo: 'my repo', plan: 'plan/one', view: 'review' as const, task: 'task #1', tab: 'changes', run: 'run 2' }
  it('round trips encoded route segments and query values', () => {
    expect(parseRoute(formatRoute(route))).toEqual(route)
    expect(parseRoute(formatRoute({ ...route, step: 'step:abc:1' }))).toEqual({ ...route, step: 'step:abc:1' })
  })
  it('rejects malformed and incomplete routes', () => {
    expect(parseRoute('#orchestra/%XX/p/graph')).toBeNull()
    expect(parseRoute('#orchestra/r/p/nope')).toEqual({ repo: 'r', plan: 'p', view: 'graph' })
    expect(parseRoute('#orchestra/r/p/graph?draft=d&run=r')).toBeNull()
    expect(parseRoute('#orchestra/r/p/graph?step=step%3A1')).toBeNull()
  })
  it('applies Back and clears only orchestration hashes on leave', () => {
    const win = window
    const apply = vi.fn()
    const onLeave = vi.fn()
    const controller = createRouteController({ read: () => route, apply, selectPanel: () => true, onLeave, window: win })
    const stop = controller.start()
    controller.write(route, 'push')
    win.location.hash = '#other'
    win.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(onLeave).toHaveBeenCalled()
    stop()
    win.history.replaceState(null, '', '/')
  })
  it('keeps trying to select the panel until it is registered', () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', formatRoute(route))
    const selectPanel = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
    const stop = createRouteController({ read: () => route, apply: vi.fn(), selectPanel, window }).start()
    vi.advanceTimersByTime(100)
    expect(selectPanel).toHaveBeenCalledTimes(3)
    stop()
    vi.useRealTimers()
  })
})

afterEach(() => { vi.useRealTimers(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks() })
