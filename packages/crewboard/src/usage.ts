import { execFile } from 'node:child_process'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { claudeLimitsPath, crewboardEnv } from '@crewboard/core'
import { codexSessionsRoot } from './history/paths.js'
import type { AgentEntry, AgentIcon } from './workers/agents.js'

/** A subscription window: how much of it is used and when it starts over. */
export type UsageWindow = { minutes: number; usedPercent: number; resetsAt?: string; /** A limit for one model family only. */ model?: string }
export type UsageBalance = { currency: string; amount: number }
/**
 * What the owner can see of one provider's limits or money, without Crewboard storing anything. `no_data`: nothing to
 * read yet (`hint` says why); `no_key`: an API balance needs its key in the environment; `error`: the provider refused.
 */
export type ProviderUsage = {
  id: 'claude' | 'codex' | 'deepseek' | 'moonshot'
  label: string
  icon: AgentIcon
  state: 'ok' | 'no_data' | 'no_key' | 'error'
  plan?: string
  windows: UsageWindow[]
  balances: UsageBalance[]
  /** Credits or money ran out: the provider will refuse work. */
  exhausted?: boolean
  /** When the numbers were observed; a subscription read from a local log can be old. */
  at?: string
  hint?: string
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
/** Claude Code's stored sign-in as JSON (macOS Keychain or `~/.claude/.credentials.json`), or nothing. */
export type ReadCredentials = () => Promise<string | undefined>
export type UsageDeps = { env: NodeJS.ProcessEnv; agents: AgentEntry[]; fetch?: Fetch; home?: string; timeoutMs?: number; claudeCredentials?: ReadCredentials }

const PROVIDERS = {
  claude: { label: 'Claude', icon: 'claude' },
  codex: { label: 'Codex', icon: 'codex' },
  deepseek: { label: 'DeepSeek', icon: 'deepseek' },
  moonshot: { label: 'Kimi', icon: 'kimi' },
} as const satisfies Record<ProviderUsage['id'], { label: string; icon: AgentIcon }>

const base = (id: ProviderUsage['id']): ProviderUsage => ({ id, ...PROVIDERS[id], state: 'no_data', windows: [], balances: [] })
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
/** Epoch seconds or an ISO string, as Claude Code and Codex send them, to ISO. */
const when = (v: unknown): string | undefined => {
  const n = num(v)
  const d = n !== undefined ? new Date(n < 1e12 ? n * 1000 : n) : typeof v === 'string' ? new Date(v) : undefined
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined
}

/** The providers the owner's agents run on, in a fixed order. */
export function usedProviders(agents: AgentEntry[]): Array<ProviderUsage['id']> {
  const ids = new Set<ProviderUsage['id']>()
  for (const a of agents) {
    if (a.run === 'claude') ids.add('claude')
    else if (a.run === 'codex') ids.add('codex')
    else if (a.icon === 'deepseek') ids.add('deepseek')
    else if (a.icon === 'kimi' || a.icon === 'moonshot') ids.add('moonshot')
  }
  return (Object.keys(PROVIDERS) as Array<ProviderUsage['id']>).filter((id) => ids.has(id))
}

/** A file's tail, newest line first: Codex rollouts grow to megabytes and the newest numbers are at the end. */
async function tailLines(file: string, tailBytes = 512 * 1024): Promise<string[]> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    await handle.read(buf, 0, buf.length, start)
    return buf.toString('utf8').split('\n').reverse()
  } finally {
    await handle.close()
  }
}

/** The most recently written session files of Codex's last few `YYYY/MM/DD` folders: a session started yesterday may still be running. */
async function newestRollouts(root: string, count: number, days = 3): Promise<string[]> {
  const desc = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse()
  const dirs: string[] = []
  for (const y of await desc(root))
    for (const m of await desc(join(root, y)))
      for (const d of await desc(join(root, y, m))) {
        dirs.push(join(root, y, m, d))
        if (dirs.length >= days) break
      }
  const files = (await Promise.all(dirs.slice(0, days).map(async (dir) => (await desc(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))))).flat()
  const dated = await Promise.all(files.map(async (f) => ({ f, t: (await stat(f).catch(() => undefined))?.mtimeMs ?? 0 })))
  return dated.sort((a, b) => b.t - a.t).slice(0, count).map((x) => x.f)
}

type CodexCount = { timestamp?: string; payload?: { rate_limits?: Record<string, unknown> | null } }

/** The newest token count that carries limits: a half-written last line and counts without limits (an API-key login) are skipped. */
function latestLimits(lines: string[]): { row: CodexCount; limits: Record<string, unknown> } | undefined {
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue
    try {
      const row = JSON.parse(line) as CodexCount
      const limits = row.payload?.rate_limits
      if (limits && typeof limits === 'object') return { row, limits }
    } catch {
      // Half-written: an older line still holds good numbers.
    }
  }
  return undefined
}

