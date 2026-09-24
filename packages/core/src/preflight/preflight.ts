import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import { compareSemver } from '../util/semver.js'
import { type MessageVars, orchText } from '../orchestration/messages.js'

export type Backend = 'claude-code' | 'codex-cli' | 'devin-cli' | 'opencode' | 'grok-build' | 'gemini-cli' | 'dsh'
/** `minCliVersion` is the oldest CLI release that can run the model; absent means no version check. */
export type AgentProfile = { id: string; backend: Backend; model: string; enabled: boolean; minCliVersion?: string }
export type Check = { name: string; ok: boolean; detail: string; fix?: string }
export type PreflightResult = { agent: string; ok: boolean; checks: Check[] }
/** The binaries a launch runs (`CREWBOARD_<KIND>_COMMAND`); preflight checks the same ones. */
export type WorkerCommands = Partial<Record<'claude' | 'codex' | 'devin' | 'dsh', string>>
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

export async function preflightAgent(profile: AgentProfile, deps: PreflightDeps, opts: { probe?: boolean } = {}): Promise<PreflightResult> {
  const checks: Check[] = []
  const tx = (key: string, vars?: MessageVars) => orchText(deps.lang, `preflight.${key}`, vars)
  const sh = (cmd: string, args: string[], timeoutMs = 20_000) => deps.exec(cmd, args, { timeoutMs })
  const bin = (kind: keyof WorkerCommands) => deps.commands?.[kind] ?? kind

  switch (profile.backend) {
    case 'claude-code': {
      const v = await sh(bin('claude'), ['--version'])
      const versionText = (v.stdout || v.stderr).trim()
      checks.push({ name: 'binary', ok: v.code === 0, detail: versionText || tx('notFound'), fix: tx('installClaude') })
      const minimum = profile.minCliVersion
      if (minimum) {
        const version = /(\d+\.\d+\.\d+)/.exec(versionText)?.[1]
        const ok = version !== undefined && compareSemver(version, minimum) >= 0
        const vars = { version: version ?? '', minimum, model: profile.model }
        checks.push({
          name: 'version',
          ok,
          detail: tx(version === undefined ? 'versionUnknown' : ok ? 'versionOk' : 'versionOld', vars),
          fix: tx('updateClaude'),
        })
      }
      const a = await sh(bin('claude'), ['auth', 'status'])
      let loggedIn = false
      try {
        loggedIn = (JSON.parse(a.stdout) as { loggedIn?: boolean }).loggedIn === true
      } catch {
        loggedIn = false
      }
      checks.push({ name: 'auth', ok: loggedIn, detail: tx(loggedIn ? 'loggedIn' : 'loggedOut'), fix: 'claude auth login' })
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
      const v = await sh('opencode', ['--version'])
      const version = stripAnsi(v.stdout).trim()
      checks.push({
        name: 'binary',
        ok: v.code === 0 && compareSemver(version, OPENCODE_MIN) >= 0,
        detail: version || tx('notFound'),
        fix: tx('opencodeFix', { minimum: OPENCODE_MIN }),
      })
      const provider = profile.model.split('/')[0] ?? ''
      const name = PROVIDER_NAMES[provider] ?? provider
      const a = await sh('opencode', ['auth', 'list'])
      const connected = stripAnsi(a.stdout + a.stderr).toLowerCase().includes(name.toLowerCase())
      checks.push({
        name: 'auth',
        ok: connected,
        detail: tx(connected ? 'providerConnected' : 'providerMissing', { name }),
        fix: 'opencode auth login',
      })
      if (opts.probe) {
        const p = await sh('opencode', ['run', '-m', profile.model, 'Reply with exactly: PONG'], 90_000)
        const answered = /PONG/.test(p.stdout)
        checks.push({ name: 'probe', ok: answered, detail: tx(answered ? 'probeOk' : 'probeFailed'), fix: tx('probeFix') })
      }
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
      const key = await dshKeySource(deps.env ?? process.env, DSH_KEY_REF)
      checks.push({ name: 'key', ok: key !== undefined, detail: tx(key ? 'keyFound' : 'keyMissing', { ref: DSH_KEY_REF }), fix: tx('keyFix', { ref: DSH_KEY_REF }) })
      break
    }
    default:
      checks.push({ name: 'backend', ok: false, detail: tx('unsupported', { backend: profile.backend }) })
  }
  return { agent: profile.id, ok: checks.every((c) => c.ok), checks }
}
