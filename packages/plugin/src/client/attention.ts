import { t } from './i18n.js'

/**
 * The browser-level attention channel that lives beside the in-app toasts: the tab-title count,
 * the favicon dot, and real browser notifications. It stays free of React and of the Orchestra
 * screen — the always-on review listener feeds it, so a closed screen still updates the tab — and
 * every piece fails soft when the browser offers nothing (no Notification, no canvas).
 */

/** Arrivals inside one window merge into a single toast/notification instead of a stack. */
export const REVIEW_GROUP_MS = 5000
export const REVIEW_AUTOHIDE_MS = 12_000

/** One waiting thing, as the toasts and the browser notification describe it. */
export type ReviewItem = {
  key: string
  root: string
  planId?: string
  taskId?: string
  /** Task title, or the background plan's goal for plan-level items. */
  title: string
  count: number
  /** Human-decision task — the toast asks for a decision, not an acceptance. */
  decision?: boolean
}

/** The text of one grouped notification; also the toast body, so the two never drift. */
export function toastText(items: ReviewItem[]): string {
  const first = items[0]
  if (items.length === 1 && first) {
    if (first.taskId)
      return first.decision
        ? t('notify.decision', { id: first.taskId, title: first.title })
        : t('notify.ready', { id: first.taskId, title: first.title })
    return t('notify.planWaiting', { title: first.title, count: first.count })
  }
  const total = items.reduce((n, i) => n + i.count, 0)
  return t('notify.waitingCount', { n: total })
}

/* ------------------------------------------------------------------ settings */

export type NotifyMode = 'browser' | 'mac' | 'off'
export type NotifyPermission = NotificationPermission | 'unsupported'
export type NotifySettingsState = { mode: NotifyMode; permission: NotifyPermission }

export const NOTIFY_MODE_KEY = 'crewboard:notify-mode'

/** `unsupported` is a first-class state: a shell without the Notification API can still say so. */
export function notifyPermission(): NotifyPermission {
  try {
    return typeof Notification === 'undefined' || typeof Notification.permission !== 'string' ? 'unsupported' : Notification.permission
  } catch {
    return 'unsupported'
  }
}

/** Default channel: browser once permission is already granted, otherwise the host's macOS fallback. */
export function readNotifyMode(permission: NotifyPermission = notifyPermission()): NotifyMode {
  const fallback: NotifyMode = permission === 'granted' ? 'browser' : 'mac'
  try {
    const raw = globalThis.localStorage?.getItem(NOTIFY_MODE_KEY)
    return raw === 'browser' || raw === 'mac' || raw === 'off' ? raw : fallback
  } catch {
    return fallback
  }
}

let notifyState: NotifySettingsState = { mode: 'mac', permission: 'unsupported' }
let notifyInitialized = false
const notifyListeners = new Set<() => void>()

function ensureNotifyState(): void {
  if (notifyInitialized) return
  notifyInitialized = true
  const permission = notifyPermission()
  notifyState = { permission, mode: readNotifyMode(permission) }
}

const emitNotify = () => {
  for (const fn of [...notifyListeners]) fn()
}

export function notifySettings(): NotifySettingsState {
  ensureNotifyState()
  return notifyState
}

export function subscribeNotifySettings(fn: () => void): () => void {
  ensureNotifyState()
  notifyListeners.add(fn)
  return () => {
    notifyListeners.delete(fn)
  }
}

export function setNotifyMode(mode: NotifyMode): void {
  ensureNotifyState()
  if (notifyState.mode === mode) return
  try {
    globalThis.localStorage?.setItem(NOTIFY_MODE_KEY, mode)
  } catch {
    /* storage is a convenience, never a requirement */
  }
  notifyState = { ...notifyState, mode }
  emitNotify()
}

/**
 * The only path that asks the browser for permission — an explicit click in the settings screen,
 * never a page load. Re-reads `Notification.permission` so a denial is reflected immediately.
 */
export async function requestNotifyPermission(): Promise<NotifySettingsState> {
  ensureNotifyState()
  if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return notifyState
  try {
    await Notification.requestPermission()
  } catch {
    /* the browser may refuse to answer; the permission read below is what we trust */
  }
  notifyState = { ...notifyState, permission: notifyPermission() }
  emitNotify()
  return notifyState
}