/** Codex writes its plan's limits into each session's token counts; the most recently written session that has them wins. */
export async function codexUsage(env: NodeJS.ProcessEnv): Promise<ProviderUsage> {
  const out = base('codex')
  for (const file of await newestRollouts(codexSessionsRoot(env), 5)) {
    const found = latestLimits(await tailLines(file).catch(() => []))
    if (!found) continue
    const { row, limits } = found
    for (const key of ['primary', 'secondary']) {
      const w = limits[key] as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null | undefined
      const used = num(w?.used_percent)
      const minutes = num(w?.window_minutes)
      if (used === undefined || minutes === undefined) continue
      const resetsAt = when(w?.resets_at)
      out.windows.push({ minutes, usedPercent: used, ...(resetsAt ? { resetsAt } : {}) })
    }
    const credits = limits.credits as { has_credits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined
    const balance = num(credits?.balance)
    if (balance !== undefined && credits?.unlimited !== true) out.balances.push({ currency: 'credits', amount: balance })
    if (typeof limits.plan_type === 'string') out.plan = limits.plan_type
    if (limits.rate_limit_reached_type) out.exhausted = true
    if (row.timestamp) out.at = row.timestamp
    out.state = 'ok'
    return out
  }
  return { ...out, hint: 'codex_no_sessions' }
}

/**
 * Numbers from a local log describe the moment they were written. A window whose reset has passed is empty again,
 * and a limit reached in it no longer holds.
 */
export function settle(u: ProviderUsage, now: Date): ProviderUsage {
  const passed = (w: UsageWindow) => w.resetsAt !== undefined && new Date(w.resetsAt).getTime() <= now.getTime()
  if (!u.windows.some(passed)) return u
  const windows = u.windows.map((w) => (passed(w) ? { minutes: w.minutes, usedPercent: 0 } : w))
  const { exhausted: _gone, ...rest } = u
  return { ...rest, windows, ...(u.exhausted && windows.some((w) => w.usedPercent >= 100) ? { exhausted: true } : {}) }
}

/** Claude Code shows its plan's limits only to a status line; `crewboard statusline` (or a compatible script) logs them. */
const execFileP = promisify(execFile)

/**
 * Claude Code's own sign-in: `~/.claude/.credentials.json` where it writes one (Linux), else its macOS Keychain item.
 * Read for the one request below and never kept, logged or sent anywhere else.
 */
export const claudeCredentials = (home: string): ReadCredentials => async () => {
  const file = await readFile(join(home, '.claude', '.credentials.json'), 'utf8').catch(() => undefined)
  if (file) return file
  if (process.platform !== 'darwin') return undefined
  const r = await execFileP('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }).catch(() => undefined)
  return r?.stdout.trim() || undefined
}

const PLAN: Record<string, string> = { pro: 'Pro', max: 'Max', ultra: 'Ultra', team: 'Team', enterprise: 'Enterprise' }

/**
 * The limits the Claude app shows, from the endpoint Claude Code itself uses (`/api/oauth/usage`, not documented, so
 * any surprise falls back to the status line's log). The response holds percentages and reset times only.
 */
async function claudeFromAccount(d: UsageDeps, read: ReadCredentials): Promise<ProviderUsage | undefined> {
  let oauth: { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown } | undefined
  try {
    const raw = await read()
    oauth = raw ? (JSON.parse(raw) as { claudeAiOauth?: typeof oauth }).claudeAiOauth : undefined
  } catch {
    return undefined
  }
  if (typeof oauth?.accessToken !== 'string') return undefined
  // An expired token is Claude Code's to refresh; Crewboard never touches the refresh token.
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) return undefined
  const doFetch = d.fetch ?? (globalThis.fetch as unknown as Fetch)
  let body: Record<string, { utilization?: unknown; resets_at?: unknown } | null | undefined>
  try {
    const res = await doFetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }, signal: AbortSignal.timeout(d.timeoutMs ?? 5000) })
    if (!res.ok) return undefined
    body = (await res.json()) as typeof body
  } catch {
    return undefined
  }
  const out = base('claude')
  for (const [key, minutes, model] of [['five_hour', 300], ['seven_day', 10080], ['seven_day_opus', 10080, 'Opus'], ['seven_day_sonnet', 10080, 'Sonnet']] as const) {
    const used = num(body[key]?.utilization)
    if (used === undefined) continue
    const resetsAt = when(body[key]?.resets_at)
    out.windows.push({ minutes, usedPercent: used, ...(resetsAt ? { resetsAt } : {}), ...(model ? { model } : {}) })
  }
  if (!out.windows.length) return undefined
  const plan = typeof oauth.subscriptionType === 'string' ? (PLAN[oauth.subscriptionType.toLowerCase()] ?? oauth.subscriptionType) : undefined
  return { ...out, state: 'ok', at: new Date().toISOString(), ...(plan ? { plan } : {}) }
}

/** Claude's limits from the account first, else from what a status line logged; `CREWBOARD_CLAUDE_USAGE=log` reads only the log. */
export async function claudeUsage(d: UsageDeps, home: string): Promise<ProviderUsage> {
  const fromAccount = crewboardEnv(d.env, 'CLAUDE_USAGE') === 'log' ? undefined : await claudeFromAccount(d, d.claudeCredentials ?? claudeCredentials(home))
  return fromAccount ?? claudeFromLog(d.env, home)
}

