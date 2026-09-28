import { cliKindOf, isDshAgent } from '../backend/types.js'
import { dshSelectionOf, dshSelectionOfId, dshWorkerId, sameDshSelection, type DshSelection } from '../dsh/models.js'
import { runEffort } from './effort.js'
import { backendForTransport, type Transport } from './profile-store.js'
import type { WorkerEntry, WorkerKind } from './registry.js'

/**
 * Where Settings → Workers and `crewboard workers` list a worker (wo1): under its subscription CLI, under dsh
 * (API through dsh's own keys), or in «Other / imported». The section follows the transport a run would use —
 * never an id prefix — so a Gemini CLI or Grok CLI profile is a CLI of its own, not «API».
 */
export type WorkerSection = 'subscription' | 'dsh' | 'other'
/** A subscription CLI block: the Crewboard launches, plus the CLIs an older tool's profiles name. */
export type SubscriptionCli = 'claude' | 'codex' | 'devin' | 'opencode' | 'cursor' | 'gemini' | 'grok'
/** Why a worker sits in «Other / imported»: a copy of another worker, an older tool's profile, or an id nothing defines. */
export type OtherReason = 'duplicate' | 'imported' | 'stale'
export type WorkerPlacement = { section: WorkerSection; cli?: SubscriptionCli; other?: OtherReason; duplicateOf?: string }

export const SUBSCRIPTION_CLIS: readonly SubscriptionCli[] = ['claude', 'codex', 'devin', 'opencode', 'cursor', 'gemini', 'grok']
/** How each subscription CLI is named where workers are listed. */
export const CLI_NAMES: Record<SubscriptionCli, string> = { claude: 'Claude', codex: 'Codex', devin: 'Devin', opencode: 'OpenCode', cursor: 'Cursor Agent', gemini: 'Gemini CLI', grok: 'Grok CLI' }
/**
 * wo2: the transports a runner backend exists for (`orchestration/backends.ts` `forAgent`). A runner added there
 * is added here, and every «Crewboard does not run tasks on X yet» state — the screen's note, the missing Enabled
 * switch, the pickers, `crewboard workers` — follows from this one set, never from a CLI's name. rb1 adds the
 * OpenCode, Cursor Agent, Gemini CLI and Grok CLI transports: every subscription CLI now has a runner.
 */
