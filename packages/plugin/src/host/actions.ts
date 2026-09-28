import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Backends,
  BackendUnavailableError,
  ChecksError,
  runContractChecks,
  isSchemaError,
  ExamplePlanError,
  PlanArchivedError,
  PlanLockBusyError,
  stateFileError,
  PlanIncompatibleError,
  backendsForPlan,
  MAX_SPEC_BYTES,
  SPEC_EXTENSIONS,
  SPECS_DIR,
  SpecUploadError,
  saveUploadedSpec,
  createExamplePlan,
  removeExample,
  detectRecipe,
  loadRecipe,
  saveRecipe,
  DraftJobError,
  summarizeDraftJob,
  advanceDraftJobs,
  discardDraftJob,
  draftJobAnswer,
  loadDraftJob,
  repairDraftJob,
  startDraftJob,
  LegacyRunReadOnlyError,
  CLASS_LABEL,
  CLASS_LABEL_RU,
  DetailError,
  FilePreviewError,
  DEFAULT_WORKERS,
  type DshWorkspace,
  type Exec,
  LaunchError,
  chooseDraftWorker,
  MergeError,
  checkMarkMerged,
  checkMerge,
  markMerged,
  mergeTask,
  orchText,
  PlanConflictError,
  PlanIdError,
  type Routing,
  newTask,
  updatePlan,
  type GcResult,
  TASK_CLASSES,
  acceptTask,
  approveDraft,
  contractPathFor,
  contractTemplate,
  followUpContext,
  requiredChecks,
  writeNewContract,
  isBlocking,
  acceptTasks,
  buildTrajectory,
  buildLedger,
  pageLedger,
  ledgerCompleteness,
  runStepSummary,
  type RunStepSummary,
  type LedgerExtra,
  readEvidence,
  claudeProjectsDir,
  claudeProjectSlug,
  dshBillRecordsPath,
  orchestratorUsage,
  createPlan,
  checkDraft,
  currentPlanId,
  discardDraft,
  getTaskDetail,
  getTaskDiff,
  getTaskFile,
  gcAfterAccept,
  uncommittedCount,
  gcCandidates,
  gcRemove,
  KEEP_REASON,
  loadWorktreePolicy,
  saveWorktreePolicy,
  worktreeConfigPath,
  ensureGitExclude,
  initPlan,
  launchTask,
  runWorkerChoice,
  callerOf,
  loadPlan,
  loadDraft,
  listDrafts,
  loadProfileStore,
  backendForTransport,
  loadRouting,
  loadRegistry,
  registryPath,
  entryEffort,
  runEffort,
  workerLabel,
  cliKindOf,
  isDshAgent,
  saveWorker,
  saveWorkerProfile,
  removeWorker,
  recoverWorkerDeletion,
  listPresets,
  savePreset,
  deletePreset,
  setRepositoryPreset,
  setPlanPreset,
  setRepoPreference,
  setSidebarOrder,
  type SidebarOrder,
  resolveRouting,
  preflightAgent,
  resolveProfile,
  workerCommands,
  type Backend,
  mergeWorkspaces,
  folderKey,
  addRegisteredRepo,
  removeRegisteredRepo,
  resolveRepoPath,
  RepoPathError,
  newPlanId,
  nodeExec,
  planPath,
  profileStorePath,
  rejectTask,
  sendBackAndRerun,
  dropTask,
  relaunchTask,
  continueTask,
  renamePlan,
  runCost,
  saveRouting,
  openPlan,
  setPlanArchived,
  splitPlan,
  SplitError,
  loadPlan as loadStoredPlan,
  setTaskPositions,
  waitsForHuman,
  deriveViews,
  ownWorkUnchecked,
  reviewCheckOf,
  resolveOrchestratorCheck,
  resolveDefaultBase,
  setPlanDefaultBase,
  setRepositoryDefaultBase,
  setPlanOrchestratorCheck,
  setRepositoryOrchestratorCheck,
  steerTask,
  stopTask,
  summarizeCosts,
  usageForRun,
  verdictOf,
  cleanToAccept,
  type DshCatalog,
  DSH_DEFAULT_PROVIDER,
  dshSelectionOf,
  dshSelectionOfId,
  readDshCatalog,
  type Transport,
  placeWorkers,
  cliRuns,
  SUBSCRIPTION_CLIS,
  collectWorkerFacts,
  dshEntrySelection,
  billingOfTransport,
  adoptImportedProfile,
  forgetWorkerId,
  EFFORT_LEVELS,
  SubscriptionModelsError,
  addSubscriptionWorkers,
  isSubscriptionKind,
  listSubscriptionModels,
  subscriptionEntries,
  type WorkerPreset,
} from '@crewboard/core'
import { API_PREFIX, PROFILE_ALIASES, type PlanCost, type PlanRunCost, type WorkerInfo } from '../shared/types.js'
import { reviewCoverage } from '../shared/review-coverage.js'
import { ChatBindingError, type ChatDeps, bindChat, openChat, readChats, setWake, unbindChat } from './chat.js'
import type { Route, SessionControllerFace } from './dsh.js'
import type { Native } from './native.js'
import type { OrchestraService } from './service.js'
import { BILLING_OTHER, BILLING_PROMO, BILLING_SUBSCRIPTION, PROVIDER_OTHER, hostT, type HostLang } from './i18n.js'
import type { ReviewCheck, Verdict } from '@crewboard/core'

/** The accept dialog's one line on the orchestrator's check (vc1); a check's note is shortened to a clause. */
export function acceptCheckLine(lang: HostLang, check: ReviewCheck, task: string, note?: string): string {
  if (check.state === 'checked') return hostT(lang, 'check.accept.checked', { note: note ? ` — ${note.length > 120 ? `${note.slice(0, 119)}…` : note}` : '' })
  if (check.state === 'off') return hostT(lang, `check.accept.off.${check.source}`)
  return hostT(lang, 'check.accept.unchecked', { task })
}

function verdictReason(lang: HostLang, verdict: Verdict): string {
  return verdict.why || verdict.mismatch ? hostT(lang, `verdict.reason.${verdict.why ?? verdict.mismatch}`) : hostT(lang, 'actions.defaultMismatch')
}

/** Required on every POST: a custom header forces a CORS preflight, which this server never answers. */
export const CLIENT_HEADER = 'x-orchestra-client'
const completedReviewCosts = new Map<string, ReturnType<typeof runCost>>()
/** Step strips of finished runs, keyed by run and the mtime of its event log; a finished strip never changes. */
const finishedRunSteps = new Map<string, RunStepSummary>()
const RUN_STEPS_LIMIT = 100
const MAX_BODY_BYTES = 64 * 1024
/** A spec upload carries up to MAX_SPEC_BYTES of text plus JSON escaping. */
const MAX_SPEC_BODY_BYTES = MAX_SPEC_BYTES * 2 + 4096
const MAX_SPANS = 400

export type ActionsDeps = {
  service: OrchestraService
  repos: string[]
  /** dsh workspaces; together with `repos` they form the accepted repository list (deduplicated by path). */
  workspaces?(): DshWorkspace[]
  backendsFor(root: string): Backends
  native: Native
  env: NodeJS.ProcessEnv
  home: string
  now(): Date
  exec?: Exec
  /** The optional dsh session controller; absent means every `chat-*` route answers 503. */
  sessions?(): SessionControllerFace | undefined
  newId?(): string
  readTask?: ChatDeps['readTask']
  lang?: () => HostLang
}

type Body = Record<string, unknown>

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function unionReviewIntervals(intervals: Array<{ from: string; to?: string }>, snapshot: string): number {
  const sorted = intervals.map(i => [Date.parse(i.from), Date.parse(i.to ?? snapshot)] as const).filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a,b)=>a[0]-b[0])
  let total = 0, end = 0
  for (const [from,to] of sorted) { total += Math.max(0,to-Math.max(from,end)); end = Math.max(end,to) }
  return total
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  // A full, forbidden or read-only disk: one sentence with the path (sf1), not Node's errno text.
  const disk = stateFileError(err)
  if (disk) return new HttpError(disk.reason === 'no_space' ? 507 : 409, disk.code, disk.message)
  if (err instanceof PlanLockBusyError) return new HttpError(409, err.code, err.message)
  if (isSchemaError(err)) return new HttpError(400, 'bad_request', err.message)
  if (err instanceof ExamplePlanError) return new HttpError(409, err.code, err.message)
  if (err instanceof PlanArchivedError) return new HttpError(409, err.code, err.message)
  if (err instanceof PlanIncompatibleError) return new HttpError(409, err.code, err.message)
  if (err instanceof BackendUnavailableError) return new HttpError(409, err.code, err.message)
  if (err instanceof DraftJobError) return new HttpError(err.reason === 'not_found' ? 404 : err.reason === 'not_repairable' || err.reason === 'no_isolation' ? 409 : 400, err.reason, err.detail ? `${err.message}: ${err.detail}` : err.message)
  if (err instanceof LegacyRunReadOnlyError) return new HttpError(409, err.code, err.message)
  if (err instanceof ChatBindingError) return new HttpError(404, err.code, err.message)
  if (err instanceof LaunchError) {
    return new HttpError(err.code === 'unknown_task' ? 404 : 409, err.code, err.detail ? `${err.message}\n${err.detail}` : err.message)
  }
  if (err instanceof SpecUploadError) return new HttpError(err.code === 'too_large' ? 413 : err.code === 'unsupported_type' ? 415 : 400, err.code, err.message)
  if (err instanceof DetailError) return new HttpError(404, err.code, err.message)
  if (err instanceof ChecksError) return new HttpError(err.code === 'unknown_task' ? 404 : 409, `checks_${err.code}`, err.message)
  if (err instanceof SplitError) return new HttpError(400, err.code, err.message)
  if (err instanceof MergeError) return new HttpError(err.code === 'unknown_task' ? 404 : 409, err.code, err.message)
  if (err instanceof FilePreviewError) return new HttpError(err.code === 'too_large' ? 413 : 404, err.code, err.message)
  if (err instanceof PlanIdError) return new HttpError(400, 'bad_plan', err.message)
  if (err instanceof SubscriptionModelsError) return new HttpError(502, err.code, err.message)
  if (err instanceof RangeError) return new HttpError(400, 'bad_request', err.message)
  if (err instanceof TypeError) return new HttpError(400, 'bad_request', err.message)
  return new HttpError(500, 'internal', err instanceof Error ? err.message : String(err))
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Body> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'expected application/json')
  }
  if (req.headers[CLIENT_HEADER] !== '1') throw new HttpError(403, 'forbidden', `missing ${CLIENT_HEADER} header`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size > limit) throw new HttpError(413, 'too_large', 'body too large')
    chunks.push(buf)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_json', 'body must be JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'bad_json', 'body must be a JSON object')
  return value as Body
}

/** POST routes that take no served `repo`: they add a folder to the list or remove one from it. */
const LIST_ROUTES = new Set(['repo-add', 'repo-remove'])

const text = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'bad_request', `${field} is required`)
  return v
}

/** The provider mark of a worker, by the transport it runs on (wo1) — a dsh model of another provider is not DeepSeek's. */
const workerProvider = (id: string, transport: Transport | undefined, model?: string): WorkerInfo['provider'] => {
  if (transport === 'dsh') return ((model ? dshSelectionOf(model) : dshSelectionOfId(id))?.provider ?? DSH_DEFAULT_PROVIDER).startsWith('deepseek') ? 'DeepSeek' : PROVIDER_OTHER
  if (transport === 'claude-cli') return 'Claude'
  if (transport === 'codex-cli') return 'Codex'
  if (transport === 'devin-acp') return 'Devin'
  return PROVIDER_OTHER
}