async function claudeFromLog(env: NodeJS.ProcessEnv, home: string): Promise<ProviderUsage> {
  const out = base('claude')
  const raw = await readFile(claudeLimitsPath(env, home), 'utf8').catch(() => '')
  const line = raw.trimEnd().split('\n').findLast((l) => l.trim())
  if (!line) return { ...out, hint: 'claude_statusline' }
  try {
    const row = JSON.parse(line) as Record<string, unknown>
    for (const [key, minutes] of [['five_hour', 300], ['seven_day', 10080]] as const) {
      const used = num(row[key])
      if (used === undefined) continue
      const resetsAt = when(row[`${key}_resets_at`])
      out.windows.push({ minutes, usedPercent: used, ...(resetsAt ? { resetsAt } : {}) })
    }
    if (typeof row.ts === 'string') out.at = row.ts
    return out.windows.length ? { ...out, state: 'ok' } : { ...out, hint: 'claude_statusline' }
  } catch {
    return { ...out, hint: 'claude_statusline' }
  }
}

/** A provider's API root from its usual `*_BASE_URL` (an OpenAI-style one may end in `/v1`), else the default. */
const apiRoot = (value: string | undefined, fallback: string): string => (value?.trim() || fallback).replace(/\/+$/, '').replace(/\/v1$/, '')

async function askBalance(d: UsageDeps, url: string, key: string): Promise<{ body?: unknown; error?: string }> {
  const doFetch = d.fetch ?? (globalThis.fetch as unknown as Fetch)
  try {
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(d.timeoutMs ?? 5000) })
    // Only the status reaches the screen: a provider's error body may echo the request.
    if (!res.ok) return { error: res.status === 401 || res.status === 403 ? 'key_refused' : `http_${res.status}` }
    return { body: await res.json() }
  } catch (error) {
    return { error: (error as Error).name === 'TimeoutError' ? 'timeout' : 'network' }
  }
}

/** DeepSeek's balance (`GET /user/balance`, under `DEEPSEEK_BASE_URL` when set), one row per currency. */
export async function deepseekUsage(d: UsageDeps): Promise<ProviderUsage> {
  const out = base('deepseek')
  const key = d.env.DEEPSEEK_API_KEY
  if (!key) return { ...out, state: 'no_key', hint: 'DEEPSEEK_API_KEY' }
  const r = await askBalance(d, `${apiRoot(d.env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com')}/user/balance`, key)
  if (r.error) return { ...out, state: 'error', hint: r.error }
  const body = r.body as { is_available?: unknown; balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }> }
  if (!Array.isArray(body.balance_infos)) return { ...out, state: 'error', hint: 'unreadable' }
  for (const b of body.balance_infos) {
    const amount = num(b.total_balance)
    if (typeof b.currency === 'string' && amount !== undefined) out.balances.push({ currency: b.currency, amount })
  }
  return { ...out, state: 'ok', at: new Date().toISOString(), ...(body.is_available === false ? { exhausted: true } : {}) }
}

/** Kimi's balance (`GET /v1/users/me/balance`): USD on api.moonshot.ai, CNY on api.moonshot.cn (`MOONSHOT_BASE_URL`). */
export async function moonshotUsage(d: UsageDeps): Promise<ProviderUsage> {
  const out = base('moonshot')
  const key = d.env.MOONSHOT_API_KEY
  if (!key) return { ...out, state: 'no_key', hint: 'MOONSHOT_API_KEY' }
  const root = apiRoot(d.env.MOONSHOT_BASE_URL, 'https://api.moonshot.ai')
  const cn = /\.cn$/.test(new URL(root).hostname)
  const r = await askBalance(d, `${root}/v1/users/me/balance`, key)
  if (r.error) return { ...out, state: 'error', hint: r.error }
  const amount = num((r.body as { data?: { available_balance?: unknown } }).data?.available_balance)
  if (amount === undefined) return { ...out, state: 'error', hint: 'unreadable' }
  return { ...out, state: 'ok', balances: [{ currency: cn ? 'CNY' : 'USD', amount }], at: new Date().toISOString(), ...(amount <= 0 ? { exhausted: true } : {}) }
}

/** Every provider the owner's agents use, each read independently: one slow or failing provider does not hide the others. */
export async function readUsage(d: UsageDeps): Promise<ProviderUsage[]> {
  if (crewboardEnv(d.env, 'NO_USAGE')) return []
  const home = d.home ?? homedir()
  const read: Record<ProviderUsage['id'], () => Promise<ProviderUsage>> = {
    claude: () => claudeUsage(d, home),
    codex: () => codexUsage(d.env),
    deepseek: () => deepseekUsage(d),
    moonshot: () => moonshotUsage(d),
  }
  const now = new Date()
  return Promise.all(usedProviders(d.agents).map((id) => read[id]().then((u) => settle(u, now), () => ({ ...base(id), state: 'error' as const, hint: 'unreadable' }))))
}
