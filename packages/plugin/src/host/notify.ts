import { type Attention, type NeedsYouReason, type NeedsYouReasons, NEEDS_YOU_REASONS, attentionReason, countsAsAttention, needsYou, reasonParts } from '@crewboard/core'
import type { OrchestraSnapshot } from '../shared/types.js'
import { hostT, type HostLang } from './i18n.js'

/** Arrivals inside one window become one notification — the client's toasts group by the same window. */
export const NOTIFY_GROUP_MS = 5000

/** What newly waits in one plan, by reason: the unit one line of a notification says. */
export type WaitingChange = { root: string; planId?: string; plan: string; reasons: Partial<NeedsYouReasons> }

/**
 * One plan's waiting signals: `news` (keyed by task and run) diffs against the previous snapshot only, `alarms`
 * (keyed by run and kind, filtered to what `countsAsAttention` calls a real alarm — st2, nt2) diff against every
 * alarm ever announced, so a command that keeps flickering in and out of «may be stuck» within the same run says
 * so once, not on every poll. `counts` sums background reviews and decisions.
 */
type PlanSignals = { root: string; planId?: string; plan: string; open: boolean; news: Map<string, NeedsYouReason>; alarms: Map<string, NeedsYouReason>; counts: Partial<NeedsYouReasons> }

// Accepted-but-unmerged work is the person's own last move, not news; everything else that waits is.
const NEWS: ReadonlySet<NeedsYouReason> = new Set(['review', 'checkOff', 'blocked', 'decision', 'failed'])

/** The real alarms of an attention list (st2, nt2): a command merely running, or a short quiet spell, never notifies. */
function alarmKeys(list: readonly Attention[]): Map<string, NeedsYouReason> {
  const out = new Map<string, NeedsYouReason>()
  for (const a of list) if (countsAsAttention(a)) out.set(`${a.runId}:${a.kind}`, attentionReason(a))
  return out
}

/**
 * The waiting work of a snapshot per plan, from the same `needsYou` rows as every count (at2). The open plan
 * names its tasks (a reworked task comes back with a new run and is news again); a background plan only sums
 * reviews and decisions, so those are compared by count. Run alarms are keyed everywhere by run and kind.
 */
function signalsOf(snapshot: OrchestraSnapshot): Map<string, PlanSignals> {
  const out = new Map<string, PlanSignals>()
  const plan = (root: string, planId: string | undefined, title: string, open: boolean) => {
    const key = `${root}\n${planId ?? ''}`
    const found: PlanSignals = out.get(key) ?? { root, ...(planId ? { planId } : {}), plan: title, open, news: new Map(), alarms: new Map(), counts: {} }
    out.set(key, found)
    return found
  }
  for (const repo of snapshot.repos) {
    if (repo.example) continue
    const runs = new Map(repo.tasks.map((task) => [task.id, task.lastRunId ?? '']))
    // Every live plan has an entry even while nothing waits there, so its first waiting work is news, not a baseline.
    if (!repo.archived) plan(repo.root, repo.planId, repo.goal, true)
    for (const summary of repo.plans ?? []) {
      if ((repo.planId ? summary.id === repo.planId : summary.current) || summary.archived || summary.example) continue
      plan(repo.root, summary.id, summary.goal, false)
    }
    // An archived plan, open or not, waits on nobody and stays silent (ny1): `needsYou` already leaves it out.
    for (const item of needsYou([repo])) {
      if (item.example) continue
      if (item.background) {
        const signals = plan(repo.root, item.planId, item.title, false)
        const background = repo.plans?.find((summary) => summary.id === item.planId)
        for (const [reason, count] of reasonParts(item.reasons ?? {})) if (reason !== 'failed' && NEWS.has(reason)) signals.counts[reason] = count
        for (const [key, reason] of alarmKeys(background?.attention ?? [])) signals.alarms.set(key, reason)
        continue
      }
      const signals = plan(repo.root, repo.planId, repo.goal, true)
      if (!item.reason || item.reason === 'failed' || !NEWS.has(item.reason)) continue
      signals.news.set(`${item.taskId}:${runs.get(item.taskId ?? '') ?? ''}`, item.reason)
    }
    if (!repo.archived && repo.attention.length) {
      const signals = plan(repo.root, repo.planId, repo.goal, true)
      for (const [key, reason] of alarmKeys(repo.attention)) signals.alarms.set(key, reason)
    }
  }
  return out
}

/**
 * What is new between two readings, per plan. A plan seen for the first time, or switched between open and
 * background, only sets a baseline. `announced` remembers every `runId:kind` already said (nt2): a run's alarm
 * that drops out for a snapshot or two and comes back — a command that stops being stuck, then gets stuck again —
 * is the same alarm, not a second one, until its run ends and the key never recurs.
 */
