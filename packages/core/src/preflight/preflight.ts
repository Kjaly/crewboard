import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import { compareSemver } from '../util/semver.js'
import { type MessageVars, orchText } from '../orchestration/messages.js'
import { EFFORT_LEVELS } from '../routing/effort.js'
import { ANTHROPIC_API_KEY_REF, CLAUDE_CODE_BARE_MIN, classifyAnthropicRoute, evaluateAnthropicLaunchPolicy } from '../routing/anthropic-policy.js'
import { anthropicPolicyText } from '../routing/anthropic-policy-text.js'
import { DSH_DEFAULT_PROVIDER, dshSelectionOf } from '../dsh/models.js'

export type Backend = 'claude-code' | 'codex-cli' | 'devin-cli' | 'opencode' | 'cursor-agent' | 'grok-build' | 'gemini-cli' | 'dsh'
/** `minCliVersion` is the oldest CLI release that can run the model; absent means no version check. */
/** `effort` (ef1): the effort the run is launched with; set only for a backend that takes one (routing/effort.ts). */
export type AgentProfile = { id: string; backend: Backend; model: string; enabled: boolean; minCliVersion?: string; effort?: string }
export type Check = { name: string; ok: boolean; detail: string; fix?: string }
export type PreflightResult = { agent: string; ok: boolean; checks: Check[] }
/** The binaries a launch runs (`CREWBOARD_<KIND>_COMMAND`); preflight checks the same ones. */
export type WorkerCommands = Partial<Record<'claude' | 'codex' | 'devin' | 'dsh' | 'opencode' | 'cursor' | 'gemini' | 'grok', string>>
/**
 * `env` is the environment the worker starts with: the dsh key check reads it (and `$DSH_HOME`, or
 * `~/.dsh` under its `HOME`). Absent, the current process's environment is used.
 */
export type PreflightDeps = { exec: Exec; codexUsedPercent?: () => Promise<number | undefined>; lang?: 'en' | 'ru'; env?: NodeJS.ProcessEnv; commands?: WorkerCommands }

const OPENCODE_MIN = '1.18.30'
const CODEX_QUOTA_LIMIT = 90
const PROVIDER_NAMES: Record<string, string> = { deepseek: 'DeepSeek', 'opencode-go': 'OpenCode Go', openai: 'OpenAI', xai: 'xAI' }

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes from CLI output
const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '')

/** dsh's DeepSeek route reads its key through this credential reference unless settings rename it. */
const DSH_KEY_REF = 'DEEPSEEK_API_KEY'

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2').trim()

/**
 * Where dsh resolves the key, in its own order: the launching environment, `$DSH_HOME/.credentials.yaml`
 * (`refs`, written by the web Models page), `$DSH_HOME/.env`. Only presence is checked — the value is
 * never shown; a wrong or unpaid key still surfaces on the run.
 */
async function dshKeySource(env: NodeJS.ProcessEnv, ref: string): Promise<'env' | 'file' | 'dotenv' | undefined> {
  if (env[ref]?.trim()) return 'env'
  const home = env.DSH_HOME?.trim() ? resolve(env.DSH_HOME.replace(/^~(?=$|\/)/, env.HOME ?? homedir())) : join(env.HOME ?? homedir(), '.dsh')
  const credentials = await readFile(join(home, '.credentials.yaml'), 'utf8').catch(() => '')
  const refLine = new RegExp(`^\\s+${ref}:(.*)$`)
  let inRefs = false
  for (const line of credentials.split('\n')) {
    if (/^\S/.test(line)) inRefs = /^refs:\s*$/.test(line)
    else if (inRefs && unquote(refLine.exec(line)?.[1] ?? '')) return 'file'
  }
  const dotenv = await readFile(join(home, '.env'), 'utf8').catch(() => '')
  const envLine = new RegExp(`^\\s*(?:export\\s+)?${ref}\\s*=(.*)$`)
  for (const line of dotenv.split('\n')) if (unquote(envLine.exec(line)?.[1] ?? '')) return 'dotenv'
  return undefined
}

/**
 * Gemini CLI has no auth-status subcommand — upstream registers only `mcp`, `extensions`, `skills`, `hooks` and
 * `gemma` under `gemini` (packages/cli/src/config/config.ts). Its documented credential stores are checked
 * instead (docs/get-started/authentication + upstream source): the API-key env vars a headless run itself reads,
 * `~/.gemini/.env`, `security.auth.selectedType` in `~/.gemini/settings.json` (written when a sign-in method is
 * picked, covering OAuth kept in the OS keychain), the `oauth_creds.json` file fallback of the token storage,
 * and `GOOGLE_APPLICATION_CREDENTIALS` / the gcloud ADC file for Vertex. Only presence is reported.
 */