/** The settings control for browser notifications: switch channel, then ask (the ask is explicit). */
export function enableBrowserNotifications(): Promise<NotifySettingsState> {
  setNotifyMode('browser')
  return requestNotifyPermission()
}

/** Test seam: drop the memoised state and listeners between renders. */
export function resetNotifySettings(): void {
  notifyInitialized = false
  notifyState = { mode: 'mac', permission: 'unsupported' }
  notifyListeners.clear()
}

/* -------------------------------------------------------------- tab title */

const PREFIX = (count: number) => (count > 0 ? `(${count}) ` : '')

export type TitleController = { set(count: number): void; dispose(): void }

/**
 * Prefixes `(n) ` on top of whatever dsh puts in `<title>` and removes only that prefix. The title
 * node is observed, so dsh overwriting the title keeps our count instead of losing it; our own
 * writes are idempotent, which is what stops the observer from looping.
 */
export function createTitleController(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): TitleController {
  if (!doc) return { set: () => {}, dispose: () => {} }
  const node = (): HTMLTitleElement | undefined => {
    const found = doc.querySelector('title')
    if (found) return found
    if (!doc.head) return undefined
    const title = doc.createElement('title')
    doc.head.append(title)
    return title
  }
  let count = 0
  let applied = ''
  const render = () => {
    const el = node()
    if (!el) return
    const raw = el.textContent ?? ''
    const base = applied && raw.startsWith(applied) ? raw.slice(applied.length) : raw
    const next = `${PREFIX(count)}${base}`
    if (next !== raw) el.textContent = next
    applied = PREFIX(count)
  }
  let observer: MutationObserver | undefined
  const el = node()
  if (el && doc.head && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(render)
    observer.observe(doc.head, { childList: true, subtree: true, characterData: true })
  }
  return {
    set(next) {
      count = next
      render()
    },
    dispose() {
      observer?.disconnect()
      observer = undefined
      if (applied) {
        const current = node()?.textContent ?? ''
        const target = node()
        if (target && current.startsWith(applied)) target.textContent = current.slice(applied.length)
        applied = ''
      }
    },
  }
}

/* --------------------------------------------------------------- favicon */

export type FaviconKind = 'none' | 'warning' | 'danger'
export type FaviconController = { set(kind: FaviconKind): void; dispose(): void }
export type FaviconDeps = {
  document?: Document
  /** Loads a favicon href into something drawable; a rejection means «draw the dot only». */
  load?(href: string): Promise<CanvasImageSource>
  createCanvas?(): HTMLCanvasElement | undefined
  colors?: { warning: string; danger: string }
  size?: number
}

const FAVICON_ATTR = 'data-orchestra-favicon'
const DEFAULT_COLORS = { warning: '#f59e0b', danger: '#f25a5a' }

function loadImage(href: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`cannot load ${href}`))
    img.src = href
  })
}

/**
 * Draws a small dot over dsh's own favicon and publishes the result as a data URL on our own
 * `<link rel="icon">` appended last, so the original links are never touched and restoring is
 * simply removing ours. A missing favicon or an unloadable SVG still yields the bare dot.
 */
