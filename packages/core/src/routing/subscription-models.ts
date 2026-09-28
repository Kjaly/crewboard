import type { Exec } from '../exec.js'
import type { WorkerCommands } from '../preflight/preflight.js'
import { EFFORT_LEVELS } from './effort.js'
import { saveWorkerProfile } from './profile-store.js'
import { loadRegistry, saveWorker, type WorkerEntry } from './registry.js'

/**
 * The models a signed-in subscription CLI offers (pv1), so a person adds workers by picking them instead of
 * typing ids. Each source is the CLI's own, read without spending anything:
 * - Codex: `codex debug models --bundled` — the catalog shipped with the binary, no network;
 * - Devin: `devin models list --format json` — the models of the signed-in account;
 * - OpenCode: `opencode models` — one `provider/model` id per line, live-verified (1.18.30);
 * - Cursor Agent: `cursor-agent --list-models` — plain output, checked against `--help` only (not signed in here);
 * - Claude Code and Gemini CLI have no listing command (`claude --help` only takes `--model <alias|full name>`;
 *   Gemini CLI's documented `--model` values are its aliases); Grok CLI documents `grok models`, but its output
 *   format is unverified on an installed CLI (none installed here), so all three keep built-in lists that move
 *   with Crewboard releases.
 */
export type SubscriptionKind = 'claude' | 'codex' | 'devin' | 'opencode' | 'cursor' | 'gemini' | 'grok'
export type SubscriptionModel = { model: string; label: string; efforts: string[]; defaultEffort?: string }
export type SubscriptionModels = { kind: SubscriptionKind; models: SubscriptionModel[]; source: 'builtin' | 'cli' }

export const SUBSCRIPTION_KINDS: readonly SubscriptionKind[] = ['claude', 'codex', 'devin', 'opencode', 'cursor', 'gemini', 'grok']
export const isSubscriptionKind = (value: unknown): value is SubscriptionKind => SUBSCRIPTION_KINDS.includes(value as SubscriptionKind)

