import type { AgentTotals, Note, EffectiveRouting, GcCandidate, GcResult, PlanProgressRef, PlanSummary, RepoFamily, RepoSnapshot, RepoSource, Routing, RunCost, SidebarOrder, TaskClass, WorktreePolicy, OrchestratorUsage } from '@crewboard/core'
import type { SplitSuggestion } from '@crewboard/core'
import type { OtherReason, SubscriptionCli, Transport, WorkerSection } from '@crewboard/core'
export { PROFILE_ALIASES, canonicalWorkerId } from '../../../core/src/routing/identity.js'
export { entryEffort, workerLabel } from '../../../core/src/routing/effort.js'

export type { OtherReason, SubscriptionCli, Transport, WorkerSection }
export type {
  AgentTotals,
  CheckSetting,
  CheckState,
  DefaultBaseSetting,
  Attention,
  EffectiveRouting,
  WorkerPreset,
  RepoFamily,
  RepoSnapshot,
  Routing,
  Run,
  RunCost,
  Span,
  TaskClass,
  TaskDetail,
  TaskSnapshot,
  Trajectory,
  LedgerRecord,
  RunStepSummary,
  VerdictFact,
  ViewStatus,
  PlanProgress,
  PlanProgressRef,
  PlanProgressStage,
} from '@crewboard/core'

/** Plugin id: the sidebar list id, the main panel key and the client bundle id. */
export const PANEL_ID = 'crewboard'
export const API_PREFIX = '/crewboard/api'

/** The plan's chat, when the host has bound one. Added by the plugin, so core's `PlanSummary` stays untouched. */
export type PlanChat = { sessionId: string; wake: boolean }
export type OrchestraPlanSummary = PlanSummary & { chat?: PlanChat; suggestion?: SplitSuggestion; effectiveRouting?: EffectiveRouting }
export type OrchestraRepoSnapshot = Omit<RepoSnapshot, 'plans'> & {
  plans?: OrchestraPlanSummary[]
  effectiveRouting?: EffectiveRouting
  /** The main worktree this repository belongs to; absent when the host did not resolve it. */
  family?: RepoFamily
  /** Sidebar flags persisted in the orchestra profile store. Absent means false. */
  pinned?: boolean
  hidden?: boolean
  /** Where the host learned about this folder; «Remove from list» works only for `crewboard`. */
  sources?: RepoSource[]
  /** Set for a worktree found under a listed repository: the main checkout it belongs to. */
  worktreeOf?: string
  /** The listed folder does not exist any more; the snapshot carries nothing else. */
  missing?: boolean
  /**
   * How many times the host has refreshed this repository. It moves even when no plan revision does — a run's
   * evidence, a receipt or the Git state can change without a plan write — so it is the authoritative token the
   * client uses to invalidate an on-demand plan snapshot.
   */
  generation?: number
}
export type { SidebarOrder }
/** Broken worker settings: the repositories are still served, the screen shows this as a banner (B07). */
export type WorkerSettingsIssue = { code: 'unreadable'; detail: string; path?: string } | { code: 'incomplete'; classes: TaskClass[]; path: string }

/**
 * The global «Now» projection: one flat, lightweight list of the current work of every served plan, assembled
 * by the host from the per-plan progress the snapshot pass already derives (`PlanSummary.progress`). The screen
 * renders it directly — it never scans roots itself. `coverage` says how complete the list is: `known` when every
 * served, non-excluded plan was read; `unknown` when at least one read failed (so an empty list is never a claim
 * that nothing is happening); `partial` when some repositories have only their first paint so far. `unknown`
 * names the plan reads that failed. `items` are ordered by repository then plan (stable across polls).
 */
export type OrchestraNow = {
  coverage: 'known' | 'unknown' | 'partial'
  items: PlanProgressRef[]
  unknown: Array<{ root: string; planId: string }>
}

export type OrchestraSnapshot = { generatedAt: string; repos: OrchestraRepoSnapshot[]; workers: WorkerInfo[]; build?: string; order?: SidebarOrder; workerSettings?: WorkerSettingsIssue; now?: OrchestraNow }

/**
 * GET /api/plan-state?repo=<root>&plan=<planId> — the full snapshot of one explicitly named plan, built
 * read-only (no reconciliation write, no current-plan pointer change) and cached by the service until that
 * plan's revision moves. Omitted `plan` keeps the legacy current-plan behavior.
 */
export type PlanState = OrchestraRepoSnapshot

/**
 * A run's cost with the plan coordinates the timeline and review screens need: which task it
 * belongs to and when it actually ran. `RunCost` alone carries neither.
 */
export type PlanRunCost = RunCost & {
  taskId: string
  taskTitle: string
  startedAt: string
  finishedAt?: string
  outcome?: 'completed' | 'failed' | 'cancelled' | 'incomplete'
  terminalProvenance?: 'plan' | 'backend'
  attemptIndex?: number
  attemptParentRunId?: string
  attemptTrigger?: 'initial' | 'human_relaunch' | 'automatic_retry' | 'unknown'
  /** Who picked the worker of this attempt: the preset's order, a person (hand-picked) or an agent inside the preset. */
  workerChoice?: 'preset' | 'person' | 'agent'
  overview?: Array<{ lane: 'input' | 'model' | 'tools' | 'problem'; label: string; start: number }>
}

