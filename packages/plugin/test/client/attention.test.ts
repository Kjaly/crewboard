// @vitest-environment jsdom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attention } from '../../src/shared/types.js'
import {
  REVIEW_GROUP_MS,
  type ReviewItem,
  createAttentionEffects,
  createBrowserNotifier,
  createFaviconController,
  createPresenceReporter,
  createTitleController,
  notifySettings,
  requestNotifyPermission,
  resetNotifySettings,
  setNotifyMode,
} from '../../src/client/attention.js'
import { createReviewCenter } from '../../src/client/notify.js'
import { makeRepo, makeSnapshot } from './helpers.js'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let visibility: 'visible' | 'hidden' = 'visible'

interface FakeNotification {
  title: string
  options: NotificationOptions
  closed: boolean
  onclick: ((...args: unknown[]) => void) | null
  close(): void
}

function installNotification(permission: NotificationPermission = 'granted'): FakeNotification[] {
  const created: FakeNotification[] = []
  class Fake {
    static permission = permission
    static async requestPermission(): Promise<NotificationPermission> {
      return permission
    }
    closed = false
    onclick: ((...args: unknown[]) => void) | null = null
    constructor(
      public title: string,
      public options: NotificationOptions,
    ) {
      created.push(this as unknown as FakeNotification)
    }
    close(): void {
      this.closed = true
    }
  }
  Object.defineProperty(globalThis, 'Notification', { configurable: true, writable: true, value: Fake })
  return created
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  resetNotifySettings()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  document.head.innerHTML = '<title>DeepSeek Harness</title>'
})