async function geminiCredentialSource(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const ref of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) if (env[ref]?.trim()) return ref
  const home = env.HOME ?? homedir()
  const geminiDir = join(home, '.gemini')
  const dotenv = await readFile(join(geminiDir, '.env'), 'utf8').catch(() => '')
  if (/^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)\s*=\s*\S/m.test(dotenv)) return '~/.gemini/.env'
  const settings = await readFile(join(geminiDir, 'settings.json'), 'utf8').catch(() => '')
  try {
    const selected = (JSON.parse(settings) as { security?: { auth?: { selectedType?: unknown } } }).security?.auth?.selectedType
    if (typeof selected === 'string' && selected.trim()) return '~/.gemini/settings.json'
  } catch {
    // No readable settings file: keep looking.
  }
  if ((await readFile(join(geminiDir, 'oauth_creds.json'), 'utf8').catch(() => '')).trim()) return '~/.gemini/oauth_creds.json'
  if ((await readFile(join(home, '.config', 'gcloud', 'application_default_credentials.json'), 'utf8').catch(() => '')).trim()) return 'application_default_credentials.json'
  return undefined
}

const CLI_NAME: Partial<Record<Backend, string>> = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex', opencode: 'OpenCode', 'cursor-agent': 'Cursor Agent', 'gemini-cli': 'Gemini CLI', 'grok-build': 'Grok CLI' }

/**
 * The worker's effort against the levels its CLI accepts (ef1): a level the CLI would reject is refused here,
 * with a sentence, instead of failing the run. No effort — no check (the CLI's default).
 */
export function effortCheck(profile: AgentProfile, lang?: 'en' | 'ru'): Check | undefined {
  const levels = EFFORT_LEVELS[profile.backend]
  if (!profile.effort || !levels) return undefined
  const vars = { effort: profile.effort, cli: CLI_NAME[profile.backend] ?? profile.backend, levels: levels.join(', ') }
  const ok = levels.includes(profile.effort)
  return { name: 'effort', ok, detail: orchText(lang, ok ? 'preflight.effortOk' : 'preflight.effortUnsupported', vars), ...(ok ? {} : { fix: orchText(lang, 'preflight.effortFix', vars) }) }
}