/** Billing follows the transport (wo1): a subscription CLI, API through dsh, or — for an id nothing defines — other. */
const workerBilling = (transport: Transport | undefined): WorkerInfo['billing'] => {
  const billing = billingOfTransport(transport)
  if (billing === 'api-dsh' || billing === 'api-claude') return 'API'
  if (billing === 'other') return BILLING_OTHER
  return transport === 'devin-acp' ? BILLING_PROMO : BILLING_SUBSCRIPTION
}

/** The CLI an access check runs, by the block's name (wo1: every subscription CLI block has one). */
const CHECK_BACKEND: Record<string, Backend | undefined> = { claude: 'claude-code', codex: 'codex-cli', devin: 'devin-cli', dsh: 'dsh', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build' }

/** «Add models»: the backend whose `EFFORT_LEVELS` gate a kind's efforts; `undefined` takes none. */
const EFFORT_BACKEND: Record<string, Backend | undefined> = { claude: 'claude-code', codex: 'codex-cli', devin: undefined, opencode: 'opencode', cursor: undefined, gemini: undefined, grok: 'grok-build' }
const SUBSCRIPTION_KIND_LIST = 'claude, codex, devin, opencode, cursor, gemini or grok'

/** 1-based positions inside the routing classes; a saved alias counts towards its direct backend. */
const workerUsedIn = (routing: Routing, id: string): WorkerInfo['usedIn'] => {
  const usedIn: WorkerInfo['usedIn'] = []
  for (const cls of TASK_CLASSES) {
    routing.classes[cls].forEach((entry, i) => {
      if ((PROFILE_ALIASES[entry] ?? entry) === id) usedIn.push({ class: cls, position: i + 1 })
    })
  }
  return usedIn
}

/** Profile labels now live in the Orchestra store. */
async function profileLabels(env: NodeJS.ProcessEnv, home: string): Promise<Map<string, string>> {
  const store = await loadProfileStore(env, home)
  return new Map(Object.entries(store.profiles).filter(([id, profile]) => profile.displayName !== id).map(([id, profile]) => [id, profile.displayName]))
}

const ID_TOKEN: Record<string, string> = { api: 'API', cli: 'CLI', dsh: 'dsh', gpt: 'GPT', swe: 'SWE' }

/** Last resort when neither the profile store nor the direct table knows the id — never a bare id. */
const humanLabel = (id: string): string =>
  id
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((tok) => ID_TOKEN[tok.toLowerCase()] ?? tok.charAt(0).toUpperCase() + tok.slice(1))
    .join(' ')

/**
 * The settings list: direct backends, dsh's catalog, saved profiles and ids the lists name — saved aliases
 * folded into their direct row (PROFILE_ALIASES). Each lands in exactly one section by its transport
 * (wo1, `placeWorkers`): duplicates by transport, model and effort, an older tool's profile nothing uses and an
 * id nothing defines go to «Other / imported» and are `main: false`.
 */
type DescribeExtra = { catalog?: DshCatalog; presets?: WorkerPreset[]; lang?: HostLang }
type HostProfile = import('@crewboard/core').AgentProfile & { transport: Transport; origin?: string }

function describeWorkers(routing: Routing, profiles: HostProfile[], labels: Map<string, string>, direct: import('@crewboard/core').WorkerEntry[], extra: DescribeExtra = {}): WorkerInfo[] {
  // A worker a saved preset names is wired in too (pv1): it stays in the main list, and a gone dsh model shows as missing.
  const referenced = new Set([...Object.values(routing.classes).flat(), ...Object.keys(routing.disabled), ...(extra.presets ?? []).flatMap((preset) => Object.values(preset.routing).flat())])
  // Several saved profiles can fold onto one direct backend (`codex` and `codex-gpt-6-astra` both
  // mean gpt-6-astra); the surviving row takes the first alias label its aliases carry.
  const profileAliases = new Map<string, string[]>()
  for (const [alias, direct] of Object.entries(PROFILE_ALIASES)) {
    profileAliases.set(direct, [...(profileAliases.get(direct) ?? []), alias])
  }
  const labelFor = (id: string): string => {
    const registered = direct.find((worker) => worker.id === id)
    const builtIn = DEFAULT_WORKERS.find((worker) => worker.id === id)
    if (registered && registered.label !== builtIn?.label) return registered.label
    for (const alias of profileAliases.get(id) ?? []) {
      const label = labels.get(alias)
      if (label) return label
    }
    return labels.get(id) ?? registered?.label ?? humanLabel(id)
  }
  // The effort the worker runs with, resolved as a launch resolves it (resolveProfile): the registry entry,
  // else — for an id that is not a direct `claude/…`, `codex/…` or dsh worker — the saved profile (ef1).
  const effortFor = (id: string): string | undefined => {
    const registered = direct.find((worker) => worker.id === id)
    if (registered) return entryEffort(registered)
    if (isDshAgent(id) || cliKindOf(id)) return undefined
    const profile = profiles.find((item) => item.id === id)
    return profile ? runEffort(profile.backend, profile.effort) : undefined
  }
  const facts = collectWorkerFacts({
    registry: direct,
    profiles: profiles.map((profile) => ({ id: profile.id, transport: profile.transport, model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}), ...(profile.origin ? { origin: profile.origin } : {}) })),
    referenced,
    catalog: (extra.catalog?.groups ?? []).flatMap((group) => group.models.map((model) => ({ provider: group.id, model: model.id }))),
    aliases: PROFILE_ALIASES,
  })
  const workers = facts.map((item) => {
    const name = labelFor(item.id)
    const effort = item.transport ? runEffort(backendForTransport(item.transport), item.effort) : undefined
    return {
      id: item.id,
      // A catalog model is named by dsh (withDsh); everything else carries its effort in its name (ef1).
      label: item.catalog ? name : workerLabel(name, effortFor(item.id)),
      name,
      provider: workerProvider(item.id, item.transport, item.model),
      billing: workerBilling(item.transport),
      main: true,
      usedIn: workerUsedIn(routing, item.id),
      ...(item.transport ? { transport: item.transport } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(effort ? { effort } : {}),
      facts: item,
    }
  })
  const placed = placeWorkers(workers.map((worker) => worker.facts))
  return workers.map(({ facts: _facts, ...worker }) => {
    const place = placed.get(worker.id) ?? { section: 'other' as const, other: 'stale' as const }
    // wo2: a worker of a CLI Crewboard has no runner for is listed for reference, never offered in a picker.
    const runs = !place.cli || cliRuns(place.cli)
    return withDsh({ ...worker, main: place.section !== 'other' && runs, section: place.section, ...(place.cli ? { cli: place.cli } : {}), ...(runs ? {} : { runs: false as const }), ...(place.other ? { other: place.other } : {}), ...(place.duplicateOf ? { duplicateOf: place.duplicateOf } : {}) }, direct, extra)
  })
}

/**
 * Names a dsh worker after dsh's catalog — «DeepSeek V4 Flash · via dsh» — unless the owner renamed it, and marks
 * one the catalog no longer lists as missing. Without a catalog (an older dsh, or the CLI) nothing is claimed.
 */
function withDsh(worker: WorkerInfo, direct: import('@crewboard/core').WorkerEntry[], extra: DescribeExtra): WorkerInfo {
  const entry = direct.find((item) => item.id === worker.id)
  const selection = entry ? dshEntrySelection(entry) : dshSelectionOfId(worker.id)
  if (!selection) return worker
  const group = extra.catalog?.groups.find((item) => item.id === selection.provider)
  const model = group?.models.find((item) => item.id === selection.model)
  // A provider that failed to list its models says nothing about this one.
  const failed = extra.catalog?.failures.some((failure) => failure.id === selection.provider)
  const missing = Boolean(extra.catalog && !model && !failed)
  const builtIn = DEFAULT_WORKERS.find((item) => item.id === worker.id)
  const ownName = entry && entry.label !== builtIn?.label
  // Without a catalog name a registered entry keeps its own label rather than a bare model id.
  const label = ownName || (entry && !model) ? worker.label : hostT(extra.lang ?? 'en', 'workers.viaDsh', { model: model?.name ?? selection.model })
  return { ...worker, label, name: label, dsh: { provider: selection.provider, providerName: group?.name ?? extra.catalog?.failures.find((failure) => failure.id === selection.provider)?.name ?? selection.provider, model: selection.model, ...(missing ? { missing: true as const } : {}), ...(builtIn && !ownName ? { builtin: builtIn.label.replace(/ \(dsh\)$/, '') } : {}) } }
}

/** dsh's model catalog through its session controller (pv1); absent on a dsh without one, or when it fails. */
export async function dshCatalogOf(controller: SessionControllerFace | undefined): Promise<DshCatalog | undefined> {
  if (!controller?.modelCatalog) return undefined
  return readDshCatalog(await controller.modelCatalog().catch(() => undefined))
}

/** Resolve the same worker list for snapshots and the settings endpoint. */
export async function resolvedWorkers(env: NodeJS.ProcessEnv, home: string, extra: Omit<DescribeExtra, 'presets'> = {}): Promise<WorkerInfo[]> {
  const path = profileStorePath(env, home)
  const file = registryPath(env, home)
  await recoverWorkerDeletion(file, path)
  const store = await loadProfileStore(env, home)
  const profiles = Object.entries(store.profiles).map(([id, profile]) => ({ id, backend: backendForTransport(profile.transport), transport: profile.transport, model: profile.model, enabled: profile.enabled, ...(profile.effort ? { effort: profile.effort } : {}), ...(profile.origin ? { origin: profile.origin } : {}) }))
  const routing = await loadRouting(path, env, home)
  // A background snapshot must not create the default registry after host disposal.
  const direct = await readFile(file, 'utf8').then((raw) => {
    const registry = JSON.parse(raw) as import('@crewboard/core').WorkerRegistry
    if (registry.version !== 1 || !Array.isArray(registry.workers)) throw new TypeError('Invalid worker registry')
    return registry.workers
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return DEFAULT_WORKERS
    throw error
  })
  const presets = await listPresets({ ...env, HOME: home }).catch(() => [])
  return describeWorkers(routing, profiles, await profileLabels(env, home), direct, { ...extra, presets })
}

type PlanTask = Awaited<ReturnType<typeof loadPlan>>['tasks'][number]
/**
 * Ledger records that come from the plan rather than the run's event log: captured evidence, steers
 * and failures noted on the task, and the verdict. The trace and the Review strip share them, so a
 * run's strip and its ledger always count the same steps.
 */
async function runLedgerExtras(root: string, task: PlanTask, run: PlanTask['runs'][number]) {
  const evidence = await readEvidence(root, run.evidence)
  const nextRunAt = task.runs.find((item) => Date.parse(item.startedAt) > Date.parse(run.startedAt))?.startedAt
  const associatedIntervals = (task.reviewIntervals ?? []).filter((interval) => interval.runId === run.runId && interval.association !== 'task_only')
  const acceptedNote = task.notes.find((note) => note.type === 'accept' && associatedIntervals.some((interval) => interval.decidedAt === note.at))
  const steerNotes = task.notes.filter((note) => (note.type === 'steer' || (note.type === 'comment' && /^(failed|refused)\b/.test(note.text))) && Date.parse(note.at) >= Date.parse(run.startedAt) && (!nextRunAt || Date.parse(note.at) < Date.parse(nextRunAt)))
  const extras: LedgerExtra[] = evidence?.runId === run.runId ? [
    ...evidence.checks.map((check) => ({ at: evidence.capturedAt, kind: 'check' as const, label: check.command, state: check.state, isError: check.state === 'not_run', output: check.state })),
    ...evidence.files.map((file) => ({ at: evidence.capturedAt, kind: 'edit' as const, label: file.path, output: `+${file.added ?? '—'} −${file.deleted ?? '—'}` })),
    ...(evidence.report ? [{ at: evidence.capturedAt, kind: 'final' as const, label: evidence.claimLine ?? 'Report', output: evidence.finalAnswer }] : []),
    // vr2: a reply to a direction queued after the report is shown after it, not read as the report.
    ...(evidence.followUp ? [{ at: evidence.capturedAt, kind: 'final' as const, label: 'Follow-up', output: evidence.followUp }] : []),
  ] : []
  extras.push(...steerNotes.map((note) => ({ at: note.at, kind: 'steer' as const, label: note.text, state: note.type === 'steer' ? 'sent' : 'abandoned', input: note.text, isError: note.type !== 'steer' })))
  if (acceptedNote?.verdict) extras.push({ at: acceptedNote.at, kind: 'final', label: `Verdict: ${acceptedNote.verdict.kind}`, output: acceptedNote.text })
  else if (evidence) {
    const verdict = verdictOf({ id: task.id, title: task.title, kind: task.kind, status: 'in_review', deps: task.deps, dependents: [], runs: [run], notes: [], events: [], steers: [], changedFiles: evidence.files.map((file) => file.path), evidence, ...(evidence.report ? { report: evidence.report } : {}) })
    extras.push({ at: evidence.capturedAt, kind: 'final', label: `Verdict: ${verdict.kind}`, output: JSON.stringify(verdict) })
  }
  return { extras, evidence, associatedIntervals, acceptedNote }
}