function changes(before: Map<string, PlanSignals>, after: Map<string, PlanSignals>, announced: Set<string>): WaitingChange[] {
  const out: WaitingChange[] = []
  for (const [key, now] of after) {
    const was = before.get(key)
    if (!was || was.open !== now.open) continue
    const reasons: Partial<NeedsYouReasons> = {}
    for (const [item, reason] of now.news) if (!was.news.has(item)) reasons[reason] = (reasons[reason] ?? 0) + 1
    for (const [item, reason] of now.alarms) {
      if (announced.has(item)) continue
      announced.add(item)
      reasons[reason] = (reasons[reason] ?? 0) + 1
    }
    for (const [reason, count] of reasonParts(now.counts)) {
      const grew = count - (was.counts[reason] ?? 0)
      if (grew > 0) reasons[reason] = (reasons[reason] ?? 0) + grew
    }
    if (NEEDS_YOU_REASONS.some((reason) => reasons[reason])) out.push({ root: now.root, ...(now.planId ? { planId: now.planId } : {}), plan: now.plan, reasons })
  }
  return out
}

/** «3 tasks wait for review · 1 decision» in the reader's language. */
export function reasonsLine(lang: HostLang, reasons: Partial<NeedsYouReasons>): string {
  const rules = new Intl.PluralRules(lang)
  return reasonParts(reasons)
    .map(([reason, count]) => {
      const key = `notify.reason.${reason}.${rules.select(count)}`
      const text = hostT(lang, key, { count })
      return text === key ? hostT(lang, `notify.reason.${reason}.other`, { count }) : text
    })
    .join(' · ')
}

/** Merges changes of the same plan, keeping the order plans first changed in. */
function merge(into: WaitingChange[], more: WaitingChange[]): WaitingChange[] {
  for (const change of more) {
    const same = into.find((item) => item.root === change.root && item.planId === change.planId)
    if (!same) {
      into.push({ ...change, reasons: { ...change.reasons } })
      continue
    }
    for (const [reason, count] of reasonParts(change.reasons)) same.reasons[reason] = (same.reasons[reason] ?? 0) + count
  }
  return into
}

export type WaitingNotifier = ((snapshot: OrchestraSnapshot) => WaitingChange[]) & {
  /** Say what gathered so far now, instead of at the end of the window. */
  flush(): void
  dispose(): void
}

export type WaitingNotifierOptions = {
  groupMs?: number
  /** Test seam: when to say what gathered; returns a cancel. */
  schedule?(fn: () => void, ms: number): () => void
}

/**
 * The macOS channel for work that waits on the person (at2, B28). The first snapshot is a baseline; later
 * snapshots add what newly waits, by plan and reason, and a window of `groupMs` gathers a burst into one
 * notification — «3 tasks wait for review · 1 decision in “Plan”», never one per task. `shouldNotify` is the
 * anti-double-notification gate: while a browser-notifying client is connected it returns false and the
 * gathered change is dropped, so nothing is replayed when the last client leaves. Returns each snapshot's
 * new changes, whether or not they are said.
 */
export function createAttentionNotifier(
  notify: (title: string, message: string) => unknown,
  language: () => HostLang = () => 'en',
  shouldNotify: () => boolean = () => true,
  options: WaitingNotifierOptions = {},
): WaitingNotifier {
  const groupMs = options.groupMs ?? NOTIFY_GROUP_MS
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  })
  let seen: Map<string, PlanSignals> | undefined
  let pending: WaitingChange[] = []
  let cancel: (() => void) | undefined
  // Every run alarm already said, by `runId:kind` (nt2): a run's own key never recurs once it ends, so this
  // only ever forgets by the process restarting, the same trade-off `chat.ts`'s waker makes.
  const announced = new Set<string>()

  const flush = () => {
    cancel?.()
    cancel = undefined
    const said = pending
    pending = []
    if (said.length === 0 || !shouldNotify()) return
    const lang = language()
    const body = said.map((change) => (change.plan ? hostT(lang, 'notify.inPlan', { summary: reasonsLine(lang, change.reasons), plan: change.plan }) : reasonsLine(lang, change.reasons))).join('; ')
    Promise.resolve(notify(hostT(lang, 'notify.waitingTitle'), body)).catch(() => {})
  }

  const feed = (snapshot: OrchestraSnapshot): WaitingChange[] => {
    const next = signalsOf(snapshot)
    const previous = seen
    seen = next
    if (!previous) {
      // The state a plan already has when the notifier starts watching is a baseline, alarms included:
      // its keys are marked announced so a later flicker of the same alarm does not say it for the first time.
      for (const signals of next.values()) for (const key of signals.alarms.keys()) announced.add(key)
      return []
    }
    const fresh = changes(previous, next, announced)
    if (fresh.length === 0) return fresh
    merge(pending, fresh)
    cancel ??= schedule(flush, groupMs)
    return fresh
  }
  return Object.assign(feed, {
    flush,
    dispose() {
      cancel?.()
      cancel = undefined
      pending = []
    },
  })
}