export async function preflightAgent(profile: AgentProfile, deps: PreflightDeps, opts: { probe?: boolean } = {}): Promise<PreflightResult> {
  const checks: Check[] = []
  const tx = (key: string, vars?: MessageVars) => orchText(deps.lang, `preflight.${key}`, vars)
  const sh = (cmd: string, args: string[], timeoutMs = 20_000) => deps.exec(cmd, args, { timeoutMs })
  // The binary is `cursor-agent`, not `cursor` — the worker kind and the CLI's own name differ here alone.
  const bin = (kind: keyof WorkerCommands) => deps.commands?.[kind] ?? (kind === 'cursor' ? 'cursor-agent' : kind)

  const effort = effortCheck(profile, deps.lang)
  if (effort) checks.push(effort)

  // A worker that routes an Anthropic model through another harness (an opencode/dsh Anthropic model, an
  // imported profile) is outside the one supported channel: reported as unsupported configuration, not as a
  // provider ban. `claude-code` gets its own checks in the switch below.
  const routesAnthropic = classifyAnthropicRoute(profile, deps.env ?? process.env)
  if (routesAnthropic.applies && !routesAnthropic.allowed && profile.backend !== 'claude-code') {
    checks.push({ name: 'channel', ok: false, detail: anthropicPolicyText(deps.lang, routesAnthropic.code, routesAnthropic.vars), fix: tx('channelFix', { ref: ANTHROPIC_API_KEY_REF }) })
  }

  switch (profile.backend) {
    case 'claude-code': {
      const v = await sh(bin('claude'), ['--version'])
      const versionText = (v.stdout || v.stderr).trim()
      checks.push({ name: 'binary', ok: v.code === 0, detail: versionText || tx('notFound'), fix: tx('installClaude') })
      // The API-only route needs `--bare`, so the floor is the model's minimum raised by the policy floor.
      const announced = profile.minCliVersion
      const minimum = announced && compareSemver(announced, CLAUDE_CODE_BARE_MIN) > 0 ? announced : CLAUDE_CODE_BARE_MIN
      const version = /(\d+\.\d+\.\d+)/.exec(versionText)?.[1]
      const ok = version !== undefined && compareSemver(version, minimum) >= 0
      const vars = { version: version ?? '', minimum, model: profile.model }
      checks.push({
        name: 'version',
        ok,
        detail: tx(version === undefined ? 'versionUnknown' : ok ? 'versionOk' : 'versionOld', vars),
        fix: tx('updateClaude'),
      })
      // `--bare` never reads OAuth credentials or the OS keychain; an older CLI that lacks it cannot take the
      // API-only route. A live `--help` is a capability check, not a credential read.
      const h = await sh(bin('claude'), ['--help'])
      const helpText = stripAnsi(h.stdout + h.stderr)
      const bare = h.code === 0 && /(?:^|\s)--bare(?:\s|,|$)/m.test(helpText)
      checks.push({ name: 'bare', ok: bare, detail: tx(bare ? 'bareOk' : 'bareMissing'), fix: tx('updateClaude') })
      // The channel is decided from the environment alone — never from `claude auth status`, a billing label
      // or a mere `loggedIn` flag. `--bare` ignores persisted logins, so only an explicit key can authenticate.
      const decision = evaluateAnthropicLaunchPolicy(deps.env ?? process.env)
      checks.push({
        name: 'channel',
        ok: decision.allowed,
        detail: decision.allowed ? tx('channelOk', { ref: ANTHROPIC_API_KEY_REF }) : anthropicPolicyText(deps.lang, decision.code, decision.vars),
        fix: tx('channelFix', { ref: ANTHROPIC_API_KEY_REF }),
      })
      break
    }
    case 'codex-cli': {
      const v = await sh(bin('codex'), ['--version'])
      checks.push({ name: 'binary', ok: v.code === 0, detail: v.stdout.trim() || tx('notFound'), fix: 'brew install --cask codex' })
      // `codex login status` exits 0 with «Logged in using …» and 1 with «Not logged in».
      const a = await sh(bin('codex'), ['login', 'status'])
      const loginText = stripAnsi(a.stdout + a.stderr)
      const loggedIn = a.code === 0 && /logged in/i.test(loginText) && !/not logged in/i.test(loginText)
      checks.push({ name: 'auth', ok: loggedIn, detail: tx(loggedIn ? 'loggedIn' : 'loggedOut'), fix: 'codex login' })
      const used = await deps.codexUsedPercent?.()
      checks.push(
        used === undefined
          ? { name: 'quota', ok: true, detail: tx('quotaUnknown') }
          : { name: 'quota', ok: used < CODEX_QUOTA_LIMIT, detail: tx('quotaUsed', { used }), fix: tx('quotaFix') },
      )
      break
    }
    case 'devin-cli': {
      const v = await sh(bin('devin'), ['--version'])
      const version = /devin (\d+\.\d+\.\d+)/.exec(v.stdout)?.[1]
      checks.push({
        name: 'binary',
        ok: v.code === 0 && Boolean(version?.startsWith('3000.')),
        detail: version ? `devin ${version}` : tx('notFound'),
        fix: 'brew install --cask devin-cli',
      })
      const a = await sh(bin('devin'), ['auth', 'status'])
      const text = stripAnsi(a.stdout + a.stderr)
      const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text)
      checks.push({ name: 'auth', ok: loggedIn, detail: tx(loggedIn ? 'loggedIn' : 'loggedOut'), fix: 'devin auth login' })
      break
    }
    case 'opencode': {
      const v = await sh(bin('opencode'), ['--version'])
      const version = stripAnsi(v.stdout).trim()
      checks.push({
        name: 'binary',
        ok: v.code === 0 && compareSemver(version, OPENCODE_MIN) >= 0,
        detail: version || tx('notFound'),
        fix: tx('opencodeFix', { minimum: OPENCODE_MIN }),
      })
      const provider = profile.model.split('/')[0] ?? ''
      const name = PROVIDER_NAMES[provider] ?? provider
      const a = await sh(bin('opencode'), ['auth', 'list'])
      const connected = stripAnsi(a.stdout + a.stderr).toLowerCase().includes(name.toLowerCase())
      checks.push({
        name: 'auth',
        ok: connected,
        detail: tx(connected ? 'providerConnected' : 'providerMissing', { name }),
        fix: 'opencode auth login',
      })
      if (opts.probe) {
        const p = await sh(bin('opencode'), ['run', '-m', profile.model, 'Reply with exactly: PONG'], 90_000)
        const answered = /PONG/.test(p.stdout)
        checks.push({ name: 'probe', ok: answered, detail: tx(answered ? 'probeOk' : 'probeFailed'), fix: tx('probeFix') })
      }
      break
    }
    // rb1: the binary is `cursor-agent`; `status`/`whoami` prints "Not logged in" when signed out.
    case 'cursor-agent': {
      const v = await sh(bin('cursor'), ['--version'])
      checks.push({ name: 'binary', ok: v.code === 0, detail: stripAnsi(v.stdout).trim() || tx('notFound'), fix: tx('cursorFix') })
      const a = await sh(bin('cursor'), ['status'])
      const statusText = stripAnsi(a.stdout + a.stderr)
      const loggedIn = a.code === 0 && !/not logged in/i.test(statusText)
      checks.push({ name: 'auth', ok: loggedIn, detail: tx(loggedIn ? 'loggedIn' : 'loggedOut'), fix: 'cursor-agent login' })
      if (opts.probe) {
        const p = await sh(bin('cursor'), ['--print', '--output-format', 'text', 'Reply with exactly: PONG'], 90_000)
        const answered = /PONG/.test(p.stdout)
        checks.push({ name: 'probe', ok: answered, detail: tx(answered ? 'probeOk' : 'probeFailed'), fix: tx('probeFix') })
      }
      break
    }
    // rb1: neither Gemini CLI nor Grok CLI is installed on this machine — both cases are grounded in each
    // CLI's own docs and upstream source, not verified live.
    case 'gemini-cli': {
      // `--version` is documented (`-v`). No `gemini auth …` subcommand exists upstream — the auth check reads
      // the CLI's credential stores instead, and cannot be a hard blocker: an OAuth sign-in kept only in the
      // OS keychain (or credentials configured under a project/settings scope the check does not see) passes
      // here while a truly unsigned run still fails on its own with an auth error.
      const v = await sh(bin('gemini'), ['--version'])
      checks.push({ name: 'binary', ok: v.code === 0, detail: stripAnsi(v.stdout).trim() || tx('notFound'), fix: tx('geminiFix') })
      const source = await geminiCredentialSource(deps.env ?? process.env)
      checks.push({ name: 'auth', ok: true, detail: tx(source ? 'geminiCreds' : 'geminiAuthUnknown', source ? { source } : undefined), ...(source ? {} : { fix: tx('geminiSignIn') }) })
      break
    }
    case 'grok-build': {
      // `grok version` and `grok models` are the documented commands (docs.x.ai/build/cli/reference); `grok
      // models` is the auth probe — listing the account's models needs a login, so a failure is reported as
      // not signed in. Its exact signed-out wording is unverified: any auth-looking text also counts.
      const v = await sh(bin('grok'), ['version'])
      checks.push({ name: 'binary', ok: v.code === 0, detail: stripAnsi(v.stdout).trim() || tx('notFound'), fix: tx('grokFix') })
      const a = await sh(bin('grok'), ['models'])
      const statusText = stripAnsi(a.stdout + a.stderr)
      const loggedIn = a.code === 0 && !/not logged in|log ?in required|please (?:run |log ?in|sign ?in)|unauthori[sz]ed|unauthenticated|\b401\b/i.test(statusText)
      checks.push({ name: 'auth', ok: loggedIn, detail: tx(loggedIn ? 'loggedIn' : 'loggedOut'), fix: 'grok login' })
      break
    }
    case 'dsh': {
      const v = await sh(bin('dsh'), ['--version'])
      checks.push({ name: 'binary', ok: v.code === 0, detail: v.stdout.trim() || tx('notFound'), fix: 'npm i -g @deepseek-ai/dsh' })
      const p = await sh(bin('dsh'), ['--profile', 'acp', '--dump-config'], 60_000)
      checks.push({
        name: 'profile',
        ok: p.code === 0,
        detail: p.code === 0 ? tx('acpOk') : (p.stderr.trim().split('\n').at(-1) || tx('acpFailed')),
        fix: 'dsh --profile acp --dump-config',
      })
      // Only the DeepSeek route's key is known by name; another provider's key is dsh's alone (pv1), and a run shows its error.
      if (dshSelectionOf(profile.model).provider !== DSH_DEFAULT_PROVIDER) break
      const key = await dshKeySource(deps.env ?? process.env, DSH_KEY_REF)
      checks.push({ name: 'key', ok: key !== undefined, detail: tx(key ? 'keyFound' : 'keyMissing', { ref: DSH_KEY_REF }), fix: tx('keyFix', { ref: DSH_KEY_REF }) })
      break
    }
    default:
      checks.push({ name: 'backend', ok: false, detail: tx('unsupported', { backend: profile.backend }) })
  }
  return { agent: profile.id, ok: checks.every((c) => c.ok), checks }
}
