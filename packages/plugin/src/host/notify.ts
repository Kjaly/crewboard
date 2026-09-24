import type { Attention } from '@crewboard/core'
import type { OrchestraSnapshot } from '../shared/types.js'
import { hostT, type HostLang } from './i18n.js'

const keyOf = (a: Attention) => `${a.runId}:${a.kind}`

/**
 * The first snapshot is a baseline; later snapshots notify once per newly appeared attention item.
 * `shouldNotify` is the anti-double-notification gate: while a browser-notifying client is
 * connected it returns false and the macOS fallback stays silent, though `seen` keeps advancing so
 * an item that arrived during the quiet period is not replayed when the last client leaves.
 */
export function createAttentionNotifier(
  notify: (title: string, message: string, kind?: string) => unknown,
  language: () => HostLang = () => 'en',
  shouldNotify: () => boolean = () => true,
): (s: OrchestraSnapshot) => Attention[] {
  let seen: Set<string> | undefined
  return (snapshot) => {
    // Background plans keep running, so their signals notify too.
    const current = snapshot.repos.flatMap((r) => [...r.attention, ...(r.plans ?? []).filter((p) => !p.current).flatMap((p) => p.attention)])
    const previous = seen
    seen = new Set(current.map(keyOf))
    if (!previous) return []
    const fresh = current.filter((a) => !previous.has(keyOf(a)))
    if (!shouldNotify()) return fresh
    for (const a of fresh) {
      const lang = language()
      const key = `notify.${a.kind}`
      const localized = hostT(lang, key) === key ? hostT(lang, 'notify.generic') : hostT(lang, key)
      Promise.resolve(notify(hostT(lang, 'notify.title', { task: a.taskId }), localized, a.kind)).catch(() => {})
    }
    return fresh
  }
}