export function actionRoutes(deps: ActionsDeps): Route[] {
  const exec = deps.exec ?? nodeExec
  // Recomputed per request: a workspace added in dsh must be reachable without restarting the host.
  const repoOf = (v: unknown): string => {
    // The service's list adds Crewboard's own repositories and the worktrees found under them.
    const known = [...mergeWorkspaces(deps.workspaces?.() ?? [], deps.repos), ...deps.service.repositories()].map((r) => r.root)
    if (typeof v !== 'string' || !known.includes(v)) throw new HttpError(400, 'unknown_repo', 'repo is not a dsh workspace or a configured repo')
    return v
  }
  const fail = (res: ServerResponse, err: unknown) => {
    const e = toHttpError(err)
    const lang = deps.lang?.() ?? 'en'
    // A refusal that kept its vars reads in the host's language, whoever raised it.
    const vars = err instanceof DetailError || err instanceof SplitError ? err.vars : err instanceof LaunchError ? err.vars : undefined
    const message = err instanceof MergeError
      ? orchText(lang, `merge.${err.code}`, err.vars)
      : err instanceof ChecksError ? orchText(lang, `checks.${err.code}`, err.vars)
      : vars && (err instanceof DetailError || err instanceof LaunchError || err instanceof SplitError)
      ? [orchText(lang, err.code, vars), err instanceof LaunchError ? err.detail : undefined].filter(Boolean).join('\n')
      : e.message.startsWith('Unknown preset: ')
      ? hostT(lang, 'presets.unknown', { id: e.message.slice('Unknown preset: '.length) })
      : e.message === 'The builtin preset cannot be deleted'
        ? hostT(lang, 'presets.builtinDelete')
        : e.message.startsWith('Invalid preset') ? hostT(lang, 'presets.invalid') : e.message
    // A failed command's output travels as fields — the file, its size and the tail — never whole (tk1).
    const output = err instanceof LaunchError ? err.output : undefined
    send(res, e.status, { ok: false, error: e.code, message, ...(output ? { output } : {}), ...(err instanceof LaunchError && err.vars ? { vars: err.vars } : {}), ...(err instanceof MergeError && err.paths ? { paths: err.paths } : {}) })
  }

  // The draft worker is picked like a run's (dr2): preflight, then the research preset order. A person's
  // explicit choice is checked the same way and refused, never silently replaced.
  const draftWorker = (root: string, agent?: unknown) => chooseDraftWorker({
    root, env: deps.env, home: deps.home, exec, now: () => deps.now(), lang: deps.lang?.() ?? 'en', ...(typeof agent === 'string' && agent ? { agent } : {}),
  })
  const draftFromSpec = async (root: string, spec: string, agent?: unknown) => {
    const choice = await draftWorker(root, agent)
    return summarizeDraftJob(await startDraftJob({ root, spec, agent: choice.agent, pick: choice.origin, backends: deps.backendsFor(root), now: deps.now(), exec }))
  }
  const retryDraftJob = async (root: string, id: string, agent?: unknown) => {
    const chosen = typeof agent === 'string' && agent && agent !== 'auto' ? (await draftWorker(root, agent)).agent : undefined
    return repairDraftJob({ root, id, backends: deps.backendsFor(root), now: deps.now(), exec, choose: async () => (await draftWorker(root)).agent, ...(chosen ? { agent: chosen } : {}) })
  }

  const post = (name: string, fn: (body: Body, root: string) => Promise<unknown>): Route => ({
    kind: 'exact',
    path: `${API_PREFIX}/${name}`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' })
      try {
        const body = await readBody(req, name === 'spec-upload' ? MAX_SPEC_BODY_BYTES : MAX_BODY_BYTES)
        // The repository list routes act on the list itself: the path they name is not (yet, or any more) a served repository.
        const root = LIST_ROUTES.has(name) ? '' : repoOf(body.repo)
        if (new Set(['run', 'run-checks', 'relaunch', 'continue', 'steer', 'stop', 'accept', 'accept-batch', 'merge', 'mark-merged', 'reject', 'drop', 'pos', 'task-upsert', 'task-status']).has(name) && (await loadPlan(root)).example) throw new ExamplePlanError()
        const value = await fn(body, root)
        await deps.service.refresh(root || undefined)
        send(res, 200, { ok: true, value: value ?? null })
      } catch (err) {
        fail(res, err)
      }
    },
  })

  // Query routes are registered as prefixes (the request path carries a query string) and then
  // matched exactly on the pathname.
  const get = (name: string, fn: (q: URLSearchParams, root: string, res: ServerResponse) => Promise<unknown>): Route => ({
    kind: 'prefix',
    path: `${API_PREFIX}/${name}`,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== `${API_PREFIX}/${name}`) return send(res, 404, { ok: false, error: 'not_found' })
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method_not_allowed' })
      try {
        const root = repoOf(url.searchParams.get('repo'))
        const value = await fn(url.searchParams, root, res)
        if (value !== undefined) send(res, 200, { ok: true, value })
      } catch (err) {
        fail(res, err)
      }
    },
  })

  const declined = () => new HttpError(409, 'declined', 'The human declined the action')
  const MAX_BATCH = 50
  const MAX_LISTED = 12
  const batchIds = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BATCH || v.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new HttpError(400, 'bad_request', `tasks must be a list of 1–${MAX_BATCH} task ids`)
    }
    return [...new Set(v as string[])]
  }

  const routes: Route[] = [
    { kind: 'prefix', path: `${API_PREFIX}/presets`, handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== `${API_PREFIX}/presets`) return send(res, 404, { ok: false, error: 'not_found' })
      try {
        if (req.method === 'GET') {
          const root = repoOf(url.searchParams.get('repo'))
          return send(res, 200, { ok: true, value: { presets: await listPresets({ ...deps.env, HOME: deps.home }), effectiveRouting: await resolveRouting(root, undefined, { ...deps.env, HOME: deps.home }) } })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          repoOf(body.repo)
          const value = await savePreset(body.preset as import('@crewboard/core').WorkerPreset, { ...deps.env, HOME: deps.home })
          await deps.service.refresh()
          return send(res, 200, { ok: true, value })
        }
        send(res, 405, { ok: false, error: 'method_not_allowed' })
      } catch (err) { fail(res, err) }
    } },
    post('preset-delete', async (b) => { const result = await deletePreset(text(b.id, 'id'), deps.service.repositories().map((r) => r.root), { ...deps.env, HOME: deps.home }); await deps.service.refresh(); return result }),
    post('repo-preset', async (b, root) => { await setRepositoryPreset(root, typeof b.id === 'string' ? b.id : undefined, { ...deps.env, HOME: deps.home }); return resolveRouting(root, undefined, { ...deps.env, HOME: deps.home }) }),
    post('repo-flag', async (b, root) => {
      if (b.flag !== 'pinned' && b.flag !== 'hidden') throw new HttpError(400, 'bad_request', 'flag must be pinned or hidden')
      if (typeof b.value !== 'boolean') throw new HttpError(400, 'bad_request', 'value must be a boolean')
      return setRepoPreference(deps.env, deps.home, root, { [b.flag]: b.value })
    }),
    // «+» next to REPOSITORIES: a typed folder joins Crewboard's list (never dsh's workspaces or the profile).
    post('repo-add', async (b) => {
      let root: string
      try {
        root = await resolveRepoPath(text(b.path, 'path'), { home: deps.home, exec })
      } catch (err) {
        if (err instanceof RepoPathError) throw new HttpError(400, `repo_${err.code}`, err.message)
        throw err
      }
      if (deps.service.repositories().some((r) => folderKey(r.root) === folderKey(root))) throw new HttpError(409, 'repo_already_listed', `${root} is already listed`)
      await addRegisteredRepo(root, deps.env, deps.home)
      return { root }
    }),
    // «Remove from list» forgets a folder Crewboard listed; its files, plans and worktrees stay as they are.
    post('repo-remove', async (b) => {
      const root = text(b.root, 'root')
      const ref = deps.service.repositories().find((r) => r.root === root)
      if (!ref) throw new HttpError(400, 'unknown_repo', 'repo is not a dsh workspace or a configured repo')
      if (!ref.sources?.includes('crewboard')) throw new HttpError(409, 'repo_not_removable', `${root} comes from ${ref.sources?.join(', ') || 'another list'}`)
      await removeRegisteredRepo(root, deps.env, deps.home)
      return { root, stillListed: ref.sources.filter((s) => s !== 'crewboard') }
    }),
    // The sidebar's manual row order; `order: null` is «Reset order» back to automatic sorting.
    post('side-order', async (b) => {
      if (!('order' in b)) throw new HttpError(400, 'bad_request', 'order is required')
      if (b.order !== null && (typeof b.order !== 'object' || Array.isArray(b.order))) throw new HttpError(400, 'bad_request', 'order must be an object or null')
      return setSidebarOrder(deps.env, deps.home, b.order as SidebarOrder | null)
    }),
    // «Orchestrator checks finished work» (vr1): `value` true/false, or null to fall back to the next level.
    post('orchestrator-check', async (b, root) => {
      if (b.value !== null && typeof b.value !== 'boolean') throw new HttpError(400, 'bad_request', 'value must be true, false or null')
      const value = b.value === null ? undefined : b.value
      const planId = typeof b.planId === 'string' && b.planId ? b.planId : currentPlanId(root)
      if (b.scope === 'repo') await setRepositoryOrchestratorCheck(root, value)
      else if (b.scope === 'plan') await setPlanOrchestratorCheck(root, planId, value)
      else throw new HttpError(400, 'bad_request', 'scope must be repo or plan')
      await deps.service.refresh(root)
      return resolveOrchestratorCheck(root, planId)
    }),
    // bs1: the base new copies branch from. `value` a branch name, or null to fall back to the next level.
    post('default-base', async (b, root) => {
      if (b.value !== null && typeof b.value !== 'string') throw new HttpError(400, 'bad_request', 'value must be a branch name or null')
      const value = b.value === null ? undefined : b.value.trim() || undefined
      const planId = typeof b.planId === 'string' && b.planId ? b.planId : currentPlanId(root)
      if (b.scope === 'repo') await setRepositoryDefaultBase(root, value)
      else if (b.scope === 'plan') await setPlanDefaultBase(root, planId, value)
      else throw new HttpError(400, 'bad_request', 'scope must be repo or plan')
      await deps.service.refresh(root)
      return resolveDefaultBase(root, exec, { planId })
    }),
    post('plan-preset', async (b, root) => { const planId = text(b.planId, 'planId'); await setPlanPreset(root, planId, typeof b.id === 'string' ? b.id : undefined, { ...deps.env, HOME: deps.home }); return resolveRouting(root, planId, { ...deps.env, HOME: deps.home }) }),
    // «ready» is the launch's own preflight passing — the profile, binary, login and key a run would use;
    // a check that could not run is «not checked», never «ready».
    get('onboarding-workers', async () => {
      const workers = await resolvedWorkers(deps.env, deps.home)
      const chosen = workers.filter((w) => w.main).slice(0, 4)
      const env = { ...deps.env, HOME: deps.home }
      const status = await Promise.all(chosen.map(async (worker) => {
        const profile = await resolveProfile(env, deps.home, worker.id).catch(() => undefined)
        const result = profile ? await preflightAgent(profile, { exec, lang: deps.lang?.() ?? 'en', env, commands: workerCommands(env) }).catch(() => null) : null
        const failed = (name: string) => result?.checks.some((check) => check.name === name && !check.ok)
        const state = !result ? 'unchecked' : result.ok ? 'ready' : failed('binary') ? 'missing' : failed('channel') ? 'not_ready' : failed('auth') || failed('key') ? 'sign_in' : 'not_ready'
        return { id: worker.id, label: worker.label, status: state, checks: result?.checks ?? [] }
      }))
      return status
    }),
    get('recipe', async (_q, root) => ({ recipe: await loadRecipe(root), detected: await detectRecipe(root) })),
    post('recipe-save', async (b, root) => saveRecipe(root, b.recipe)),
    get('spec-files', async (_q, root) => {
      const files: string[] = []
      const scan = async (dir: string, depth: number) => {
        if (depth > 3 || files.length >= 150) return
        for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          const rel = join(dir, entry.name)
          if (entry.isDirectory()) await scan(rel, depth + 1)
          else if (entry.isFile() && /\.(md|txt|rst)$/i.test(entry.name)) files.push(rel)
        }
      }
      await scan('', 0)
      // Uploaded and pasted specs live under .orchestration/specs, which the scan above skips.
      const saved = await readdir(join(root, SPECS_DIR), { withFileTypes: true }).catch(() => [])
      return [...saved.filter((entry) => entry.isFile() && SPEC_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))).map((entry) => `${SPECS_DIR}/${entry.name}`).sort().reverse(), ...files.sort()]
    }),
    // A draft from a spec is a background job: the answer comes back through GET plan-draft-jobs, never through this request.
    post('plan-draft-from', async (b, root) => ({ job: await draftFromSpec(root, text(b.file, 'file'), b.agent) })),
    // Who would write a draft now, and who was passed over and why; the spec picker shows it before anything starts.
    get('draft-worker', async (_q, root) => {
      const routing = await resolveRouting(root, undefined, { ...deps.env, HOME: deps.home })
      const options = [...new Set([...routing.routing.research, ...Object.values(routing.routing).flat()])]
      try {
        const choice = await draftWorker(root)
        return { agent: choice.agent, skipped: choice.skipped, options }
      } catch (err) {
        if (!(err instanceof LaunchError)) throw err
        return { agent: null, skipped: [], options, message: err.message, ...(err.detail ? { detail: err.detail } : {}) }
      }
    }),
    // An uploaded or pasted spec is saved into the repository first, then drafted exactly like a repository file.
    post('spec-upload', async (b, root) => {
      if (typeof b.text !== 'string') throw new HttpError(400, 'bad_request', 'text is required')
      if (b.name !== undefined && typeof b.name !== 'string') throw new HttpError(400, 'bad_request', 'name must be a string')
      const path = await saveUploadedSpec(root, { ...(typeof b.name === 'string' ? { name: b.name } : {}), text: b.text, now: deps.now() })
      // Keeps the saved spec out of `git status`; a folder that is not a git checkout still gets its spec.
      await ensureGitExclude(root, exec).catch(() => false)
      return { path, job: await draftFromSpec(root, path, b.agent) }
    }),
    post('example-create', async (body, root) => { await ensureGitExclude(root, exec); const plan = await createExamplePlan(root, deps.now(), body.lang === 'ru' || body.lang === 'en' ? body.lang : deps.lang?.() === 'ru' ? 'ru' : 'en'); return { plan: plan.goal } }),
    post('example-remove', async (_b, root) => { await removeExample(root); return null }),
    get('task', (q, root) => getTaskDetail(root, text(q.get('id'), 'id'), deps.backendsFor(root), exec)),
    get('diff', async (q, root, res) => {
      const diff = await getTaskDiff(root, text(q.get('id'), 'id'), text(q.get('file'), 'file'), exec)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(diff)
      return undefined
    }),
    get('file', async (q, root, res) => {
      const file = text(q.get('file'), 'file')
      const side = q.get('side')
      if (side !== 'before' && side !== 'after') throw new HttpError(400, 'bad_request', 'side must be before or after')
      const bytes = await getTaskFile(root, text(q.get('id'), 'id'), file, side, exec)
      const ext = file.split('.').at(-1)?.toLowerCase() ?? ''
      const mime: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
        ico: 'image/x-icon', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        pdf: 'application/pdf', html: 'text/html', htm: 'text/html', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
        json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml', dxf: 'application/dxf', woff2: 'font/woff2',
        woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain', log: 'text/plain',
      }
      res.writeHead(200, {
        'content-type': (mime[ext] ?? 'application/octet-stream') + (/^(text\/|application\/(json|dxf))/.test(mime[ext] ?? '') ? '; charset=utf-8' : ''),
        'content-length': String(bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        ...(ext === 'html' || ext === 'htm' || ext === 'svg' ? { 'content-security-policy': 'sandbox' } : {}),
      })
      res.end(bytes)
      return undefined
    }),
    get('example-file', async (q, root, res) => {
      const plan = await loadPlan(root)
      const task = plan.tasks.find((item) => item.id === q.get('task'))
      if (!plan.example || !task || q.get('file') !== 'welcome.png') throw new HttpError(404, 'unknown_file', 'Example image not found')
      const image = await getTaskFile(root, task.id, 'welcome.png', 'after', exec).catch(() => { throw new HttpError(404, 'unknown_file', 'Example image not found') })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(image)
      return undefined
    }),
    // Plan summary: run accounting per run, task summaries and review intervals; the full trace stays lazy in GET trace.
    get('cost', async (_q, root): Promise<PlanCost> => {
      const plan = await loadPlan(root)
      // The example is served from its synthetic store and marked, so it never mixes into real accounting.
      const backends = backendsForPlan(plan, root, deps.backendsFor(root))
      const runs: PlanRunCost[] = []
      const accepted: PlanCost['accepted'] = []
      const billStamp = (await stat(dshBillRecordsPath(deps.env, deps.home)).catch(() => undefined))?.mtimeMs
      for (const task of plan.tasks) {
        const at = task.notes.filter((n) => n.type === 'accept').at(-1)?.at
        if (at) accepted.push({ taskId: task.id, at })
        for (const run of task.runs) {
          const backend = await backends.forAgent(run.agent, run.runId).catch(() => undefined)
          const status = !run.finishedAt ? await backend?.status(run.runId).catch(() => undefined) : undefined
          const resolved = status?.terminal && status.finishedAt ? { ...run, finishedAt: status.finishedAt, outcome: status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled' ? status.status : run.outcome } : run
          const transcriptDir = task.worktree?.path && run.agent.startsWith('claude') ? join(claudeProjectsDir(deps.env, deps.home), claudeProjectSlug(task.worktree.path)) : undefined
          const transcriptFiles = transcriptDir ? await readdir(transcriptDir).catch(() => []) : []
          const transcriptStamps = transcriptDir ? await Promise.all(transcriptFiles.filter((file) => file.endsWith('.jsonl')).map(async (file) => [file, (await stat(join(transcriptDir, file)).catch(() => undefined))?.mtimeMs])) : []
          const fingerprint = JSON.stringify([resolved, (await stat(join(root, '.orchestration', 'runs', run.runId, 'state.json')).catch(() => undefined))?.mtimeMs, (await stat(join(root, '.orchestration', 'runs', run.runId, 'events.jsonl')).catch(() => undefined))?.mtimeMs, run.agent.startsWith('dsh') ? billStamp : undefined, transcriptStamps])
          const cached = resolved.finishedAt ? completedReviewCosts.get(`${root}:${run.runId}:${fingerprint}`) : undefined
          const usage = cached ? undefined : await usageForRun(backend, resolved, task.worktree?.path, claudeProjectsDir(deps.env, deps.home))
          const events = !cached && !usage && backend ? await backend.events(run.runId).catch(() => []) : []
          const calculated = cached ?? runCost(resolved, events, usage)
          if (resolved.finishedAt && !cached) {
            if (completedReviewCosts.size > 2048) completedReviewCosts.clear()
            completedReviewCosts.set(`${root}:${run.runId}:${fingerprint}`, calculated)
          }
          runs.push({
            ...calculated,
            taskId: task.id,
            taskTitle: task.title,
            startedAt: run.startedAt,
            workerChoice: runWorkerChoice(run, task.notes),
            ...(resolved.finishedAt ? { terminalProvenance: run.finishedAt ? 'plan' as const : 'backend' as const } : {}),
            ...(resolved.finishedAt ? { finishedAt: resolved.finishedAt } : {}),
            ...(resolved.outcome ? { outcome: resolved.outcome } : {}),
          })
        }
      }
      const tasks = plan.tasks.map((task) => {
        const taskRuns = runs.filter((run) => run.taskId === task.id)
        const intervals = task.reviewIntervals ?? []
        const decisions = task.notes.flatMap((note, index) => note.type === 'accept' || note.type === 'reject' ? [{ id: `decision:${task.id}:${index}`, at: note.at, kind: note.type, ...(note.verdict ? { verdict: note.verdict.kind } : {}), ...(note.check ? { check: note.check } : {}), reason: note.text }] : [])
        const legacyAccept = task.notes.filter((note) => note.type === 'accept').at(-1)
        const reviewIntervals = intervals.map((i) => ({ id: i.id, from: i.enteredAt, ...(i.decidedAt ? { to: i.decidedAt, decisionId: decisions.find((decision) => decision.at === i.decidedAt)?.id } : {}), ...(i.runId ? { runId: i.runId } : {}), association: i.association }))
        if (!intervals.length && legacyAccept && taskRuns.length) reviewIntervals.push({ id: `legacy:${task.id}`, from: taskRuns.at(-1)!.finishedAt ?? taskRuns.at(-1)!.startedAt, to: legacyAccept.at, association: 'task_only' })
        const sorted = [...taskRuns].sort((a,b) => Date.parse(a.startedAt)-Date.parse(b.startedAt))
        const workerSec = taskRuns.reduce((sum, r) => sum + (r.durationSec ?? Math.max(0, (deps.now().getTime()-Date.parse(r.startedAt))/1000)), 0)
        const cashKnown = taskRuns.filter(r=>r.cashUsd !== undefined)
        const equivalentKnown = taskRuns.filter(r=>r.apiEquivalentUsd !== undefined)
        const accounting = { ...(cashKnown.length ? { cashUsd: cashKnown.reduce((s,r) => s+r.cashUsd!.value,0) } : {}), ...(equivalentKnown.length ? { apiEquivalentUsd: equivalentKnown.reduce((s,r) => s+r.apiEquivalentUsd!.value,0) } : {}), quotaMeasurements: taskRuns.reduce((s,r) => s+(r.quotaMeasurements?.length ?? 0),0), knownRuns: cashKnown.length, cashEligibleRuns: taskRuns.filter(r=>r.availability?.cash !== 'notApplicable').length, equivalentKnownRuns: equivalentKnown.length, pendingRuns: taskRuns.filter(r=>r.pending).length, unavailableRuns: taskRuns.filter(r=>!r.cashUsd && !r.pending && r.availability?.cash !== 'notApplicable').length }
        return { taskId: task.id, title: task.title, ...(task.class ? { taskClass: task.class } : { currentClassFallback: true }), state: taskRuns.some((run) => !run.finishedAt) ? 'running' : task.status, runIds: sorted.map(r=>r.runId), attemptIndexes: sorted.map((r,i)=>r.attemptIndex ?? i+1), ...(sorted.length ? { elapsedSec: Math.max(0, (Date.parse(legacyAccept?.at ?? deps.now().toISOString())-Date.parse(sorted[0]!.startedAt))/1000) } : {}), workerSec, reviewWaitMs: unionReviewIntervals(reviewIntervals, deps.now().toISOString()), reviewIntervals, executionOutcomes: taskRuns.map(r=>({runId:r.runId,outcome:r.executionOutcome ?? 'unknown'})), decisions, accounting }
      })
      const historyCompleteness = plan.tasks.every(t=>!!t.reviewIntervals || !t.runs.length) ? 'complete' as const : 'partial' as const
      const planId = currentPlanId(root)
      const binding = (await readChats(root))[planId]
      const orchestrator = await orchestratorUsage(binding ? { [planId]: binding } : {}, dshBillRecordsPath(deps.env, deps.home))
      return { schemaVersion: 2, ...(plan.example ? { synthetic: true as const } : {}), planId, rev: plan.rev, historyCompleteness, generatedAt: deps.now().toISOString(), runs, totals: summarizeCosts(runs), accepted, tasks, coverage: reviewCoverage(runs, historyCompleteness), orchestrator }
    }),
    // Step strips for the run rows on screen. Kept out of GET cost so the plan summary never reads raw events.
    get('run-steps', async (q, root): Promise<Record<string, RunStepSummary>> => {
      const wanted = new Set(text(q.get('runs'), 'runs').split(',').filter(Boolean).slice(0, RUN_STEPS_LIMIT))
      const plan = await loadPlan(root)
      const out: Record<string, RunStepSummary> = {}
      for (const task of plan.tasks) for (const run of task.runs) {
        if (!wanted.has(run.runId)) continue
        const stamp = (await stat(join(root, '.orchestration', 'runs', run.runId, 'events.jsonl')).catch(() => undefined))?.mtimeMs
        // Notes carry steers and the verdict, the evidence path the captured checks: both change the ledger.
        const key = `${root}:${run.runId}:${run.finishedAt ?? ''}:${stamp ?? ''}:${task.notes.length}:${run.evidence ?? ''}`
        const cached = run.finishedAt ? finishedRunSteps.get(key) : undefined
        if (cached) { out[run.runId] = cached; continue }
        const backend = await backendsForPlan(plan, root, deps.backendsFor(root)).forAgent(run.agent, run.runId).catch(() => undefined)
        const events = backend ? await backend.events(run.runId).catch(() => []) : []
        // Placed by elapsed time from the recorded start; a live run is measured up to now.
        const { extras } = await runLedgerExtras(root, task, run)
        const steps = runStepSummary(buildLedger(events, run, extras), { start: Date.parse(run.startedAt), end: Date.parse(run.finishedAt ?? deps.now().toISOString()) }, ledgerCompleteness(run.finishedAt, events.length))
        if (run.finishedAt) {
          if (finishedRunSteps.size > 4096) finishedRunSteps.clear()
          finishedRunSteps.set(key, steps)
        }
        out[run.runId] = steps
      }
      return out
    }),
    get('task-review', async (q, root) => {
      const id = text(q.get('task'), 'task')
      const plan = await loadPlan(root)
      const task = plan.tasks.find((item) => item.id === id)
      if (!task) throw new HttpError(404, 'unknown_task', `Task not found: ${id}`)
      // Reuse the lightweight plan summary and return only the requested task's attempt ledger.
      const backends = backendsForPlan(plan, root, deps.backendsFor(root))
      const attempts = await Promise.all(task.runs.map(async (run) => {
        const backend = await backends.forAgent(run.agent, run.runId).catch(() => undefined)
        const state = !run.finishedAt ? await backend?.status(run.runId).catch(() => undefined) : undefined
        const resolved = state?.terminal && state.finishedAt ? { ...run, finishedAt: state.finishedAt, outcome: state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled' ? state.status : run.outcome } : run
        const events = backend ? await backend.events(run.runId).catch(() => []) : []
        const usage = await usageForRun(backend, resolved, task.worktree?.path, claudeProjectsDir(deps.env, deps.home))
        return { ...runCost(resolved, events, usage), taskId: task.id, taskTitle: task.title, startedAt: run.startedAt, ...(resolved.finishedAt ? { finishedAt: resolved.finishedAt, terminalProvenance: run.finishedAt ? 'plan' as const : 'backend' as const } : {}) }
      }))
      const intervals = task.reviewIntervals ?? []
      const decisions = task.notes.flatMap((note, index) => note.type === 'accept' || note.type === 'reject' ? [{ id: `decision:${task.id}:${index}`, at: note.at, kind: note.type, ...(note.verdict ? { verdict: note.verdict.kind } : {}), ...(note.check ? { check: note.check } : {}), reason: note.text }] : [])
      const cashKnown = attempts.filter((run) => !!run.cashUsd)
      const equivalentKnown = attempts.filter((run) => !!run.apiEquivalentUsd)
      const ordered = [...attempts].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
      const reviewIntervals = intervals.map((interval) => ({ id: interval.id, from: interval.enteredAt, ...(interval.decidedAt ? { to: interval.decidedAt, decisionId: decisions.find((decision) => decision.at === interval.decidedAt)?.id } : {}), ...(interval.runId ? { runId: interval.runId } : {}), association: interval.association }))
      const summary = { taskId: id, title: task.title, ...(task.class ? { taskClass: task.class } : {}), state: attempts.some((run) => !run.finishedAt) ? 'running' : task.status, runIds: ordered.map((run) => run.runId), attemptIndexes: ordered.map((run, index) => run.attemptIndex ?? index + 1), workerSec: attempts.reduce((sum, run) => sum + (run.durationSec ?? Math.max(0, (deps.now().getTime() - Date.parse(run.startedAt)) / 1000)), 0), reviewWaitMs: unionReviewIntervals(reviewIntervals, deps.now().toISOString()), reviewIntervals, executionOutcomes: attempts.map((run) => ({ runId: run.runId, outcome: run.executionOutcome ?? 'unknown' })), decisions, accounting: { ...(cashKnown.length ? { cashUsd: cashKnown.reduce((sum, run) => sum + run.cashUsd!.value, 0) } : {}), ...(equivalentKnown.length ? { apiEquivalentUsd: equivalentKnown.reduce((sum, run) => sum + run.apiEquivalentUsd!.value, 0) } : {}), quotaMeasurements: attempts.reduce((sum, run) => sum + (run.quotaMeasurements?.length ?? 0), 0), knownRuns: cashKnown.length, cashEligibleRuns: attempts.filter((run) => run.availability?.cash !== 'notApplicable').length, equivalentKnownRuns: equivalentKnown.length, pendingRuns: attempts.filter((run) => run.pending).length, unavailableRuns: attempts.filter((run) => !run.cashUsd && !run.pending && run.availability?.cash !== 'notApplicable').length } }
      return { taskId: id, attempts, summary, decisions: task.notes.flatMap((note, index) => note.type === 'accept' || note.type === 'reject' ? [{ ...note, id: `decision:${task.id}:${index}` }] : []), reviewIntervals: intervals.map((interval) => ({ ...interval, ...(interval.decidedAt ? { decisionId: decisions.find((decision) => decision.at === interval.decidedAt)?.id } : {}) })), cumulative: summarizeCosts(attempts), ...(plan.example ? { synthetic: true as const } : {}), generatedAt: deps.now().toISOString() }
    }),
    get('trace', async (q, root) => {
      const id = text(q.get('id'), 'id')
      const plan = await loadPlan(root)
      const task = plan.tasks.find((t) => t.id === id)
      if (!task) throw new HttpError(404, 'unknown_task', `Task not found: ${id}`)
      const wanted = q.get('run')
      const run = wanted ? task.runs.find((r) => r.runId === wanted) : task.runs.at(-1)
      if (!run) throw new HttpError(404, 'unknown_run', wanted ? `Run not found: ${wanted}` : `Task ${id} has no runs yet`)
      const backend = await backendsForPlan(plan, root, deps.backendsFor(root)).forAgent(run.agent, run.runId).catch(() => undefined)
      const events = backend ? await backend.events(run.runId).catch(() => []) : []
      const trace = buildTrajectory(events, { startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) }, deps.now())
      const { extras, evidence, associatedIntervals, acceptedNote } = await runLedgerExtras(root, task, run)
      const usage = await usageForRun(backend, run, task.worktree?.path, claudeProjectsDir(deps.env, deps.home))
      const cost = runCost(run, events, usage)
      const ranges = associatedIntervals.map((interval) => [Date.parse(interval.enteredAt), Date.parse(interval.decidedAt ?? deps.now().toISOString())] as const).sort((a, b) => a[0] - b[0])
      let humanWaitMs = ranges.length ? 0 : undefined
      let lastEnd = 0
      for (const [from, to] of ranges) { humanWaitMs! += Math.max(0, to - Math.max(from, lastEnd)); lastEnd = Math.max(lastEnd, to) }
      const reviewOutcome = acceptedNote ? 'accepted' : associatedIntervals.some((interval) => !interval.decidedAt) ? 'awaiting' : undefined
      const ledger = buildLedger(events, run, extras)
      const page = pageLedger(ledger, q.get('cursor'), q.get('seek'))
      if (!page) throw new HttpError(404, 'unknown_step', 'Step is outside the retained run history')
      return { ...trace, spans: trace.spans.slice(-MAX_SPANS), ...page, overviewMarks: ledger.map(({ stepId, index, kind, startedAt, durationMs, timing, isError }) => ({ stepId, index, kind, startedAt, durationMs, timing, ...(isError ? { isError } : {}) })), completeness: ledgerCompleteness(run.finishedAt, events.length), cost, outcome: run.outcome, ...(reviewOutcome ? { reviewOutcome } : {}), evidenceCapturedAt: evidence?.capturedAt, ...(humanWaitMs !== undefined ? { humanWaitMs } : {}), ...(plan.example ? { synthetic: true } : {}) }
    }),
    get('workers', async () => {
      const path = profileStorePath(deps.env, deps.home)
      await recoverWorkerDeletion(registryPath(deps.env, deps.home), path)
      const store = await loadProfileStore(deps.env, deps.home)
      const profiles = Object.entries(store.profiles).map(([id, profile]) => ({ id, backend: backendForTransport(profile.transport), transport: profile.transport, model: profile.model, enabled: profile.enabled, ...(profile.effort ? { effort: profile.effort } : {}), ...(profile.origin ? { origin: profile.origin } : {}) }))
      const routing = await loadRouting(path, deps.env, deps.home)
      const registry = await loadRegistry(registryPath(deps.env, deps.home))
      const catalog = await dshCatalogOf(deps.sessions?.())
      const presets = await listPresets({ ...deps.env, HOME: deps.home }).catch(() => [])
      const workers = describeWorkers(routing, profiles, await profileLabels(deps.env, deps.home), registry.workers, { ...(catalog ? { catalog } : {}), presets, lang: deps.lang?.() ?? 'en' })
      return {
        routing,
        classes: TASK_CLASSES.map((id) => ({ id, label: deps.lang?.() === 'ru' ? CLASS_LABEL_RU[id] : CLASS_LABEL[id] })),
        known: [...new Set([...registry.workers.map((w) => w.id), ...profiles.map((p) => p.id)])],
        workers,
        // wo2: the CLIs a runner backend exists for; the screen marks every other one «listed for reference».
        runnableClis: SUBSCRIPTION_CLIS.filter(cliRuns),
        registry: registry.workers,
        catalog: catalog ?? null,
      }
    }),
    // Worktrees of the repository's tasks: the panel shows them with the reason each one stays.
    get('worktrees', async (_q, root) => {
      const candidates = await gcCandidates(root, { exec, now: deps.now })
      const totalBytes = candidates.reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0)
      return { candidates, totalBytes, policy: await loadWorktreePolicy(worktreeConfigPath(deps.env, deps.home)) }
    }),
    // Only the copies the panel sent, and only the ones that hold every condition; recent ones stay.
    post('worktree-gc', async (b, root) => {
      const ids = batchIds(b.tasks)
      const candidates = await gcCandidates(root, { exec, now: deps.now })
      const byId = new Map(candidates.flatMap((c) => [[c.planId ? `${c.planId}:${c.taskId}` : c.taskId, c] as const, [c.taskId, c] as const]))
      const eligible: string[] = []
      const failed: GcResult['failed'] = []
      for (const id of ids) {
        const candidate = byId.get(id)
        if (!candidate) failed.push({ taskId: id, reason: 'worktree is not in the list' })
        else if (candidate.keep) failed.push({ taskId: id, reason: KEEP_REASON[candidate.keep] })
        else eligible.push(candidate.planId ? `${candidate.planId}:${candidate.taskId}` : id)
      }
      const result = await gcRemove(root, eligible, { exec })
      return { removed: result.removed, failed: [...failed, ...result.failed] }
    }),
    post('worktree-policy', async (b) => {
      if (typeof b.policy !== 'string') throw new HttpError(400, 'bad_request', 'policy is required')
      return { policy: await saveWorktreePolicy(worktreeConfigPath(deps.env, deps.home), b.policy) }
    }),
    post('worker-check', async (b) => {
      const kind = text(b.kind, 'kind')
      const backend: Backend | undefined = CHECK_BACKEND[kind]
      if (!backend) throw new HttpError(400, 'bad_request', 'Unknown worker type')
      const env = { ...deps.env, HOME: deps.home }
      return preflightAgent({ id: `${kind}/${typeof b.model === 'string' ? b.model : ''}`, backend, model: typeof b.model === 'string' ? b.model : '', enabled: true }, { exec, lang: deps.lang?.() ?? 'en', env, commands: workerCommands(env) })
    }),
    post('worker-save', async (b) => {
      if (!b.entry || typeof b.entry !== 'object' || Array.isArray(b.entry)) throw new HttpError(400, 'bad_request', 'entry must be a worker record')
      await recoverWorkerDeletion(registryPath(deps.env, deps.home), profileStorePath(deps.env, deps.home))
      const entry = b.entry as import('@crewboard/core').WorkerEntry
      await saveWorkerProfile(deps.env, deps.home, entry)
      return saveWorker(registryPath(deps.env, deps.home), entry)
    }),
    // wo1 «Add as worker»: an older tool's profile becomes the person's own and leaves «Other / imported».
    post('worker-adopt', async (b) => {
      const id = text(b.id, 'id')
      if (!(await adoptImportedProfile(deps.env, deps.home, id))) throw new HttpError(404, 'unknown_worker', id)
      await deps.service.refresh()
      return { adopted: id }
    }),
    // wo1: a stale id — nothing defines it — leaves the routing, its switches and the saved presets.
    post('worker-forget', async (b) => {
      const id = text(b.id, 'id')
      const result = await forgetWorkerId(id, { ...deps.env, HOME: deps.home }, deps.home)
      await deps.service.refresh()
      return result
    }),
    post('worker-delete', async (b) => {
      const id = text(b.id, 'id')
      return removeWorker(registryPath(deps.env, deps.home), profileStorePath(deps.env, deps.home), id, deps.env, deps.home)
    }),
    // pv1: the models a signed-in subscription CLI offers, read from the CLI itself (Claude: Crewboard's list).
    post('worker-models', async (b) => {
      if (!isSubscriptionKind(b.kind)) throw new HttpError(400, 'bad_request', `kind must be ${SUBSCRIPTION_KIND_LIST}`)
      const env = { ...deps.env, HOME: deps.home }
      return listSubscriptionModels(b.kind, { exec, env, commands: workerCommands(env) })
    }),
    // pv1: «Add models» — one worker per chosen model and effort, as `crewboard workers add … --effort` makes them.
    post('worker-add-models', async (b) => {
      if (!isSubscriptionKind(b.kind)) throw new HttpError(400, 'bad_request', `kind must be ${SUBSCRIPTION_KIND_LIST}`)
      const kind = b.kind
      const models = Array.isArray(b.models) ? b.models.flatMap((item) => (item && typeof item === 'object' && typeof (item as Body).model === 'string' && (item as Body).model ? [{ model: String((item as Body).model).trim(), label: typeof (item as Body).label === 'string' && String((item as Body).label).trim() ? String((item as Body).label).trim() : String((item as Body).model).trim() }] : [])) : []
      if (models.length === 0) throw new HttpError(400, 'bad_request', 'models must list at least one model')
      const efforts = Array.isArray(b.efforts) ? b.efforts.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : []
      const effortBackend = EFFORT_BACKEND[kind]
      const accepted = effortBackend ? (EFFORT_LEVELS[effortBackend] ?? []) : []
      const unknown = efforts.find((effort) => !accepted.includes(effort))
      if (unknown) throw new HttpError(400, 'bad_request', `${kind} does not take effort “${unknown}”`)
      await recoverWorkerDeletion(registryPath(deps.env, deps.home), profileStorePath(deps.env, deps.home))
      const result = await addSubscriptionWorkers(deps.env, deps.home, registryPath(deps.env, deps.home), subscriptionEntries(kind, models, efforts))
      await deps.service.refresh()
      return result
    }),
    post('task-upsert', async (b, root) => {
      const title = text(b.title, 'title').trim()
      const parent = text(b.parent, 'parent')
      const id = text(b.id, 'id')
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new HttpError(400, 'bad_id', 'Invalid task id')
      const replace = b.replace === true
      const depends = !replace && b.depends !== false
      const detail = await getTaskDetail(root, parent, deps.backendsFor(root), exec)
      const plan = await loadPlan(root)
      const source = plan.tasks.find((task) => task.id === parent)
      if (!source) throw new HttpError(404, 'unknown_task', parent)
      if (plan.tasks.some((task) => task.id === id)) throw new HttpError(409, 'duplicate_task', id)
      const taskClass = b.class === 'code' || b.class === 'design' || b.class === 'review' || b.class === 'research' ? b.class : source.class
      const lane = typeof b.lane === 'string' ? b.lane.trim() : source.lane
      const note = typeof b.note === 'string' ? b.note.trim().slice(0, 8000) : ''
      const findings = (detail.verdict?.facts ?? []).map((fact) => fact.text ?? fact.code)
      const contract = contractPathFor(currentPlanId(root), id)
      // The one contract template (ct1): the parent's report, verdict and findings are the context, the note is
      // the result, and the parent's checks carry over — the same work is checked the same way.
      const parentChecks = detail.contract ? requiredChecks(detail.contract.text) : []
      const lang = deps.lang?.() ?? 'en'
      const content = contractTemplate({
        goal: title,
        context: followUpContext({ id: parent, title: source.title, report: detail.report?.text, verdict: detail.verdict?.kind, findings }, replace, lang),
        result: note || title,
        checks: parentChecks,
        sources: source.contract ? [source.contract] : [],
        lang,
      })
      await writeNewContract(root, contract, content)
      try {
        await updatePlan(root, (current) => {
          if (current.tasks.some((task) => task.id === id)) throw new HttpError(409, 'duplicate_task', id)
          const original = current.tasks.find((task) => task.id === parent)
          if (!original) throw new HttpError(404, 'unknown_task', parent)
          const created = newTask({ id, title, kind: source.kind === 'decision' ? 'implement' : source.kind, class: taskClass, lane, deps: depends ? [parent] : [], contract, status: 'ready' })
          if (original.pos) created.pos = { x: original.pos.x + 300, y: original.pos.y }
          current.tasks.push(created)
          if (replace) original.status = 'superseded'
          return current
        })
      } catch (error) {
        await import('node:fs/promises').then(({ rm }) => rm(join(root, contract), { force: true }))
        throw error
      }
      return { id }
    }),
    // nb1: the first task of an empty plan, from the screen. The id comes from the title; the contract is the one
    // template (ct1) with the title as the goal and the person's line as the result, checks left for the person.
    post('task-add', async (b, root) => {
      const title = text(b.title, 'title').trim().slice(0, 200)
      const result = typeof b.result === 'string' ? b.result.trim().slice(0, 8000) : ''
      const plan = await loadPlan(root)
      const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '') || 'task'
      const taken = new Set(plan.tasks.map((task) => task.id))
      let id = base
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
      const contract = contractPathFor(currentPlanId(root), id)
      await writeNewContract(root, contract, contractTemplate({ goal: title, result: result || title, lang: deps.lang?.() ?? 'en' }))
      try {
        await updatePlan(root, (current) => {
          if (current.tasks.some((task) => task.id === id)) throw new HttpError(409, 'duplicate_task', id)
          current.tasks.push(newTask({ id, title, contract, status: 'ready' }))
          return current
        })
      } catch (error) {
        await import('node:fs/promises').then(({ rm }) => rm(join(root, contract), { force: true }))
        throw error
      }
      return { id }
    }),
    post('task-status', async (b, root) => {
      const id = text(b.task, 'task')
      if (b.status !== 'ready' && b.status !== 'backlog') throw new HttpError(400, 'bad_status', 'Invalid task status')
      await updatePlan(root, (plan) => {
        const task = plan.tasks.find((item) => item.id === id)
        if (!task) throw new HttpError(404, 'unknown_task', id)
        if (task.status !== 'ready' && task.status !== 'backlog') throw new HttpError(409, 'bad_status', 'Task cannot be moved')
        task.status = b.status as 'ready' | 'backlog'
        return plan
      })
      return { id }
    }),
    post('worktree-open', async (b, root) => {
      const detail = await getTaskDetail(root, text(b.task, 'task'), deps.backendsFor(root), exec)
      const path = detail.worktree?.path
      if (!path || !(await stat(path).catch(() => null))?.isDirectory()) throw new HttpError(404, 'no_worktree', 'Worktree is unavailable')
      let result = b.reveal === true ? await exec('open', ['-R', path]) : await exec('open', ['-a', 'WebStorm', path])
      if (b.reveal !== true && result.code !== 0) result = await exec('open', ['-a', 'Visual Studio Code', path])
      if (result.code !== 0) throw new HttpError(409, 'open_failed', result.stderr || 'Could not open worktree')
      return { path }
    }),
    // «Run checks here» (ck1): Crewboard runs the contract's <checks> in the copy and answers with the task's detail.
    post('run-checks', async (b, root) => {
      const task = text(b.task, 'task')
      await runContractChecks({ root, taskId: task, by: 'person', exec, env: deps.env, now: () => deps.now(), lang: deps.lang?.() })
      return getTaskDetail(root, task, deps.backendsFor(root), exec)
    }),
    post('run', (b, root) =>
      launchTask({
        root,
        taskId: text(b.task, 'task'),
        ...(typeof b.agent === 'string' && b.agent.trim() ? { agent: b.agent } : {}),
        // A dsh screen action is a person (the client header gates every POST): any worker may be picked.
        caller: callerOf({ kind: 'ui' }),
        // The person's answer about a copy with uncommitted changes (fo1).
        ...(b.dirtyCopy === 'keep' || b.dirtyCopy === 'reset' ? { dirtyCopy: b.dirtyCopy } : {}),
        // bs1: a person chooses the base on purpose from the screen too — the same person-only rule as --base.
        ...(typeof b.base === 'string' && b.base.trim() ? { base: b.base.trim() } : {}),
        backends: deps.backendsFor(root),
        exec,
        env: deps.env,
        home: deps.home,
        now: () => deps.now(),
        lang: deps.lang?.(),
      }),
    ),
    post('relaunch', (b, root) =>
      relaunchTask({
        root,
        taskId: text(b.task, 'task'),
        ...(typeof b.agent === 'string' && b.agent.trim() ? { agent: b.agent } : {}),
        // A dsh screen action is a person (the client header gates every POST): any worker may be picked.
        caller: callerOf({ kind: 'ui' }),
        ...(typeof b.note === 'string' && b.note.trim() ? { note: b.note } : {}),
        ...(typeof b.fromStep === 'string' && b.fromStep.trim() ? { fromStep: b.fromStep.slice(0, 300) } : {}),
        backends: deps.backendsFor(root),
        exec,
        env: deps.env,
        home: deps.home,
        now: () => deps.now(),
        lang: deps.lang?.(),
      }),
    ),
    // «Continue» on a run that ended unfinished (bg1): a relaunch in the same worktree with the direction to finish and report.
    post('continue', (b, root) =>
      continueTask({
        root,
        taskId: text(b.task, 'task'),
        caller: callerOf({ kind: 'ui' }),
        backends: deps.backendsFor(root),
        exec,
        env: deps.env,
        home: deps.home,
        now: () => deps.now(),
        lang: deps.lang?.(),
      }),
    ),
    post('steer', async (b, root) => {
      const result = await steerTask(root, text(b.task, 'task'), { message: text(b.message, 'message') }, deps.backendsFor(root), deps.now())
      return { ...result, notice: hostT(deps.lang?.() ?? 'en', `steer.${result.delivery}`, { ...result, state: result.state ?? '' }) }
    }),
    post('stop', (b, root) => stopTask(root, text(b.task, 'task'), deps.backendsFor(root))),
    post('accept', async (b, root) => {
      const task = text(b.task, 'task')
      const detail = await getTaskDetail(root, task, deps.backendsFor(root), exec)
      const verdict = detail.verdict
      // A decision has no run and no diff, so the question must not claim that changes were reviewed.
      const lang = deps.lang?.() ?? 'en'
      const question = !verdict
        ? hostT(lang, 'actions.accept.decision', { task })
        : detail.kind === 'root' && verdict.kind === 'result'
          ? hostT(lang, 'actions.accept.root', { task })
        : verdict.kind === 'negative'
          ? hostT(lang, 'actions.accept.negative', { task, why: verdict.why ? ` ${verdictReason(lang, verdict)}.` : '' })
          : verdict.kind === 'disputed'
            ? hostT(lang, 'actions.accept.disputed', { task, mismatch: verdictReason(lang, verdict) })
            : verdict.caution ? hostT(lang, 'actions.accept.caution', { task }) : hostT(lang, 'actions.accept.normal', { task })
      // One line on the orchestrator's check (vc1): checked, not checked yet — accept anyway, or no check for this
      // plan and why. The orchestrator's own work and decisions (rt1): accepting before its «done» is said out loud.
      const plan = await loadPlan(root)
      const view = deriveViews(plan).find((v) => v.task.id === task)
      const check = view ? reviewCheckOf({ status: view.status, kind: view.task.kind, check: view.check }, await resolveOrchestratorCheck(root, undefined, plan)) : undefined
      const unchecked = check ? acceptCheckLine(lang, check, task, view?.task.check?.note) : view && ownWorkUnchecked(view.task.kind, view.check) ? hostT(lang, 'actions.accept.ownUnchecked', { task }) : ''
      // Work the copy holds without a commit is not on the task branch: merging it would not bring it (w1d).
      const count = detail.worktree ? await uncommittedCount(detail.worktree.path, exec) : undefined
      const loose = count ? hostT(lang, 'actions.accept.uncommitted', { task, count }) : ''
      if (!(await deps.native.confirm('crewboard', unchecked + loose + question, hostT(lang, 'actions.ok.accept'), hostT(lang, 'actions.ok.cancel')))) throw declined()
      await acceptTask(root, task, deps.now(), verdict, detail.runs.at(-1)?.evidence)
      // Acceptance cleans only that task's copy; the feed note is written by gcAfterAccept, not silently.
      const cleanup = await gcAfterAccept(root, [task], { exec, now: deps.now, policyPath: worktreeConfigPath(deps.env, deps.home) })
      return { task, status: 'accepted', verdict, worktreeRemoved: cleanup.removed.includes(task) }
    }),
    // mg1: the screen's Merge — the same checks and refusals as `crewboard merge`, then the person's native yes.
    // Not an agent tool: dsh tools (tools.ts) never reach this route.
    post('merge', async (b, root) => {
      const task = text(b.task, 'task')
      if (b.strategy !== undefined && b.strategy !== 'no-ff' && b.strategy !== 'squash') throw new HttpError(400, 'bad_request', 'strategy must be no-ff or squash')
      const strategy = b.strategy === 'squash' ? 'squash' as const : 'no-ff' as const
      const lang = deps.lang?.() ?? 'en'
      const ready = await checkMerge(root, task, { exec, now: deps.now() })
      const question = hostT(lang, 'actions.merge', { task, branch: ready.branch, into: ready.into, root, how: hostT(lang, `actions.merge.${strategy}`) })
      if (!(await deps.native.confirm('crewboard', question, hostT(lang, 'actions.ok.merge'), hostT(lang, 'actions.ok.cancel')))) throw declined()
      const result = await mergeTask(root, task, { exec, now: deps.now, strategy, policyPath: worktreeConfigPath(deps.env, deps.home) })
      return { task, into: result.into, strategy, commit: result.commit, copy: result.copy, ...(result.keptBecause ? { keptBecause: result.keptBecause } : {}) }
    }),
    // mk1: the screen's Mark as merged… — work that reached the base in a way Crewboard cannot see. The person's
    // native yes and a reason; git is not touched, a detached HEAD is fine. Not an agent tool, like Merge.
    post('mark-merged', async (b, root) => {
      const task = text(b.task, 'task')
      const reason = text(b.reason, 'reason')
      const lang = deps.lang?.() ?? 'en'
      const ready = await checkMarkMerged(root, task, { exec })
      const question = hostT(lang, 'actions.markMerged', { task, branch: ready.branch, into: ready.into, root, reason })
      if (!(await deps.native.confirm('crewboard', question, hostT(lang, 'actions.ok.markMerged'), hostT(lang, 'actions.ok.cancel')))) throw declined()
      await markMerged(root, task, reason, { exec, now: deps.now() })
      return { task, into: ready.into }
    }),
    post('accept-batch', async (b, root) => {
      const ids = batchIds(b.tasks)
      await deps.service.refresh(root)
      const repo = deps.service.snapshot().repos.find((r) => r.root === root)
      const byId = new Map((repo?.tasks ?? []).map((t) => [t.id, t]))
      const bad = ids.filter((id) => {
        const t = byId.get(id)
        return !t || !waitsForHuman(t)
      })
      if (bad.length > 0) throw new HttpError(409, 'not_reviewable', `Not awaiting review: ${bad.join(', ')}`)
      // dc1: a decision is never closed in a batch — the person confirms it one by one, or the orchestrator
      // records an answer already given in chat (`decision answer`). Atomic: refuse before the dialog.
      const decisions = ids.filter((id) => byId.get(id)?.kind === 'decision')
      if (decisions.length > 0) throw new HttpError(409, 'decision_batch', `Decisions are confirmed one by one, not in a batch: ${decisions.join(', ')}`)
      const lines = ids.slice(0, MAX_LISTED).map((id) => `• ${id} — ${byId.get(id)?.title ?? ''}`)
      if (ids.length > MAX_LISTED) lines.push(`… and ${ids.length - MAX_LISTED} more`)
      const details = await Promise.all(ids.map(async (id) => [id, await getTaskDetail(root, id, deps.backendsFor(root), exec)] as const))
      const lang = deps.lang?.() ?? 'en'
      const riskLines = details.flatMap(([id, detail]) => !detail.verdict || (detail.verdict.kind === 'result' && !detail.verdict.caution) ? [] : [
        `• ${id} — ${detail.verdict.kind === 'result' ? hostT(lang, 'actions.accept.riskCaution') : hostT(lang, detail.verdict.kind === 'negative' ? 'actions.accept.riskNegative' : 'actions.accept.riskDisputed', { reason: verdictReason(lang, detail.verdict) })}`,
      ])
      // The orchestrator's check in the single dialog's words (vc1), grouped: checked, not checked yet, no check and why.
      const setting = repo?.orchestratorCheck
      const checkGroups = new Map<string, string[]>()
      for (const id of ids) {
        const t = byId.get(id)
        const check = t ? t.reviewCheck ?? (setting ? reviewCheckOf(t, setting) : undefined) : undefined
        if (!check) continue
        const key = check.state === 'off' ? `check.batch.off.${check.source}` : check.state === 'checked' ? 'check.batch.checked' : 'check.batch.unchecked'
        checkGroups.set(key, [...(checkGroups.get(key) ?? []), `• ${id} — ${t?.title ?? ''}`])
      }
      const checkText = ['check.batch.checked', 'check.batch.unchecked', ...[...checkGroups.keys()].filter((key) => key.startsWith('check.batch.off.'))]
        .flatMap((key) => checkGroups.get(key)?.length ? [hostT(lang, key, { lines: (checkGroups.get(key) ?? []).join('\n') })] : []).join('')
      // «1 clean, 9 at risk» (w1b, B03): the same rule the sheet uses to pre-select.
      const clean = details.filter(([id, detail]) => { const t = byId.get(id); return !!t && cleanToAccept(t, detail.verdict) }).length
      // A decision or a root task without the orchestrator's «done» (rt1) is named before anything is accepted.
      const uncheckedLines = ids.filter((id) => { const t = byId.get(id); return !!t && ownWorkUnchecked(t.kind, t.check) }).map((id) => `• ${id} — ${byId.get(id)?.title ?? ''}`)
      const looseLines: string[] = []
      for (const [id, detail] of details) {
        const count = detail.worktree ? await uncommittedCount(detail.worktree.path, exec) : undefined
        if (count) looseLines.push(`• ${id} — ${hostT(lang, 'actions.accept.batchUncommittedLine', { count })}`)
      }
      const question = hostT(lang, 'actions.accept.batch', { count: ids.length, clean, risky: ids.length - clean, lines: lines.join('\n') })
        + (riskLines.length ? hostT(lang, 'actions.accept.batchRisks', { lines: riskLines.join('\n') }) : '')
        + checkText
        + (uncheckedLines.length ? hostT(lang, 'actions.accept.batchUnchecked', { lines: uncheckedLines.join('\n') }) : '')
        + (looseLines.length ? hostT(lang, 'actions.accept.batchUncommitted', { lines: looseLines.join('\n') }) : '')
      if (!(await deps.native.confirm('crewboard', question, `${hostT(lang, 'actions.ok.accept')} ${ids.length}`, hostT(lang, 'actions.ok.cancel')))) throw declined()
      const verdicts = Object.fromEntries(details.map(([id, detail]) => [id, detail.verdict]))
      const evidence = Object.fromEntries(details.map(([id, detail]) => [id, detail.runs.at(-1)?.evidence]))
      const accepted = await acceptTasks(root, ids, deps.now(), verdicts, evidence)
      const cleanup = await gcAfterAccept(root, accepted, { exec, now: deps.now, policyPath: worktreeConfigPath(deps.env, deps.home) })
      return { accepted, removed: cleanup.removed }
    }),
    // wk1 (B29): `rerun` sends back and starts the next run at once — the previous run's worker unless the person
    // picked another; the reason reaches that run's prompt. Refusals come before anything is sent back.
    post('reject', async (b, root) => {
      const task = text(b.task, 'task')
      const reason = text(b.reason, 'reason')
      const lang = deps.lang?.() ?? 'en'
      const agent = typeof b.agent === 'string' && b.agent.trim() ? b.agent.trim() : undefined
      if (b.rerun !== true) {
        if (!(await deps.native.confirm('crewboard', hostT(lang, 'actions.reject', { task, reason }), hostT(lang, 'actions.ok.sendBack'), hostT(lang, 'actions.ok.cancel')))) throw declined()
        await rejectTask(root, task, reason, deps.now())
        return { task, status: 'rejected' }
      }
      const question = hostT(lang, 'actions.rejectRerun', { task, reason, worker: agent ?? hostT(lang, 'actions.rerunSameWorker') })
      if (!(await deps.native.confirm('crewboard', question, hostT(lang, 'actions.ok.sendBackRerun'), hostT(lang, 'actions.ok.cancel')))) throw declined()
      const run = await sendBackAndRerun({
        root,
        taskId: task,
        reason,
        ...(agent ? { agent } : {}),
        caller: callerOf({ kind: 'ui' }),
        backends: deps.backendsFor(root),
        exec,
        env: deps.env,
        home: deps.home,
        now: () => deps.now(),
        lang,
      })
      return { task, status: 'rejected', run }
    }),
    // w1f: human-only like reject — the native dialog is the person's confirmation; no agent tool reaches it.
    post('drop', async (b, root) => {
      const task = text(b.task, 'task')
      const reason = text(b.reason, 'reason')
      const lang = deps.lang?.() ?? 'en'
      if (!(await deps.native.confirm('crewboard', hostT(lang, 'actions.drop', { task, reason }), hostT(lang, 'actions.ok.drop'), hostT(lang, 'actions.ok.cancel')))) throw declined()
      await dropTask(root, task, reason, deps.now(), undefined, lang)
      return { task, status: 'dropped' }
    }),
    post('pos', async (b, root) => {
      const planId = text(b.planId, 'planId')
      if (typeof b.expectedRev !== 'number' || !Number.isInteger(b.expectedRev) || !Array.isArray(b.positions)) throw new HttpError(400, 'bad_request', 'expectedRev and positions are required')
      const positions = b.positions.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object') throw new HttpError(400, 'bad_request', 'invalid position entry')
        const item = entry as { task?: unknown; pos?: unknown }
        const task = text(item.task, 'task')
        if (item.pos === null) return { task, pos: null }
        if (!item.pos || typeof item.pos !== 'object') throw new HttpError(400, 'bad_request', 'pos must be {x, y} or null')
        const { x, y } = item.pos as { x?: unknown; y?: unknown }
        return { task, pos: { x: typeof x === 'number' ? x : Number.NaN, y: typeof y === 'number' ? y : Number.NaN } }
      })
      try {
        await setTaskPositions(root, planId, b.expectedRev, positions)
      } catch (err) {
        if (err instanceof PlanConflictError) throw new HttpError(409, 'stale_plan', 'Plan changed; refresh before saving positions')
        throw err
      }
      return null
    }),
    // Initialize a plan in a fresh workspace and return the snapshot so the panel can switch immediately.
    post('plan-init', async (b, root) => {
      const goal = text(b.goal, 'goal')
      try {
        await initPlan(root, goal, deps.now())
      } catch (err) {
        if (err instanceof PlanConflictError) throw new HttpError(409, 'plan_exists', `Plan already exists: ${planPath(root)}`)
        throw err
      }
      // A plan created from the panel hides from git the same way `orch init` hides it.
      await ensureGitExclude(root, exec).catch(() => {})
      await deps.service.refresh(root)
      const snapshot = deps.service.snapshot().repos.find((r) => r.root === root)
      if (!snapshot) throw new HttpError(500, 'internal', `No repository snapshot: ${root}`)
      return snapshot
    }),
    post('plan-new', async (b, root) => {
      const goal = text(b.goal, 'goal')
      const id = typeof b.plan === 'string' && b.plan.trim() ? b.plan.trim() : newPlanId(goal, deps.now())
      await createPlan(root, id, goal, deps.now())
      return { plan: id }
    }),
    get('plan-drafts', async (_q, root) => (await listDrafts(root)).map((draft) => ({ id: draft.id, goal: draft.goal, source: draft.source, taskCount: draft.tasks.length, findings: checkDraft(draft) }))),
    get('plan-draft', async (q, root) => {
      const draft = await loadDraft(root, text(q.get('id'), 'id'))
      return { draft, findings: checkDraft(draft) }
    }),
    post('plan-draft-approve', async (b, root) => {
      const id = text(b.id, 'id')
      const draft = await loadDraft(root, id)
      const lang = deps.lang?.() ?? 'en'
      // Refused before the confirmation: a cycle or a missing dependency cannot become a plan.
      if (checkDraft(draft).some(isBlocking)) throw new HttpError(422, 'draft_invalid', hostT(lang, 'actions.draftBlocked', { id }))
      if (!(await deps.native.confirm('crewboard', hostT(lang, 'actions.draftApprove', { id, count: draft.tasks.length }), hostT(lang, 'actions.draftApproveOk'), hostT(lang, 'actions.ok.cancel')))) throw declined()
      await approveDraft(root, id, deps.now(), lang)
      return { plan: id }
    }),
    post('plan-draft-discard', async (b, root) => { await discardDraft(root, text(b.id, 'id')); return null }),
    // Jobs that still need a person: running, refused (needs_repair) or failed. Asking advances them, so polling alone is enough.
    get('plan-draft-jobs', async (_q, root) => (await advanceDraftJobs(root, deps.backendsFor(root), deps.now(), exec)).filter((job) => job.status === 'running' || job.status === 'needs_repair' || job.status === 'failed').map(summarizeDraftJob)),
    get('plan-draft-job', async (q, root) => {
      const job = await loadDraftJob(root, text(q.get('id'), 'id'))
      const answer = await draftJobAnswer(root, job)
      return { job: summarizeDraftJob(job), ...(answer !== undefined ? { answer } : {}) }
    }),
    post('plan-draft-job-repair', async (b, root) => summarizeDraftJob(await retryDraftJob(root, text(b.id, 'id'), b.agent))),
    post('plan-draft-job-discard', async (b, root) => summarizeDraftJob(await discardDraftJob(root, text(b.id, 'id'), deps.backendsFor(root), deps.now(), exec))),
    // Opening an archived plan only shows it here: `current` stays with the CLI and the agents (B22).
    post('plan-use', async (b, root) => {
      await openPlan(root, text(b.plan, 'plan'))
      return null
    }),
    post('plan-archive', async (b, root) => {
      await setPlanArchived(root, text(b.plan, 'plan'), b.archived !== false)
      return null
    }),
    post('plan-rename', async (b, root) => {
      await renamePlan(root, text(b.plan, 'plan'), text(b.goal, 'goal'))
      return null
    }),
    post('workers-save', async (b) => {
      const routing = b.routing as Parameters<typeof saveRouting>[1]
      if (!routing || typeof routing !== 'object') throw new HttpError(400, 'bad_request', 'routing is required')
      await recoverWorkerDeletion(registryPath(deps.env, deps.home), profileStorePath(deps.env, deps.home))
      await saveRouting(profileStorePath(deps.env, deps.home), routing, deps.env, deps.home)
      return null
    }),
    post('chat-open', async (b, root) => {
      const sessions = deps.sessions?.()
      if (!sessions) throw new HttpError(503, 'chat_unavailable', 'Session control is unavailable in this dsh version')
      const plan = typeof b.plan === 'string' && b.plan.trim() ? b.plan.trim() : currentPlanId(root)
      const taskId = typeof b.taskId === 'string' && b.taskId.trim() ? b.taskId.trim() : undefined
      const prompt = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim().slice(0, 2000) : undefined
      // «From chat» names the goal before a plan exists (nb1); the plan is created with it, not as «New plan».
      const goal = typeof b.goal === 'string' && b.goal.trim() ? b.goal.trim().slice(0, 500) : undefined
      if (prompt && !(await loadPlan(root).catch(() => undefined))) await initPlan(root, goal ?? 'New plan', deps.now())
      const chat: ChatDeps = {
        sessions,
        now: deps.now,
        newId: deps.newId ?? (() => randomUUID()),
        ...(deps.readTask ? { readTask: deps.readTask } : {}),
        ...(deps.lang ? { lang: deps.lang } : {}),
      }
      return openChat(chat, { root, planId: plan, ...(taskId ? { taskId } : {}), ...(prompt ? { prompt } : {}) })
    }),
    // Bind the session the panel lives in
    // (openChat creates a new one — a different chat, which is exactly what this button must not do).
    post('chat-bind', async (b, root) => {
      const sessions = deps.sessions?.()
      if (!sessions) throw new HttpError(503, 'chat_unavailable', 'Session control is unavailable in this dsh version')
      const sessionId = text(b.sessionId, 'sessionId')
      const plan = typeof b.plan === 'string' && b.plan.trim() ? b.plan.trim() : currentPlanId(root)
      const chat: ChatDeps = {
        sessions,
        now: deps.now,
        newId: deps.newId ?? (() => randomUUID()),
        ...(deps.readTask ? { readTask: deps.readTask } : {}),
        ...(deps.lang ? { lang: deps.lang } : {}),
      }
      return bindChat(chat, { root, planId: plan, sessionId })
    }),
    post('chat-wake', async (b, root) => {
      if (!deps.sessions?.()) throw new HttpError(503, 'chat_unavailable', 'Session control is unavailable in this dsh version')
      if (typeof b.wake !== 'boolean') throw new HttpError(400, 'bad_request', 'wake must be a boolean')
      return setWake(root, text(b.plan, 'plan'), b.wake)
    }),
    post('chat-unbind', async (b, root) => unbindChat(root, text(b.plan, 'plan'))),
    post('plan-split', async (b, root) => {
      const sessions = deps.sessions?.()
      if (!sessions) throw new HttpError(503, 'chat_unavailable', 'Session control is unavailable in this dsh version')
      const from = text(b.from, 'from')
      const id = text(b.id, 'id')
      const goal = text(b.goal, 'goal')
      const tasks = batchIds(b.tasks)
      // Ensure dsh can create the new chat before changing either plan.
      const session = await sessions.create({ cwd: root })
      const result = await splitPlan(root, from, { id, goal, tasks })
      const chat: ChatDeps = { sessions, now: deps.now, newId: deps.newId ?? (() => randomUUID()), ...(deps.lang ? { lang: deps.lang } : {}) }
      await bindChat(chat, { root, planId: id, sessionId: session.sessionId })
      const child = await loadStoredPlan(root, id)
      const lines = child.tasks.map((task) => `• ${task.id} — ${task.title} (${task.status})`)
      const parent = await loadStoredPlan(root, from)
      const kept = parent.tasks.map((task) => task.id)
      const intro = [`New plan: ${goal}`, `It was split from plan “${from}”.`, 'Moved tasks:', ...lines, `Tasks remaining in the source plan: ${kept.length ? kept.join(', ') : 'none'}.`].join('\n')
      await sessions.prompt({ requestId: (deps.newId ?? randomUUID)(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: intro }] }, new AbortController().signal)
      return { ...result, plan: id, sessionId: session.sessionId }
    }),
  ]
  // Query routes are registered by prefix, so `/api/task` would also catch `/api/task-review` and
  // answer 404 for it: the longer path must be registered first.
  return routes.sort((a, b) => b.path.length - a.path.length)
}