afterEach(() => {
  resetNotifySettings()
  delete (globalThis as { Notification?: unknown }).Notification
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

/* ------------------------------------------------------------------ tab title */

describe('tab title count', () => {
  it('prefixes the count and restores the original title at zero', async () => {
    const title = createTitleController(document)
    title.set(0)
    expect(document.title).toBe('DeepSeek Harness')
    title.set(2)
    await flush()
    expect(document.title).toBe('(2) DeepSeek Harness')
    title.set(0)
    await flush()
    expect(document.title).toBe('DeepSeek Harness')
    title.dispose()
  })

  it('keeps the prefix on top of a title dsh rewrites, and never strips dsh text', async () => {
    const title = createTitleController(document)
    title.set(1)
    await flush()
    document.title = 'Chat'
    await flush()
    expect(document.title).toBe('(1) Chat')
    document.title = 'Docs'
    await flush()
    expect(document.title).toBe('(1) Docs')
    title.set(0)
    await flush()
    expect(document.title).toBe('Docs')

    // A title that merely looks like our prefix is dsh's own once the count is zero.
    document.title = '(2) Not ours'
    await flush()
    expect(document.title).toBe('(2) Not ours')
    title.dispose()
  })

  it('creates the title node when the shell mounts without one', () => {
    document.head.innerHTML = ''
    const title = createTitleController(document)
    title.set(2)
    // `document.title` strips trailing whitespace; the node keeps the space before dsh's text.
    expect(document.querySelector('title')?.textContent).toBe('(2) ')
    title.set(0)
    expect(document.querySelector('title')?.textContent).toBe('')
    title.dispose()
  })

  it('counts failed runs in the review centre state', () => {
    const failed: Attention = { kind: 'failed', severity: 'alert', taskId: 'x', runId: 'r', message: 'boom' }
    const center = createReviewCenter()
    act(() => center.feed(makeSnapshot(makeRepo([], [failed]))))
    expect(center.getState().failed).toBe(1)
  })
})

/* -------------------------------------------------------------------- favicon */

type FaviconLog = unknown[]

function fakeCanvas(log: FaviconLog) {
  const ctx = {
    fillStyle: '',
    drawImage: (...args: unknown[]) => log.push(['drawImage', ...args]),
    beginPath: () => log.push('beginPath'),
    arc: (...args: unknown[]) => log.push(['arc', ...args]),
    fill: () => log.push(['fill', ctx.fillStyle]),
  }
  return { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,DOT' }
}

const iconCount = () => document.querySelectorAll('link[rel~="icon"]').length
const ourIcon = () => document.querySelector('link[data-orchestra-favicon]')

describe('favicon dot', () => {
  it('draws over the original and removes only its own link when cleared', async () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">'
    const log: FaviconLog = []
    const favicon = createFaviconController({
      document,
      createCanvas: () => fakeCanvas(log) as unknown as HTMLCanvasElement,
      load: async (href) => {
        log.push(['load', href])
        return {} as CanvasImageSource
      },
      colors: { warning: '#warn', danger: '#danger' },
    })
    favicon.set('warning')
    await flush()
    expect(ourIcon()?.getAttribute('href')).toBe('data:image/png;base64,DOT')
    expect(iconCount()).toBe(2)
    expect(document.querySelector('link[rel~="icon"]:not([data-orchestra-favicon])')?.getAttribute('href')).toBe('/favicon.svg')
    expect(log).toContainEqual(['load', '/favicon.svg'])
    expect(log).toContainEqual(['fill', '#warn'])

    favicon.set('none')
    await flush()
    expect(ourIcon()).toBeNull()
    expect(iconCount()).toBe(1)
    expect(document.querySelector('link[rel~="icon"]')?.getAttribute('href')).toBe('/favicon.svg')
    favicon.dispose()
  })

  it('redraws in the danger colour when a run fails', async () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">'
    const log: FaviconLog = []
    const favicon = createFaviconController({
      document,
      createCanvas: () => fakeCanvas(log) as unknown as HTMLCanvasElement,
      load: async () => ({}) as CanvasImageSource,
      colors: { warning: '#warn', danger: '#danger' },
    })
    favicon.set('warning')
    await flush()
    favicon.set('danger')
    await flush()
    expect(log).toContainEqual(['fill', '#danger'])
    favicon.dispose()
  })

  it('still publishes a dot when there is no favicon and no SVG can load', async () => {
    document.head.innerHTML = ''
    const log: FaviconLog = []
    const favicon = createFaviconController({
      document,
      createCanvas: () => fakeCanvas(log) as unknown as HTMLCanvasElement,
      load: async () => {
        throw new Error('unloadable svg')
      },
    })
    favicon.set('danger')
    await flush()
    expect(ourIcon()).not.toBeNull()
    expect(log.some((entry) => Array.isArray(entry) && entry[0] === 'load')).toBe(false)
    favicon.dispose()
  })

  it('stays the last icon when dsh adds a replacement link', async () => {
    document.head.innerHTML = '<link rel="icon" href="/a.svg">'
    const favicon = createFaviconController({
      document,
      createCanvas: () => fakeCanvas([]) as unknown as HTMLCanvasElement,
      load: async () => ({}) as CanvasImageSource,
    })
    favicon.set('warning')
    await flush()
    const replacement = document.createElement('link')
    replacement.setAttribute('rel', 'icon')
    replacement.setAttribute('href', '/b.svg')
    document.head.append(replacement)
    await flush()
    const icons = [...document.querySelectorAll('link[rel~="icon"]')]
    expect(icons.at(-1)).toBe(ourIcon())
    expect(replacement.isConnected).toBe(true)
    favicon.dispose()
  })
})

/* ------------------------------------------------------ browser notifications */

function item(id: string, planId?: string): ReviewItem {
  return { key: `k-${id}`, root: '/repo', ...(planId ? { planId } : {}), taskId: id, title: `Task ${id}`, count: 1 }
}

function notifierFor() {
  const shown = installNotification('granted')
  resetNotifySettings()
  setNotifyMode('browser')
  let clock = 0
  const opened: ReviewItem[] = []
  const notifier = createBrowserNotifier({
    document,
    now: () => clock,
    open: (value) => opened.push(value),
  })
  return { notifier, shown, opened, setClock: (value: number) => { clock = value } }
}

describe('browser notifications', () => {
  it('fires only while the tab is hidden', () => {
    const { notifier, shown } = notifierFor()
    visibility = 'visible'
    notifier.feed([item('t1')])
    expect(shown).toHaveLength(0)
    visibility = 'hidden'
    notifier.feed([item('t1')])
    expect(shown).toHaveLength(1)
    notifier.dispose()
  })

  it('groups arrivals in the window into one tag and one body', () => {
    visibility = 'hidden'
    const { notifier, shown } = notifierFor()
    notifier.feed([item('t1')])
    notifier.feed([item('t2')])
    expect(shown).toHaveLength(2)
    expect(shown[0]?.closed).toBe(true)
    expect(shown[0]?.options.tag).toBe(shown.at(-1)?.options.tag)
    expect(shown.at(-1)?.options.body).toContain('2 tasks are waiting for acceptance')
    notifier.dispose()
  })

  it('starts a fresh notification after the window elapses', () => {
    visibility = 'hidden'
    const { notifier, shown, setClock } = notifierFor()
    notifier.feed([item('t1')])
    setClock(REVIEW_GROUP_MS + 1)
    notifier.feed([item('t2')])
    expect(shown).toHaveLength(2)
    expect(shown.at(-1)?.options.body).toContain('t2')
    notifier.dispose()
  })

  it('uses one shared tag across two tabs so the second replaces the first', () => {
    visibility = 'hidden'
    const first = notifierFor()
    first.notifier.feed([item('t1')])
    const firstTag = first.shown[0]?.options.tag
    const second = notifierFor()
    second.notifier.feed([item('t1')])
    expect(first.shown).toHaveLength(1)
    expect(second.shown).toHaveLength(1)
    expect(second.shown[0]?.options.tag).toBe(firstTag)
    first.notifier.dispose()
    second.notifier.dispose()
  })

  it('opens the item on click', () => {
    visibility = 'hidden'
    const { notifier, shown, opened } = notifierFor()
    notifier.feed([item('t1')])
    shown[0]?.onclick?.()
    expect(opened).toEqual([item('t1')])
    notifier.dispose()
  })
})

/* ------------------------------------------------------------- host presence */

describe('host presence heartbeat', () => {
  it('beats while enabled and retires the client on disable', () => {
    vi.useFakeTimers()
    try {
      const beats: boolean[] = []
      const reporter = createPresenceReporter({ post: (value) => beats.push(value), intervalMs: 1000 })
      reporter.setEnabled(true)
      expect(beats).toEqual([true])
      vi.advanceTimersByTime(2500)
      expect(beats).toEqual([true, true, true])
      reporter.setEnabled(false)
      expect(beats.at(-1)).toBe(false)
      reporter.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not beat in the macOS or off channel', () => {
    installNotification('granted')
    resetNotifySettings()
    const beats: boolean[] = []
    const effects = createAttentionEffects({
      document,
      open: () => {},
      postPresence: (value) => beats.push(value),
      presenceIntervalMs: 1_000_000,
      favicon: { createCanvas: () => undefined },
    })
    expect(beats).toEqual([true])
    setNotifyMode('mac')
    expect(beats.at(-1)).toBe(false)
    setNotifyMode('off')
    expect(beats.at(-1)).toBe(true)
    effects.dispose()
  })
})

/* ------------------------------------------------------------------ settings */

describe('notification settings', () => {
  it('defaults to browser when permission is granted and macOS otherwise', () => {
    installNotification('granted')
    resetNotifySettings()
    expect(notifySettings()).toEqual({ mode: 'browser', permission: 'granted' })
    installNotification('default')
    resetNotifySettings()
    expect(notifySettings()).toEqual({ mode: 'mac', permission: 'default' })
    installNotification('denied')
    resetNotifySettings()
    expect(notifySettings()).toEqual({ mode: 'mac', permission: 'denied' })
  })

  it('reflects a denial after an explicit request', async () => {
    let permission: NotificationPermission = 'default'
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: {
        get permission() {
          return permission
        },
        async requestPermission() {
          permission = 'denied'
          return permission
        },
      },
    })
    resetNotifySettings()
    setNotifyMode('browser')
    const state = await requestNotifyPermission()
    expect(state).toEqual({ mode: 'browser', permission: 'denied' })
  })
})
