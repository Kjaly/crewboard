/**
 * Which browser tabs currently say they will show browser notifications. The host keeps the macOS
 * fallback quiet while at least one such client is fresh; a client that disconnects or stops
 * heart-beating simply ages out, so no explicit goodbye is required (the client still sends one on
 * a clean stop, which retires it immediately).
 */
export type NotificationPresence = {
  /** One heartbeat from `id`; `at` is injectable so a test need not wait. */
  report(id: string, at?: number): void
  /** Explicit retirement — the client turned browser notifications off or unloaded. */
  clear(id: string): void
  /** True while at least one heartbeat is younger than the TTL. */
  active(now?: number): boolean
  size(now?: number): number
}

export const PRESENCE_TTL_MS = 30_000

export function createNotificationPresence(ttlMs = PRESENCE_TTL_MS): NotificationPresence {
  const clients = new Map<string, number>()
  const prune = (now: number) => {
    for (const [id, at] of clients) if (now - at > ttlMs) clients.delete(id)
  }
  return {
    report(id, at = Date.now()) {
      if (id) clients.set(id, at)
    },
    clear(id) {
      clients.delete(id)
    },
    active(now = Date.now()) {
      prune(now)
      return clients.size > 0
    },
    size(now = Date.now()) {
      prune(now)
      return clients.size
    },
  }
}
