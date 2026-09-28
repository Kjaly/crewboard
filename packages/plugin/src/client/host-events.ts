// The tab's one Crewboard stream (/crewboard/api/events). A browser keeps at most 6 HTTP/1.1 connections per host
// across ALL its tabs, and every dsh tab already holds streams of its own (/plugins/events, other plugins): a
// Crewboard stream opened at boot and kept for the tab's life let two dsh tabs use up the slots, and a third tab
// stayed blank with every request pending (measured 2026-09-25).
//
// Holders (`subscribe`) keep the stream open: the screen and the right-pane tab, through the store. It opens with
// the first holder and closes with the last one. While the tab is hidden for HIDDEN_CLOSE_MS it is closed too and
// opens again on return; the host sends a full snapshot as the first frame of every connection, so a reopened
// stream resyncs by itself. Watchers (`watch`) only hear what flows while someone else holds it — the review
// centre does, and polls /state on its own while the stream is not live.
import { API_PREFIX } from '../shared/types.js'

export const HIDDEN_CLOSE_MS = 30_000

/** `paused`: holders are there, the tab is hidden and the stream is closed until it shows again. */
export type HostLink = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'paused'
/** A frame that is not JSON reaches the handlers as `ok: false`: the store reports it, others skip it. */
export type HostFrame = { ok: true; data: unknown } | { ok: false; error: unknown }
export type FrameHandler = (frame: HostFrame) => void

const parse = (event: Event): HostFrame => {
  try {
    return { ok: true, data: JSON.parse((event as MessageEvent<string>).data) as unknown }
  } catch (error) {
    return { ok: false, error }
  }
}

export function createHostEvents(url = `${API_PREFIX}/events`) {
  const holders = new Map<string, Set<FrameHandler>>()
  const watchers = new Map<string, Set<FrameHandler>>()
  const linkListeners = new Set<(link: HostLink) => void>()
  let source: EventSource | null = null
  /** Event types a listener is attached for on the current `source`. */
  let attached = new Set<string>()
  let link: HostLink = 'idle'
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined
  let visibilityBound = false

  const held = () => {
    let n = 0
    for (const set of holders.values()) n += set.size
    return n
  }
  const setLink = (next: HostLink) => {
    if (next === link) return
    link = next
    for (const listener of [...linkListeners]) listener(next)
  }
  const deliver = (type: string, frame: HostFrame) => {
    for (const handler of [...(holders.get(type) ?? []), ...(watchers.get(type) ?? [])]) handler(frame)
  }
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

  const attach = (type: string) => {
    if (!source || attached.has(type)) return
    attached.add(type)
    source.addEventListener(type, (event) => deliver(type, parse(event)))
  }

  function openStream() {
    if (source || typeof EventSource === 'undefined') return
    setLink('connecting')
    const current = new EventSource(url)
    source = current
    current.onopen = () => {
      if (source === current) setLink('live')
    }
    // The browser retries on its own (the host asks for 2 s); the screen says «reconnecting» meanwhile.
    current.onerror = () => {
      if (source === current) setLink('reconnecting')
    }
    for (const type of new Set([...holders.keys(), ...watchers.keys()])) attach(type)
  }

  function closeStream() {
    source?.close()
    source = null
    attached = new Set()
  }

  function stop() {
    closeStream()
    clearTimeout(hiddenTimer)
    hiddenTimer = undefined
    setLink('idle')
  }

  function onVisibility() {
    if (held() === 0) return
    if (hidden()) {
      clearTimeout(hiddenTimer)
      hiddenTimer = setTimeout(() => {
        hiddenTimer = undefined
        closeStream()
        setLink('paused')
      }, HIDDEN_CLOSE_MS)
      return
    }
    clearTimeout(hiddenTimer)
    hiddenTimer = undefined
    openStream()
  }

  function start() {
    if (!visibilityBound && typeof document !== 'undefined') {
      visibilityBound = true
      document.addEventListener('visibilitychange', onVisibility)
    }
    if (hidden()) setLink('paused')
    else openStream()
  }

  const add = (map: Map<string, Set<FrameHandler>>, type: string, handler: FrameHandler) => {
    let set = map.get(type)
    if (!set) {
      set = new Set()
      map.set(type, set)
    }
    set.add(handler)
  }

  return {
    /** Holds the stream open and calls `handler` with each `type` frame; the returned function lets go. */
    subscribe(type: string, handler: FrameHandler): () => void {
      const wasIdle = held() === 0
      add(holders, type, handler)
      if (wasIdle) start()
      else attach(type)
      let active = true
      return () => {
        if (!active) return
        active = false
        holders.get(type)?.delete(handler)
        if (held() === 0) stop()
      }
    },
    /** Hears `type` frames while someone else holds the stream; never opens it. */
    watch(type: string, handler: FrameHandler): () => void {
      add(watchers, type, handler)
      attach(type)
      return () => {
        watchers.get(type)?.delete(handler)
      }
    },
    /** The link's state on every change. */
    onLink(listener: (link: HostLink) => void): () => void {
      linkListeners.add(listener)
      return () => {
        linkListeners.delete(listener)
      }
    },
    link: (): HostLink => link,
    /** Test seam: drops every holder and watcher and closes the stream. */
    reset(): void {
      holders.clear()
      watchers.clear()
      stop()
    },
  }
}

export type HostEvents = ReturnType<typeof createHostEvents>

/** The tab's hub. Only the main client imports it (store.ts, notify.tsx); screens reach it through the shared store. */
export const hostEvents = createHostEvents()
