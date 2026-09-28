import type { TaskDetail } from '../../shared/types.js'

type Event = TaskDetail['events'][number]

/** How close to the end still counts as «following the feed». */
export const BOTTOM_THRESHOLD_PX = 24

/** A stable identity for one normalized event: time plus kind, never the mutable text. */
export function eventSignature(event: Pick<Event, 'kind' | 'ts'>): string {
  return `${event.kind}\u0000${event.ts}`
}

/**
 * Two events are the same line when kind and time agree and the text is equal or a prefix of the other —
 * `answer_delta` grows a message's text in place, and that is an update, not a new line.
 */
const compatible = (a: Event, b: Event): boolean =>
  a.kind === b.kind && a.ts === b.ts && (a.text === b.text || a.text.startsWith(b.text) || b.text.startsWith(a.text))

/**
 * How many leading events of `next` continue the tail of `prev`. `detail.events` is a bounded rolling tail
 * (`normalize(raw).slice(-MAX_EVENTS)` in core), so the array length alone cannot say what is new: after the
 * window fills, one event leaves as one arrives and the length stays put.
 */
export function overlapCount(prev: readonly Event[], next: readonly Event[]): number {
  const max = Math.min(prev.length, next.length)
  for (let k = max; k > 0; k--) {
    let ok = true
    for (let i = 0; i < k; i++) {
      const a = prev[prev.length - k + i]
      const b = next[i]
      if (!a || !b || !compatible(a, b)) {
        ok = false
        break
      }
    }
    if (ok) return k
  }
  return 0
}

export type KeyedGroup = { key: string; kind: string; signatures: string[] }

/**
 * Whether the newest retained public message grew since the previous window. Its `text` is clipped at 200
 * characters, so a long streaming answer looks identical there: only the bounded `display` can tell a reader
 * that there is more to follow. Once the source bound is reached (`truncated`), growth stops counting.
 */
export function streamGrew(prev: readonly Event[], next: readonly Event[]): boolean {
  const before = prev.at(-1)
  const after = next.at(-1)
  if (!before || !after || before.kind !== 'message' || after.kind !== 'message') return false
  if (before.truncated && after.truncated) return false
  const previousText = before.display ?? before.text
  const nextText = after.display ?? after.text
  return nextText.length > previousText.length && nextText.startsWith(previousText)
}

/**
 * Carry a group's React key across a rolling window. A group is matched to the previous one of the same kind
 * that still shares at least one event, so a group whose oldest events expired (or that just gained one)
 * keeps its identity and its open disclosure instead of remounting.
 */
export function stabilizeGroupKeys(
  prev: readonly KeyedGroup[],
  next: readonly { kind: string; events: Event[] }[],
  seqStart: number,
): { keys: string[]; state: KeyedGroup[]; seq: number } {
  let seq = seqStart
  const used = new Set<number>()
  const keys: string[] = []
  const state: KeyedGroup[] = []
  for (const group of next) {
    const signatures = group.events.map(eventSignature)
    let key: string | undefined
    for (let i = 0; i < prev.length; i++) {
      const candidate = prev[i]
      if (!candidate || used.has(i) || candidate.kind !== group.kind) continue
      if (candidate.signatures.some((signature) => signatures.includes(signature))) {
        key = candidate.key
        used.add(i)
        break
      }
    }
    if (!key) key = `g${seq++}`
    keys.push(key)
    state.push({ key, kind: group.kind, signatures })
  }
  return { keys, state, seq }
}
