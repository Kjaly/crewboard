// @vitest-environment jsdom
// The tab's one Crewboard stream: nothing opens it at boot, it lives only while the screen holds it, and it
// closes after 30 s hidden. Two dsh tabs holding a stream each from boot used up Chromium's 6 connections per
// host and left a third tab blank (2026-09-25).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../../src/client/index.js'
import { createHostEvents, HIDDEN_CLOSE_MS, hostEvents } from '../../src/client/host-events.js'
import { resetReviewCenter } from '../../src/client/notify.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { FakeEventSource, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

let visibility: 'visible' | 'hidden' = 'visible'
const setVisibility = (next: 'visible' | 'hidden') => {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}
const created: FakeEventSource[] = []
const open = () => created.filter((source) => !source.closed)

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const Source = installEventSource()
  created.length = 0
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    writable: true,
    value: class extends Source {
      constructor(url: string) {
        super(url)
        created.push(this)
      }
    },
  })
  installFetch((url) => (url.endsWith('/state') ? jsonOk(makeSnapshot(makeRepo([makeTask({ id: 'a' })]))) : jsonOk(null)))
  resetOrchestraStore()
})
afterEach(() => {
  resetReviewCenter()
  resetOrchestraStore()
  hostEvents.reset()
  vi.useRealTimers()
})

it('boot opens no stream: the badge polls /state until a screen holds the stream', async () => {
  const slots = { inject: (_slot: string, fn: () => unknown) => fn(), register: () => () => {} }
  apply({ get: (name: string) => (name === 'slots' ? slots : undefined), inject: () => {} })
  await Promise.resolve()
  expect(FakeEventSource.opened).toBe(0)
  expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).endsWith('/state'))).toBe(true)

  // The screen and the right-pane tab share one stream; it closes when the last of them unmounts.
  const offScreen = orchestraStore.subscribe(() => {})
  const offPane = orchestraStore.subscribe(() => {})
  expect(open()).toHaveLength(1)
  offScreen()
  expect(open()).toHaveLength(1)
  offPane()
  expect(open()).toHaveLength(0)
  expect(hostEvents.link()).toBe('idle')
})

it('a watcher alone never opens the stream', () => {
  const hub = createHostEvents('/events')
  const frames: unknown[] = []
  const unwatch = hub.watch('snapshot', (frame) => frames.push(frame))
  expect(created).toHaveLength(0)
  const off = hub.subscribe('snapshot', () => {})
  created[0]?.emit('snapshot', { n: 1 })
  expect(frames).toEqual([{ ok: true, data: { n: 1 } }])
  off()
  expect(open()).toHaveLength(0)
  unwatch()
})

it('closes after 30 s hidden and reopens on return; the reopened stream resyncs the screen', async () => {
  vi.useFakeTimers()
  const off = orchestraStore.subscribe(() => {})
  expect(open()).toHaveLength(1)

  setVisibility('hidden')
  vi.advanceTimersByTime(HIDDEN_CLOSE_MS - 1)
  expect(open()).toHaveLength(1)
  // Back before 30 s: the stream stays as it is.
  setVisibility('visible')
  vi.advanceTimersByTime(HIDDEN_CLOSE_MS)
  expect(created).toHaveLength(1)
  expect(open()).toHaveLength(1)

  setVisibility('hidden')
  vi.advanceTimersByTime(HIDDEN_CLOSE_MS)
  expect(open()).toHaveLength(0)
  expect(hostEvents.link()).toBe('paused')

  setVisibility('visible')
  expect(open()).toHaveLength(1)
  const reopened = open()[0]
  reopened?.onopen?.()
  // The host's first frame on a connection is the full snapshot: what changed while hidden reaches the store.
  reopened?.emit('snapshot', makeSnapshot(makeRepo([makeTask({ id: 'a' }), makeTask({ id: 'b' })])))
  expect(orchestraStore.getState().snapshot?.repos[0]?.tasks.map((task) => task.id)).toEqual(['a', 'b'])
  expect(orchestraStore.getState().connection).toBe('live')
  off()
  expect(open()).toHaveLength(0)
})