/** How many runs a measure could apply to, how many actually carry it, and when the latest of them ended. */
export type MeasureCoverage = { known: number; eligible: number; pending: number; lastRunAt?: string }
/** Coverage of every Review measure. Zero `known` means «not observed», never a measured zero. */
export type ReviewCoverage = {
  cash: MeasureCoverage
  apiEquivalent: MeasureCoverage
  quota: MeasureCoverage & { samples: number }
  worker: { measured: number; runs: number; firstRunAt?: string; lastRunAt?: string }
  reviewWait: { complete: boolean }
}

/** GET /api/cost. `accepted` carries the moment a human closed a task — the end of «ждёт приёмки». */
export type PlanCost = {
  schemaVersion?: 2
  /** Example-plan fixture data: shown for learning, never added to real spending. */
  synthetic?: true
  planId?: string
  rev?: number
  historyCompleteness?: 'complete' | 'partial' | 'unknown'
  generatedAt: string
  runs: PlanRunCost[]
  totals: Record<string, AgentTotals>
  accepted: Array<{ taskId: string; at: string }>
  tasks?: TaskReviewSummary[]
  coverage?: ReviewCoverage
  accountingByKindAndWindow?: Array<{ kind: 'cash' | 'apiEquivalent' | 'quota'; key: string; value: number; coverage: { known: number; eligible: number; pending: number } }>
  /** Separate dsh chat usage. Session lifetime scope; never included in worker totals. */
  orchestrator?: OrchestratorUsage
}

export type TaskReviewSummary = { taskId: string; title: string; taskClass?: TaskClass; currentClassFallback?: boolean; state: string; runIds: string[]; attemptIndexes: number[]; elapsedSec?: number; workerSec: number; reviewWaitMs: number; reviewIntervals: Array<{ id: string; from: string; to?: string; runId?: string; decisionId?: string; association: string }>; executionOutcomes: Array<{ runId: string; outcome: string }>; decisions: Array<{ id?: string; at: string; kind: string; verdict?: string; check?: 'checked' | 'unchecked'; reason?: string }>; accounting: { cashUsd?: number; apiEquivalentUsd?: number; quotaMeasurements: number; knownRuns: number; cashEligibleRuns?: number; equivalentKnownRuns?: number; pendingRuns: number; unavailableRuns: number } }

export type TaskReviewDetail = { taskId: string; attempts: PlanRunCost[]; summary?: TaskReviewSummary; decisions: Array<Pick<Note, 'at' | 'type' | 'text' | 'verdict' | 'event' | 'check'> & { id?: string }>; reviewIntervals: Array<{ id: string; enteredAt: string; decidedAt?: string; runId?: string; decisionId?: string; association: string; decision?: string; reason?: string }>; synthetic?: true; generatedAt: string }

/**
 * Saved profiles that are the same models as a direct CLI backend (`claude/<model>`, `codex/<model>`).
 * The settings list folds them into the direct row instead of showing the same model twice —
 * the same mapping the task panel applies in `client/workers.ts` (`directWorker`).
 * `codex` is a saved alias for the current Codex flagship — gpt-6-astra.
 */

/**
 * One assignable worker in the «Оркестрация» settings list. `main` rows are shown by default;
 * the rest sit behind the «Ещё профили» disclosure. `usedIn[].position` is 1-based.
 */
export type WorkerInfo = {
  id: string
  label: string
  provider: 'DeepSeek' | 'Claude' | 'Codex' | 'Devin' | 'Другие'
  billing: 'API' | 'подписка' | 'промо' | 'другое'
  main: boolean
  usedIn: Array<{ class: TaskClass; position: number }>
  /**
   * A model dsh serves (pv1): its dsh provider (`providerName` is how dsh names it) and model. `missing`: dsh's
   * catalog no longer lists it, while a routing, a preset or a switch still names it. `builtin`: the model name of
   * crewboard's own default dsh route (wo1) — with no dsh models at all it is a waiting line, not a blocked row.
   */
  dsh?: { provider: string; providerName: string; model: string; missing?: true; builtin?: string }
  /**
   * wo1: where Settings → Workers lists it, decided by its transport (`placeWorkers`): a subscription CLI's
   * block (`cli`), dsh, or «Other / imported» (`other` says why; a duplicate names the copy that stays).
   */
  section?: WorkerSection
  cli?: SubscriptionCli
  /** wo2: `false` when Crewboard has no runner for its CLI — listed for reference, never offered in a picker. */
  runs?: false
  other?: OtherReason
  duplicateOf?: string
  transport?: Transport
  model?: string
  effort?: string
  /** The name without the effort: one row per model, its efforts as chips. */
  name?: string
}

/** GET /api/workers: the routing document, class labels, and the workers the settings editor shows. */
export type WorkersInfo = {
  routing: Routing
  classes: Array<{ id: TaskClass; label: string }>
  known: string[]
  workers: WorkerInfo[]
  /** wo2: the subscription CLIs Crewboard has a runner backend for (`cliRuns` in core); absent from an older host. */
  runnableClis?: SubscriptionCli[]
}

export type WorktreesInfo = { candidates: GcCandidate[]; totalBytes: number; policy: WorktreePolicy }
export type WorktreeGcResult = GcResult
export type WorktreePolicyResult = { policy: WorktreePolicy }
export type AcceptResult = { task: string; status: 'accepted'; worktreeRemoved: boolean }
