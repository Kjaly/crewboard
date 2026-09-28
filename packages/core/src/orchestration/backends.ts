import { createDevinBackend } from '../runs/devin-backend.js'
import { join } from 'node:path'
import { type DirectCliKind, type RunBackend, cliKindOf, cliModel, dshModel, isDshAgent } from '../backend/types.js'
import { dshBillRecordsPath } from '../cost/dsh-bill.js'
import { createDshBackend } from '../dsh/backend.js'
import { runDshRun } from '../dsh/runner.js'
import type { Exec } from '../exec.js'
import { CREWBOARD_DIR } from '../plan/store.js'
import type { AgentProfile, Backend, WorkerCommands } from '../preflight/preflight.js'
import { backendForTransport, loadProfileStore } from '../routing/profile-store.js'
import { PROFILE_ALIASES } from '../routing/identity.js'
import { defaultMinCliVersion, loadRegistry, registryPath } from '../routing/registry.js'
import { entryEffort, runEffort } from '../routing/effort.js'
import { createCliBackend } from '../runs/cli-backend.js'
import { runCliRun } from '../runs/cli-runner.js'
import { createLegacyRuns, LEGACY_RUN_ID } from '../runs/legacy-runs.js'
import { crewboardEnv } from '../env.js'

/** `<kind>/<model>` agent ids (backend/types.ts `cliKindOf`) to their preflight `Backend` name (rb1). */
const DIRECT_CLI_BACKEND: Record<DirectCliKind, Backend> = { claude: 'claude-code', codex: 'codex-cli', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build' }

export class BackendUnavailableError extends Error {
  constructor(message: string, readonly code = 'backend_unavailable') {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}
export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

export type Backends = {
  forAgent(agent: string, runId?: string): Promise<RunBackend>
}
export type BackendsOptions = { env: NodeJS.ProcessEnv; home: string; exec: Exec; root: string }

/**
 * The binaries a launch runs when `CREWBOARD_<KIND>_COMMAND` replaces one; preflight checks these, so the
 * check and the run look at the same program. A dsh or Devin command with its own `_ARGS` is a wrapper
 * whose arguments belong to the launch, not a CLI to ask for `--version`: preflight keeps the default then.
 */
export function workerCommands(env: NodeJS.ProcessEnv): WorkerCommands {
  const value = (name: string) => crewboardEnv(env, `CREWBOARD_${name}`)
  const claude = value('CLAUDE_COMMAND')
  const codex = value('CODEX_COMMAND')
  const opencode = value('OPENCODE_COMMAND')
  const cursor = value('CURSOR_COMMAND')
  const gemini = value('GEMINI_COMMAND')
  const grok = value('GROK_COMMAND')
  const devin = value('DEVIN_ARGS') === undefined ? value('DEVIN_COMMAND') : undefined
  const dsh = value('DSH_ARGS') === undefined ? value('DSH_COMMAND') : undefined
  return {
    ...(claude ? { claude } : {}),
    ...(codex ? { codex } : {}),
    ...(opencode ? { opencode } : {}),
    ...(cursor ? { cursor } : {}),
    ...(gemini ? { gemini } : {}),
    ...(grok ? { grok } : {}),
    ...(devin ? { devin } : {}),
    ...(dsh ? { dsh } : {}),
  }
}

export function createBackends(o: BackendsOptions): Backends {
  const value = (name: string) => crewboardEnv(o.env, `CREWBOARD_${name}`)
  const dshCommand = value('DSH_COMMAND')
  const dshArgs = value('DSH_ARGS')
  const dshRunner = value('DSH_RUNNER')
  const cliRunner = value('CLI_RUNNER')
  const claudeCommand = value('CLAUDE_COMMAND')
  const codexCommand = value('CODEX_COMMAND')
  const opencodeCommand = value('OPENCODE_COMMAND')
  const cursorCommand = value('CURSOR_COMMAND')
  const geminiCommand = value('GEMINI_COMMAND')
  const grokCommand = value('GROK_COMMAND')
  const devinCommand = value('DEVIN_COMMAND')
  const devinArgs = value('DEVIN_ARGS')
  const dsh = createDshBackend({
    runsRoot: join(o.root, CREWBOARD_DIR, 'runs'),
    billRecords: dshBillRecordsPath(o.env, o.home),
    ...(dshCommand ? { command: dshCommand, args: JSON.parse(dshArgs ?? '[]') as string[] } : {}),
    // Inline mode keeps the supervisor in this process (tests, debugging): a launch returns when the run ends.
    ...(dshRunner === 'inline' ? { startRunner: (args: Parameters<typeof runDshRun>[0]) => runDshRun(args) } : {}),
  })
  // Inline mode keeps the supervisor in this process (tests, debugging): the runner gets the same effective
  // environment the launch validated, never the ambient `process.env`.
  const inline = cliRunner === 'inline' ? { startRunner: (args: Parameters<typeof runCliRun>[0], env: NodeJS.ProcessEnv) => runCliRun(args, undefined, env) } : {}
  const profileOf = (agent: string) => resolveProfile(o.env, o.home, agent).catch(() => undefined)
  const cli = {
    claude: createCliBackend({ kind: 'claude', runsRoot: join(o.root, CREWBOARD_DIR, 'runs'), env: o.env, ...(claudeCommand ? { command: claudeCommand } : {}), ...inline, profileOf }),
    codex: createCliBackend({ kind: 'codex', runsRoot: join(o.root, CREWBOARD_DIR, 'runs'), env: o.env, ...(codexCommand ? { command: codexCommand } : {}), ...inline, profileOf }),
    opencode: createCliBackend({ kind: 'opencode', runsRoot: join(o.root, CREWBOARD_DIR, 'runs'), env: o.env, ...(opencodeCommand ? { command: opencodeCommand } : {}), ...inline, profileOf }),
    // The binary is `cursor-agent`, not `cursor` — the worker kind and the CLI's own name differ here alone.
    cursor: createCliBackend({ kind: 'cursor', runsRoot: join(o.root, CREWBOARD_DIR, 'runs'), env: o.env, command: cursorCommand ?? 'cursor-agent', ...inline, profileOf }),
    // rb1: Gemini's `--approval-mode plan` is docs-verified only — drafts get a detached worktree, not trust.
    gemini: createCliBackend({ kind: 'gemini', runsRoot: join(o.root, CREWBOARD_DIR, 'runs'), env: o.env, readOnlyLaunch: false, ...(geminiCommand ? { command: geminiCommand } : {}), ...inline, profileOf }),
    grok: createCliBackend({ kind: 'grok', runsRoot: join(o.root, CREWBOARD_DIR, 'runs'), env: o.env, ...(grokCommand ? { command: grokCommand } : {}), ...inline, profileOf }),
  }
  return {
    async forAgent(agent, runId) {
      if (runId && LEGACY_RUN_ID.test(runId)) return createLegacyRuns(o.env, o.home)
      // `devin/<model>` (pv1): a Devin worker added for one model; the model comes with the launch.
      if (agent === 'devin' || agent.startsWith('devin/')) return createDevinBackend({
        runsRoot: join(o.root, CREWBOARD_DIR, 'runs'),
        ...(devinCommand ? { command: devinCommand, commandArgs: JSON.parse(devinArgs ?? '[]') as string[] } : {}),
      })
      const kind = cliKindOf(PROFILE_ALIASES[agent] ?? agent)
      if (kind) return cli[kind]
      if (isDshAgent(agent)) return dsh
      throw new BackendUnavailableError(`Worker “${agent}” has no direct backend.`, 'backend_unavailable')
    },
  }
}

export async function resolveProfile(env: NodeJS.ProcessEnv, home: string, agent: string): Promise<AgentProfile> {
  // A saved alias (`claude-opus`) carries the direct entry's model and CLI minimum.
  const direct = PROFILE_ALIASES[agent] ?? agent
  const workers = (await loadRegistry(registryPath(env, home))).workers
  const registered = workers.find((worker) => worker.id === agent) ?? (direct === agent ? undefined : workers.find((worker) => worker.id === direct))
  if (registered) {
    // A Devin entry without a model (`devin`) takes its model from the Devin profile below.
    const backend =
      registered.kind === 'claude' ? 'claude-code'
      : registered.kind === 'codex' ? 'codex-cli'
      : registered.kind === 'opencode' ? 'opencode'
      : registered.kind === 'cursor' ? 'cursor-agent'
      : registered.kind === 'gemini' ? 'gemini-cli'
      : registered.kind === 'grok' ? 'grok-build'
      : registered.kind === 'dsh' ? 'dsh'
      : registered.kind === 'devin' && registered.model ? 'devin-cli'
      : undefined
    if (backend) {
      const model = registered.model ?? cliModel(agent) ?? dshModel(agent) ?? 'default'
      const minCliVersion = registered.minCliVersion ?? defaultMinCliVersion(registered.id, model)
      const effort = entryEffort(registered)
      return { id: agent, backend, model, enabled: true, ...(minCliVersion ? { minCliVersion } : {}), ...(effort ? { effort } : {}) }
    }
  }
  if (isDshAgent(agent)) return { id: agent, backend: 'dsh', model: dshModel(agent) ?? 'default', enabled: true }
  const kind = cliKindOf(agent)
  if (kind) {
    const model = cliModel(agent) ?? 'default'
    const minCliVersion = defaultMinCliVersion(direct, model)
    const backend = DIRECT_CLI_BACKEND[kind]
    return { id: agent, backend, model, enabled: true, ...(minCliVersion ? { minCliVersion } : {}) }
  }
  const store = await loadProfileStore(env, home)
  const profile = store.profiles[agent] ?? store.profiles[store.aliases[agent] ?? '']
  if (!profile) throw new ProfileError(`Worker profile “${agent}” was not found in ~/.config/crewboard/profiles.json.`)
  const backend = backendForTransport(profile.transport)
  const minCliVersion = backend === 'claude-code' ? defaultMinCliVersion(agent, profile.model) : undefined
  const effort = runEffort(backend, profile.effort)
  return { id: agent, backend, model: profile.model, enabled: profile.enabled, ...(minCliVersion ? { minCliVersion } : {}), ...(effort ? { effort } : {}) }
}
