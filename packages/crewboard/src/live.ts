/** One journal append, as the screen hears about it. */
export type LiveChange = { project: string; goalId: string; seq: number }
export type Live = ReturnType<typeof createLive>

/** The fan-out from journal appends to every open screen stream. */
export function createLive() {
  const subscribers = new Set<(c: LiveChange) => void>()
  return {
    publish(c: LiveChange): void {
      for (const fn of subscribers) fn(c)
    },
    subscribe(fn: (c: LiveChange) => void): () => void {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
  }
}