const CLAUDE_EFFORTS = [...(EFFORT_LEVELS['claude-code'] ?? [])]
export const CLAUDE_MODELS: SubscriptionModel[] = [
  { model: 'claude-fable-5-1', label: 'Claude Fable 5.1', efforts: CLAUDE_EFFORTS },
  { model: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: CLAUDE_EFFORTS },
  { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: CLAUDE_EFFORTS },
  { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', efforts: CLAUDE_EFFORTS },
]

/**
 * No listing command verified on an installed CLI (rb1); move with Crewboard releases, like `CLAUDE_MODELS`.
 * Gemini's are the documented `--model` aliases (google-gemini/gemini-cli `docs/cli/cli-reference.md`, model
 * selection) — `auto` is the CLI's own default — not concrete version slugs, which change with each release.
 */
const GEMINI_MODELS: SubscriptionModel[] = [
  { model: 'auto', label: 'Gemini auto (default)', efforts: [] },
  { model: 'pro', label: 'Gemini pro', efforts: [] },
  { model: 'flash', label: 'Gemini flash', efforts: [] },
  { model: 'flash-lite', label: 'Gemini flash-lite', efforts: [] },
]
const GROK_EFFORTS = [...(EFFORT_LEVELS['grok-build'] ?? [])]
const GROK_MODELS: SubscriptionModel[] = [{ model: 'grok-4.7', label: 'Grok 4.7', efforts: GROK_EFFORTS }]

export class SubscriptionModelsError extends Error {
  constructor(
    readonly code: 'cli_failed' | 'bad_output',
    message: string,
  ) {
    super(message)
    this.name = 'SubscriptionModelsError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** `codex debug models --bundled`: the models Codex lists in its picker (`visibility: "list"`), with the efforts each takes. */
export function parseCodexModels(stdout: string): SubscriptionModel[] {
  const raw = JSON.parse(stdout) as unknown
  const list = isRecord(raw) && Array.isArray(raw.models) ? raw.models : Array.isArray(raw) ? raw : undefined
  if (!list) throw new SubscriptionModelsError('bad_output', 'codex debug models: no "models" list')
  return list.flatMap((item) => {
    const slug = isRecord(item) ? str(item.slug) : undefined
    if (!slug || !isRecord(item) || (item.visibility !== undefined && item.visibility !== 'list')) return []
    const efforts = (Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : []).flatMap((level) => {
      const effort = isRecord(level) ? str(level.effort) : undefined
      return effort ? [effort] : []
    })
    const defaultEffort = str(item.default_reasoning_level)
    return [{ model: slug, label: `Codex ${str(item.display_name) ?? slug}`, efforts, ...(defaultEffort ? { defaultEffort } : {}) }]
  })
}

/** `devin models list --format json`: every variant of every family; Devin takes no effort (a variant is one). */
export function parseDevinModels(stdout: string): SubscriptionModel[] {
  const raw = JSON.parse(stdout) as unknown
  if (!isRecord(raw) || !Array.isArray(raw.families)) throw new SubscriptionModelsError('bad_output', 'devin models list: no "families" list')
  return raw.families.flatMap((family) =>
    (isRecord(family) && Array.isArray(family.variants) ? family.variants : []).flatMap((variant) => {
      const uid = isRecord(variant) ? str(variant.model_uid) : undefined
      return uid && isRecord(variant) ? [{ model: uid, label: `Devin ${str(variant.label) ?? uid}`, efforts: [] }] : []
    }),
  )
}

/** OpenCode `models [provider]` and Cursor Agent `--list-models`: one `provider/model` id (or bare model id) per line. */
export function parseLineModels(stdout: string, cli: string): SubscriptionModel[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && /^[\w.-]+(?:\/[\w.-]+)?$/.test(l))
  return lines.map((model) => ({ model, label: `${cli} ${model}`, efforts: [] }))
}

const NO_EFFORT_KINDS: readonly SubscriptionKind[] = ['devin', 'cursor', 'gemini']
export type SubscriptionModelsDeps = { exec: Exec; env?: NodeJS.ProcessEnv; commands?: WorkerCommands }

const CLI_ARGS: Partial<Record<SubscriptionKind, string[]>> = {
  codex: ['debug', 'models', '--bundled'],
  devin: ['models', 'list', '--format', 'json'],
  opencode: ['models'],
  cursor: ['--list-models'],
}

export async function listSubscriptionModels(kind: SubscriptionKind, deps: SubscriptionModelsDeps): Promise<SubscriptionModels> {
  if (kind === 'claude') return { kind, models: CLAUDE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })), source: 'builtin' }
  if (kind === 'gemini') return { kind, models: GEMINI_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })), source: 'builtin' }
  if (kind === 'grok') return { kind, models: GROK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })), source: 'builtin' }
  const bin = deps.commands?.[kind] ?? (kind === 'cursor' ? 'cursor-agent' : kind)
  const args = CLI_ARGS[kind] ?? []
  const result = await deps.exec(bin, args, { timeoutMs: 30_000, ...(deps.env ? { env: deps.env } : {}) })
  if (result.code !== 0) throw new SubscriptionModelsError('cli_failed', `${bin} ${args.join(' ')}: ${(result.stderr || result.stdout).trim().split('\n').at(-1) || `exit ${result.code}`}`)
  try {
    const models = kind === 'codex' ? parseCodexModels(result.stdout) : kind === 'devin' ? parseDevinModels(result.stdout) : parseLineModels(result.stdout, kind === 'opencode' ? 'OpenCode' : 'Cursor')
    return { kind, models, source: 'cli' }
  } catch (error) {
    if (error instanceof SubscriptionModelsError) throw error
    throw new SubscriptionModelsError('bad_output', `${bin} ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The id `crewboard workers add` examples use: `claude/sonnet-5-high` for `claude-sonnet-5` at `high`. */
export function subscriptionWorkerId(kind: SubscriptionKind, model: string, effort?: string): string {
  const short = kind === 'claude' ? model.replace(/^claude-/, '') : model
  return `${kind}/${short}${effort ? `-${effort}` : ''}`
}

/** One worker per model and effort; a model without efforts (Devin, Cursor Agent, Gemini CLI), or no effort chosen, gets one worker at the CLI's default. */
export function subscriptionEntries(kind: SubscriptionKind, models: Array<Pick<SubscriptionModel, 'model' | 'label'>>, efforts: string[] = []): WorkerEntry[] {
  const levels = NO_EFFORT_KINDS.includes(kind) ? [undefined] : efforts.length ? efforts : [undefined]
  return models.flatMap(({ model, label }) =>
    levels.map((effort) => ({
      id: subscriptionWorkerId(kind, model, effort),
      kind,
      model,
      label,
      ...(effort ? { effort } : {}),
      billing: kind === 'devin' ? ('промо' as const) : ('подписка' as const),
    })),
  )
}

/**
 * Registers the workers the way `crewboard workers add` does (profile + registry). A worker id that already
 * exists is left as it is, so a name the person changed survives adding the same model again.
 */
export async function addSubscriptionWorkers(env: NodeJS.ProcessEnv, home: string, registryFile: string, entries: WorkerEntry[]): Promise<{ added: string[]; existing: string[] }> {
  const present = new Set((await loadRegistry(registryFile)).workers.map((w) => w.id))
  const added: string[] = []
  const existing: string[] = []
  for (const entry of entries) {
    if (present.has(entry.id)) {
      existing.push(entry.id)
      continue
    }
    await saveWorkerProfile(env, home, entry)
    await saveWorker(registryFile, entry)
    present.add(entry.id)
    added.push(entry.id)
  }
  return { added, existing }
}
