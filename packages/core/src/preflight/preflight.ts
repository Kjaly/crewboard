import type { Exec } from '../exec.js'
import { compareSemver } from '../util/semver.js'
import { type MessageVars, orchText } from '../orchestration/messages.js'

export type Backend = 'claude-code' | 'codex-cli' | 'devin-cli' | 'opencode' | 'grok-build' | 'gemini-cli' | 'dsh'
/** `minCliVersion` is the oldest CLI release that can run the model; absent means no version check. */
export type AgentProfile = { id: string; backend: Backend; model: string; enabled: boolean; minCliVersion?: string }
export type Check = { name: string; ok: boolean; detail: string; fix?: string }
export type PreflightResult = { agent: string; ok: boolean; checks: Check[] }
export type PreflightDeps = { exec: Exec; codexUsedPercent?: () => Promise<number | undefined>; lang?: 'en' | 'ru' }

const OPENCODE_MIN = '1.18.30'
const CODEX_QUOTA_LIMIT = 90
const PROVIDER_NAMES: Record<string, string> = { deepseek: 'DeepSeek', 'opencode-go': 'OpenCode Go', openai: 'OpenAI', xai: 'xAI' }

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes from CLI output
const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '')

export async function preflightAgent(profile: AgentProfile, deps: PreflightDeps, opts: { probe?: boolean } = {}): Promise<PreflightResult> {
  const checks: Check[] = []
  const tx = (key: string, vars?: MessageVars) => orchText(deps.lang, `preflight.${key}`, vars)
  const sh = (cmd: string, args: string[], timeoutMs = 20_000) => deps.exec(cmd, args, { timeoutMs })

  switch (profile.backend) {
    case 'claude-code': {
      const v = await sh('claude', ['--version'])
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
      const a = await sh('claude', ['auth', 'status'])
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
      const v = await sh('codex', ['--version'])
      checks.push({ name: 'binary', ok: v.code === 0, detail: v.stdout.trim() || tx('notFound'), fix: 'brew install --cask codex' })
      const used = await deps.codexUsedPercent?.()
      checks.push(
        used === undefined
          ? { name: 'quota', ok: true, detail: tx('quotaUnknown') }
          : { name: 'quota', ok: used < CODEX_QUOTA_LIMIT, detail: tx('quotaUsed', { used }), fix: tx('quotaFix') },
      )
      break
    }
    case 'devin-cli': {
      const v = await sh('devin', ['--version'])
      const version = /devin (\d+\.\d+\.\d+)/.exec(v.stdout)?.[1]
      checks.push({
        name: 'binary',
        ok: v.code === 0 && Boolean(version?.startsWith('3000.')),
        detail: version ? `devin ${version}` : tx('notFound'),
        fix: 'brew install --cask devin-cli',
      })
      const a = await sh('devin', ['auth', 'status'])
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
      const v = await sh('dsh', ['--version'])
      checks.push({ name: 'binary', ok: v.code === 0, detail: v.stdout.trim() || tx('notFound'), fix: 'npm i -g @deepseek-ai/dsh' })
      const p = await sh('dsh', ['--profile', 'acp', '--dump-config'], 60_000)
      checks.push({
        name: 'profile',
        ok: p.code === 0,
        detail: p.code === 0 ? tx('acpOk') : (p.stderr.trim().split('\n').at(-1) || tx('acpFailed')),
        fix: 'dsh --profile acp --dump-config',
      })
      break
    }
    default:
      checks.push({ name: 'backend', ok: false, detail: tx('unsupported', { backend: profile.backend }) })
  }
  return { agent: profile.id, ok: checks.every((c) => c.ok), checks }
}