export function createFaviconController(env: FaviconDeps = {}): FaviconController {
  const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined)
  if (!doc) return { set: () => {}, dispose: () => {} }
  const colors = env.colors ?? DEFAULT_COLORS
  const size = env.size ?? 32
  const load = env.load ?? loadImage
  const createCanvas = env.createCanvas ?? (() => doc.createElement('canvas'))
  let kind: FaviconKind = 'none'
  let drawn: FaviconKind = 'none'
  let ourLink: HTMLLinkElement | undefined
  let baseHref: string | undefined
  let url: string | undefined
  let generation = 0

  const isOurs = (el: Element) => el.getAttribute(FAVICON_ATTR) !== null
  const originalHref = (): string | undefined => {
    const links = [...doc.querySelectorAll('link[rel~="icon"]')].filter((l) => !isOurs(l))
    return links.at(-1)?.getAttribute('href') ?? undefined
  }
  const lastIcon = (): Element | undefined => [...doc.querySelectorAll('link[rel~="icon"]')].at(-1)

  const draw = async (href: string | undefined, next: 'warning' | 'danger'): Promise<string | undefined> => {
    const canvas = createCanvas()
    const ctx = canvas?.getContext?.('2d')
    if (!canvas || !ctx) return undefined
    canvas.width = size
    canvas.height = size
    if (href) {
      try {
        ctx.drawImage(await load(href), 0, 0, size, size)
      } catch {
        /* an unloadable SVG or a cross-origin icon: the dot alone still carries the signal */
      }
    }
    const radius = Math.max(3, Math.round(size * 0.17))
    const inset = Math.max(1, Math.round(size * 0.06))
    ctx.beginPath()
    ctx.arc(size - radius - inset, size - radius - inset, radius, 0, Math.PI * 2)
    ctx.fillStyle = next === 'danger' ? colors.danger : colors.warning
    ctx.fill()
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return undefined
    }
  }

  const ensureLink = (dataUrl: string) => {
    if (!ourLink) {
      ourLink = doc.createElement('link')
      ourLink.setAttribute('rel', 'icon')
      ourLink.setAttribute(FAVICON_ATTR, '')
    }
    if (ourLink.getAttribute('href') !== dataUrl) ourLink.setAttribute('href', dataUrl)
    // Last icon wins in every browser: appended again only when dsh added one after us.
    if (lastIcon() !== ourLink && doc.head) doc.head.append(ourLink)
  }

  const apply = (next: FaviconKind) => {
    if (next === 'none') {
      generation++
      ourLink?.remove()
      ourLink = undefined
      url = undefined
      baseHref = undefined
      drawn = 'none'
      return
    }
    const href = originalHref()
    const gen = ++generation
    if (ourLink && baseHref === href && drawn === next && url) {
      ensureLink(url)
      return
    }
    baseHref = href
    void draw(href, next).then((dataUrl) => {
      if (gen !== generation || !dataUrl) return
      url = dataUrl
      drawn = next
      ensureLink(dataUrl)
    })
  }

  const check = () => {
    if (kind === 'none') return
    if (!ourLink?.isConnected) {
      const href = originalHref()
      if (baseHref !== href) apply(kind)
      else if (url) ensureLink(url)
      return
    }
    if (lastIcon() !== ourLink) ensureLink(url ?? '')
  }

  let observer: MutationObserver | undefined
  if (doc.head && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(check)
    observer.observe(doc.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] })
  }

  return {
    set(next) {
      kind = next
      apply(next)
    },
    dispose() {
      observer?.disconnect()
      observer = undefined
      generation++
      ourLink?.remove()
      ourLink = undefined
      url = undefined
      baseHref = undefined
      drawn = 'none'
      kind = 'none'
    },
  }
}

/* ------------------------------------------------- browser notifications */

export type BrowserNotifierOptions = {
  document?: Document
  now?(): number
  open(item: ReviewItem): void
}

export type BrowserNotifier = { feed(items: ReviewItem[]): void; dispose(): void }

type NotifyGroup = { items: ReviewItem[]; startedAt: number; notification?: Notification }

const tagOf = (item: ReviewItem) => `crewboard:${item.root}:${item.planId ?? ''}`

/**
 * Shown only while the tab is hidden, one notification per plan (`tag`), so a second arrival
 * replaces the first instead of stacking and several dsh tabs collapse onto the same tag.
 */
