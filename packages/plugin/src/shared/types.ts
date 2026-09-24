import type { AgentTotals, Note, EffectiveRouting, GcCandidate, GcResult, PlanSummary, RepoFamily, RepoSnapshot, RepoSource, Routing, RunCost, SidebarOrder, TaskClass, WorktreePolicy } from '@crewboard/core'
import type { SplitSuggestion } from '@crewboard/core'
export { PROFILE_ALIASES, canonicalWorkerId } from '../../../core/src/routing/identity.js'

export type {
  AgentTotals,
  CheckSetting,
  CheckState,
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
}
export type { SidebarOrder }
/** Broken worker settings: the repositories are still served, the screen shows this as a banner (B07). */
export type WorkerSettingsIssue = { code: 'unreadable'; detail: string; path?: string } | { code: 'incomplete'; classes: TaskClass[]; path: string }
export type OrchestraSnapshot = { generatedAt: string; repos: OrchestraRepoSnapshot[]; workers: WorkerInfo[]; build?: string; order?: SidebarOrder; workerSettings?: WorkerSettingsIssue }

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
  billing: 'API' | 'подписка' | 'промо'
  main: boolean
  usedIn: Array<{ class: TaskClass; position: number }>
}

/** GET /api/workers: the routing document, class labels, and the workers the settings editor shows. */
export type WorkersInfo = { routing: Routing; classes: Array<{ id: TaskClass; label: string }>; known: string[]; workers: WorkerInfo[] }

export type WorktreesInfo = { candidates: GcCandidate[]; totalBytes: number; policy: WorktreePolicy }
export type WorktreeGcResult = GcResult
export type WorktreePolicyResult = { policy: WorktreePolicy }
export type AcceptResult = { task: string; status: 'accepted'; worktreeRemoved: boolean }