const RUNNER_TRANSPORTS: ReadonlySet<Transport> = new Set<Transport>(['dsh', 'claude-cli', 'codex-cli', 'devin-acp', 'opencode', 'cursor-agent', 'gemini-cli', 'grok-build'])
export const hasRunner = (transport: Transport): boolean => RUNNER_TRANSPORTS.has(transport)
export const CLI_OF_TRANSPORT: Partial<Record<Transport, SubscriptionCli>> = { 'claude-cli': 'claude', 'codex-cli': 'codex', 'devin-acp': 'devin', opencode: 'opencode', 'cursor-agent': 'cursor', 'gemini-cli': 'gemini', 'grok-build': 'grok' }
/** Whether Crewboard can run tasks on this subscription CLI: a runner backend exists for its transport. */
export const cliRuns = (cli: SubscriptionCli): boolean => Object.entries(CLI_OF_TRANSPORT).some(([transport, of]) => of === cli && hasRunner(transport as Transport))
const KIND_TRANSPORT: Partial<Record<WorkerKind, Transport>> = { dsh: 'dsh', claude: 'claude-cli', codex: 'codex-cli', devin: 'devin-acp', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build' }

/** How a worker is billed, by its transport: API through dsh, the API-only Claude route, or a subscription CLI. */
export type WorkerBilling = 'subscription' | 'api-dsh' | 'api-claude' | 'other'
export const billingOfTransport = (transport: Transport | undefined): WorkerBilling =>
  !transport ? 'other' : transport === 'dsh' ? 'api-dsh' : transport === 'claude-cli' ? 'api-claude' : 'subscription'

/**
 * The transport a run of this id uses, resolved as a launch resolves it: the registry entry, else the saved
 * profile, else the ids the launcher itself knows (`claude/…`, `codex/…`, `dsh/…`, `devin`). Anything else is
 * an id nothing on this machine defines.
 */
export function workerTransport(id: string, entry?: Pick<WorkerEntry, 'kind' | 'transport'>, profile?: { transport: Transport }): Transport | undefined {
  if (entry) return entry.transport ?? KIND_TRANSPORT[entry.kind]
  if (profile) return profile.transport
  if (isDshAgent(id)) return 'dsh'
  const cli = cliKindOf(id)
  if (cli) return KIND_TRANSPORT[cli]
  return id === 'devin' ? 'devin-acp' : undefined
}

/** One worker as the placement sees it: what it runs, and how it got here. */
export type WorkerFacts = {
  id: string
  transport?: Transport
  model?: string
  effort?: string
  /** A `workers.json` entry — the person added it (or it is a built-in default). */
  registered?: boolean
  /** `origin: 'porch-import'` (rq1). */
  imported?: boolean
  /** A routing class, a saved preset or a switch names it. */
  referenced?: boolean
  /** A model of dsh's catalog with no registry entry of its own. */
  catalog?: boolean
}

/** The model a worker runs, normalised so two spellings of one dsh model compare equal. */
const modelKey = (facts: WorkerFacts): string => {
  if (facts.transport !== 'dsh') return (facts.model ?? '').trim()
  const selection = facts.model ? dshSelectionOf(facts.model) : dshSelectionOfId(facts.id)
  return selection ? `${selection.provider}/${selection.model}` : ''
}

/** Two workers are one when they run the same transport, model and effort — whatever their ids say. */
export const duplicateKey = (facts: WorkerFacts): string | undefined => {
  if (!facts.transport) return undefined
  const effort = runEffort(backendForTransport(facts.transport), facts.effort) ?? ''
  return `${facts.transport}\u0000${modelKey(facts)}\u0000${effort}`
}

/** Which copy of a duplicate group stays: a registered one, then one not imported, then one in use, then the first. */
const rank = (facts: WorkerFacts): number => (facts.registered ? 4 : 0) + (facts.imported ? 0 : 2) + (facts.referenced ? 1 : 0)

/**
 * Places every worker in exactly one section. Duplicates (by transport, model and effort) keep their best copy
 * in place and move the rest to «Other»; an older tool's profile nothing uses waits there until the person adds
 * it as a worker; an id without a transport is stale.
 */
export function placeWorkers(workers: readonly WorkerFacts[]): Map<string, WorkerPlacement> {
  const keep = new Map<string, WorkerFacts>()
  for (const facts of workers) {
    const key = duplicateKey(facts)
    if (key === undefined) continue
    const current = keep.get(key)
    if (!current || rank(facts) > rank(current)) keep.set(key, facts)
  }
  const placed = new Map<string, WorkerPlacement>()
  for (const facts of workers) {
    const key = duplicateKey(facts)
    if (key === undefined || !facts.transport) {
      placed.set(facts.id, { section: 'other', other: 'stale' })
      continue
    }
    const kept = keep.get(key)
    if (kept && kept.id !== facts.id) {
      placed.set(facts.id, { section: 'other', other: 'duplicate', duplicateOf: kept.id })
      continue
    }
    if (facts.imported && !facts.referenced) {
      placed.set(facts.id, { section: 'other', other: 'imported' })
      continue
    }
    const cli = CLI_OF_TRANSPORT[facts.transport]
    placed.set(facts.id, facts.transport === 'dsh' || !cli ? { section: 'dsh' } : { section: 'subscription', cli })
  }
  return placed
}

/** The provider and model a registry dsh entry runs: its `model` field, else its id. */
export const dshEntrySelection = (entry: Pick<WorkerEntry, 'id' | 'kind' | 'model'>): DshSelection | undefined =>
  entry.kind !== 'dsh' ? undefined : entry.model ? dshSelectionOf(entry.model) : dshSelectionOfId(entry.id)

export type ProfileFacts = { id: string; transport: Transport; model?: string; effort?: string; origin?: string }

/**
 * Every worker the screen and `crewboard workers` list, once, in order: registry entries, dsh's catalog models
 * (when the host has the catalog), saved profiles and ids the lists name. A saved alias (`aliases`) folds into
 * its direct worker and counts as a use of it.
 */
export function collectWorkerFacts(input: { registry: readonly WorkerEntry[]; profiles: readonly ProfileFacts[]; referenced: Iterable<string>; catalog?: ReadonlyArray<{ provider: string; model: string }>; aliases?: Record<string, string> }): WorkerFacts[] {
  const aliases = input.aliases ?? {}
  const referenced = new Set(input.referenced)
  const isReferenced = (id: string) => referenced.has(id) || Object.entries(aliases).some(([alias, target]) => target === id && referenced.has(alias))
  const profiles = new Map(input.profiles.map((profile) => [profile.id, profile]))
  const facts: WorkerFacts[] = []
  const seen = new Set<string>()
  const push = (item: WorkerFacts) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    facts.push(item)
  }
  for (const entry of input.registry) {
    push({ id: entry.id, transport: workerTransport(entry.id, entry), ...(entry.model ? { model: entry.model } : {}), ...(entry.effort ? { effort: entry.effort } : {}), registered: true, imported: profiles.get(entry.id)?.origin === 'porch-import', referenced: isReferenced(entry.id) })
  }
  for (const selection of input.catalog ?? []) {
    if (input.registry.some((entry) => sameDshSelection(dshEntrySelection(entry), selection))) continue
    const id = dshWorkerId(selection.provider, selection.model)
    push({ id, transport: 'dsh', model: `${selection.provider}/${selection.model}`, referenced: isReferenced(id), catalog: true })
  }
  for (const profile of input.profiles) {
    if (aliases[profile.id]) continue
    push({ id: profile.id, transport: profile.transport, ...(profile.model ? { model: profile.model } : {}), ...(profile.effort ? { effort: profile.effort } : {}), imported: profile.origin === 'porch-import', referenced: isReferenced(profile.id) })
  }
  for (const id of referenced) {
    if (aliases[id]) continue
    const transport = workerTransport(id)
    push({ id, ...(transport ? { transport } : {}), referenced: true })
  }
  return facts
}