export function createBrowserNotifier(opts: BrowserNotifierOptions): BrowserNotifier {
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : undefined)
  const now = opts.now ?? (() => Date.now())
  const groups = new Map<string, NotifyGroup>()

  const show = (tag: string, group: NotifyGroup) => {
    try {
      group.notification?.close()
    } catch {
      /* replacing a closed notification is best-effort */
    }
    let notification: Notification
    try {
      notification = new Notification('crewboard', { body: toastText(group.items), tag, renotify: true } as unknown as NotificationOptions)
    } catch {
      return
    }
    group.notification = notification
    notification.onclick = () => {
      try {
        window.focus()
      } catch {
        /* focus may be refused outside a gesture; opening the item still matters */
      }
      const target = [...group.items].reverse().find((i) => i.taskId) ?? group.items[0]
      if (target) opts.open(target)
      try {
        notification.close()
      } catch {
        /* closing after a click is best-effort */
      }
    }
  }

  return {
    feed(items) {
      if (doc?.visibilityState !== 'hidden') return
      const settings = notifySettings()
      if (settings.mode !== 'browser' || settings.permission !== 'granted') return
      const at = now()
      for (const [tag, group] of [...groups]) {
        if (at - group.startedAt <= REVIEW_GROUP_MS) continue
        try {
          group.notification?.close()
        } catch {
          /* expired groups are dropped regardless */
        }
        groups.delete(tag)
      }
      for (const item of items) {
        const tag = tagOf(item)
        const group = groups.get(tag)
        if (group) {
          group.items.push(item)
          show(tag, group)
        } else {
          const fresh: NotifyGroup = { items: [item], startedAt: at }
          groups.set(tag, fresh)
          show(tag, fresh)
        }
      }
    },
    dispose() {
      for (const group of groups.values()) {
        try {
          group.notification?.close()
        } catch {
          /* teardown is best-effort */
        }
      }
      groups.clear()
    },
  }
}

/* ---------------------------------------------------- host presence heartbeat */

export type PresenceReporter = { setEnabled(enabled: boolean): void; dispose(): void }

/**
 * Tells the host «a browser-notifying client is here» while it is true. A missed beat ages out on
 * the host, so a closed tab needs no goodbye; the explicit `false` just retires the client sooner.
 */
export function createPresenceReporter(opts: { post(enabled: boolean): void; intervalMs?: number }): PresenceReporter {
  const intervalMs = opts.intervalMs ?? 10_000
  const post = (value: boolean) => {
    try {
      opts.post(value)
    } catch {
      /* presence is an optimisation: a failed beat leaves the macOS fallback in charge */
    }
  }
  let enabled = false
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = (announce: boolean) => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (announce) post(false)
  }
  return {
    setEnabled(next) {
      if (next === enabled) return
      enabled = next
      if (next) {
        post(true)
        timer = setInterval(() => post(true), intervalMs)
      } else {
        stop(true)
      }
    },
    dispose() {
      stop(enabled)
      enabled = false
    },
  }
}

/* --------------------------------------------------------------- aggregate */

export type AttentionEffects = {
  /** `pending` includes failed runs; `fresh` are the just-arrived waiting items. */
  update(pending: number, failed: number, fresh: ReviewItem[]): void
  dispose(): void
}

export type AttentionOptions = {
  document?: Document
  open(item: ReviewItem): void
  postPresence?(enabled: boolean): void
  presenceIntervalMs?: number
  favicon?: Omit<FaviconDeps, 'document'>
}

function reportHost(settings: NotifySettingsState): boolean {
  // «off» silences the host too — otherwise turning notifications off would leave macOS firing.
  return settings.mode === 'off' || (settings.mode === 'browser' && settings.permission === 'granted')
}

/** Composes title, favicon, browser notifications and the host heartbeat under one dispose. */
export function createAttentionEffects(opts: AttentionOptions): AttentionEffects {
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : undefined)
  const title = createTitleController(doc)
  const favicon = createFaviconController({ document: doc, ...opts.favicon })
  const notifier = createBrowserNotifier({ document: doc, open: opts.open })
  const presence = createPresenceReporter({
    intervalMs: opts.presenceIntervalMs,
    post: (enabled) => opts.postPresence?.(enabled),
  })
  const applySettings = () => presence.setEnabled(reportHost(notifySettings()))
  const unsubscribe = subscribeNotifySettings(applySettings)
  applySettings()

  return {
    update(pending, failed, fresh) {
      title.set(pending)
      favicon.set(failed > 0 ? 'danger' : pending > 0 ? 'warning' : 'none')
      if (fresh.length > 0) notifier.feed(fresh)
    },
    dispose() {
      unsubscribe()
      notifier.dispose()
      favicon.dispose()
      title.dispose()
      presence.dispose()
    },
  }
}
