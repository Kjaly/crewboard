import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '../src/workers/agents.js'
import { readUsage } from '../src/usage.js'
import { statusline } from '../src/statusline.js'

const KEY = 'sk-test-secret'
const signedOut = async () => undefined
const reply = (status: number, body: unknown) => async () => ({ ok: status < 400, status, json: async () => body })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cb-usage-'))
  const sessions = join(dir, 'sessions', '2026', '11', '03')
  await mkdir(sessions, { recursive: true })
  const env = { CREWBOARD_CODEX_SESSIONS: join(dir, 'sessions'), CREWBOARD_CLAUDE_LIMITS: join(dir, 'limits.jsonl') } as NodeJS.ProcessEnv
  return { dir, sessions, env }
}

describe('provider usage', () => {
  it('reads the Codex plan limits from the newest session and the Claude limits the status line logged', async () => {
    const { sessions, env } = await setup()
    const limits = { primary: { used_percent: 13, window_minutes: 10080, resets_at: 4102444800 }, secondary: null, credits: { has_credits: true, unlimited: false, balance: '23174.86' }, plan_type: 'pro', rate_limit_reached_type: null }
    await writeFile(join(sessions, 'rollout-a.jsonl'), `{"type":"session_meta"}\n${JSON.stringify({ timestamp: '2026-11-03T11:17:12.689Z', payload: { type: 'token_count', rate_limits: limits } })}\n`)
    await writeFile(env.CREWBOARD_CLAUDE_LIMITS!, `${JSON.stringify({ ts: '2026-11-03T10:00:00Z', five_hour: 12, seven_day: 40, five_hour_resets_at: '2100-01-01T05:00:00Z', seven_day_resets_at: 4102444800 })}\n`)
    const [claude, codex] = await readUsage({ env, agents: [...BUILTIN_AGENTS].filter((a) => a.id !== 'deepseek'), claudeCredentials: signedOut })
    expect(claude).toMatchObject({ id: 'claude', state: 'ok', windows: [{ minutes: 300, usedPercent: 12, resetsAt: '2100-01-01T05:00:00.000Z' }, { minutes: 10080, usedPercent: 40 }] })
    expect(codex).toMatchObject({ id: 'codex', state: 'ok', plan: 'pro', windows: [{ minutes: 10080, usedPercent: 13 }], balances: [{ currency: 'credits', amount: 23174.86 }], at: '2026-11-03T11:17:12.689Z' })
  })

  it.each([
    ['no key', {}, undefined, { state: 'no_key', hint: 'DEEPSEEK_API_KEY' }],
    ['a balance', { DEEPSEEK_API_KEY: KEY }, reply(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] }), { state: 'ok', balances: [{ currency: 'CNY', amount: 110 }] }],
    ['no money left', { DEEPSEEK_API_KEY: KEY }, reply(200, { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }), { state: 'ok', exhausted: true }],
    ['a refused key', { DEEPSEEK_API_KEY: KEY }, reply(401, { error: { message: `bad key ${KEY}` } }), { state: 'error', hint: 'key_refused' }],
  ] as const)('DeepSeek with %s', async (_n, extra, fetch, expected) => {
    const { env } = await setup()
    const [usage] = await readUsage({ env: { ...env, ...extra }, agents: [...BUILTIN_AGENTS].filter((a) => a.id === 'deepseek'), ...(fetch ? { fetch } : {}) })
    expect(usage).toMatchObject(expected)
    expect(JSON.stringify(usage)).not.toContain(KEY)
  })

  it('takes the newest real limits across days, skips empty and half-written counts, and shows a passed window as reset', async () => {
    const { dir, env } = await setup()
    const yesterday = join(dir, 'sessions', '2026', '11', '02')
    await mkdir(yesterday, { recursive: true })
    const count = (used: number, reached: string | null) => JSON.stringify({ timestamp: 't', payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1 }, plan_type: 'plus', rate_limit_reached_type: reached } } })
    // Yesterday's session is still open and written last; today's ended earlier.
    await writeFile(join(dir, 'sessions', '2026', '11', '03', 'rollout-old.jsonl'), `${count(10, null)}\n`)
    await utimes(join(dir, 'sessions', '2026', '11', '03', 'rollout-old.jsonl'), new Date(1000), new Date(1000))
    await writeFile(join(yesterday, 'rollout-live.jsonl'), `${count(97, 'primary')}\n{"payload":{"type":"token_count","rate_limits":null}}\n{"payload":{"rate_limits":{"prim`)
    const [codex] = await readUsage({ env, agents: [...BUILTIN_AGENTS].filter((a) => a.id === 'codex') })
    // The window reset long ago (epoch 1): its numbers are no longer current.
    expect(codex).toMatchObject({ plan: 'plus', windows: [{ minutes: 300, usedPercent: 0 }] })
    expect(codex?.exhausted).toBeUndefined()
  })

  it('reads Claude limits from the account with Claude Code sign-in, and falls back to the log when the account refuses', async () => {
    const { env } = await setup()
    await writeFile(env.CREWBOARD_CLAUDE_LIMITS!, `${JSON.stringify({ ts: '2026-11-03T10:00:00Z', five_hour: 5, seven_day: 6 })}\n`)
    const sign = async () => JSON.stringify({ claudeAiOauth: { accessToken: KEY, refreshToken: 'r', expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' } })
    const seen: Array<Record<string, string>> = []
    const account = async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers)
      return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 10, resets_at: '2026-11-04T15:50:00Z' }, seven_day: { utilization: 52, resets_at: '2026-11-08T06:00:00Z' }, seven_day_opus: null }) }
    }
    const agents = [...BUILTIN_AGENTS].filter((a) => a.id === 'claude')
    const [claude] = await readUsage({ env, agents, fetch: account, claudeCredentials: sign })
    expect(claude).toMatchObject({ state: 'ok', plan: 'Max', windows: [{ minutes: 300, usedPercent: 10 }, { minutes: 10080, usedPercent: 52 }] })
    expect(seen[0]?.Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify(claude)).not.toContain(KEY)
    const [fallback] = await readUsage({ env, agents, fetch: reply(401, {}), claudeCredentials: sign })
    expect(fallback?.windows.map((w) => w.usedPercent)).toEqual([5, 6])
  })

  it('says what is missing when nothing is logged, and reads nothing when turned off', async () => {
    const { env } = await setup()
    const agents = [...BUILTIN_AGENTS]
    const all = await readUsage({ env, agents, fetch: reply(500, {}), claudeCredentials: signedOut })
    expect(all.map((u) => [u.id, u.state, u.hint])).toEqual([['claude', 'no_data', 'claude_statusline'], ['codex', 'no_data', 'codex_no_sessions'], ['deepseek', 'no_key', 'DEEPSEEK_API_KEY']])
    expect(await readUsage({ env: { ...env, CREWBOARD_NO_USAGE: '1' }, agents })).toEqual([])
  })
})

describe('crewboard statusline', () => {
  it('logs the limits Claude Code sends once per change, and the panel reads them back', async () => {
    const { env, dir } = await setup()
    const payload = JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 21.4, resets_at: 4102444800 }, seven_day: { used_percentage: 55, resets_at: '2100-01-07T09:00:00Z' } } })
    expect(await statusline(payload, env, dir)).toBe('Opus · 5h 21% · week 55%')
    await statusline(payload, env, dir)
    expect((await readFile(env.CREWBOARD_CLAUDE_LIMITS!, 'utf8')).trim().split('\n')).toHaveLength(1)
    // An unwritable log never breaks Claude Code's status line.
    expect(await statusline(payload, { ...env, CREWBOARD_CLAUDE_LIMITS: '/dev/null/limits.jsonl' }, dir)).toBe('Opus · 5h 21% · week 55%')
    const [claude] = await readUsage({ env, agents: [...BUILTIN_AGENTS].filter((a) => a.id === 'claude'), home: dir, claudeCredentials: signedOut })
    expect(claude).toMatchObject({ state: 'ok', windows: [{ minutes: 300, usedPercent: 21.4 }, { minutes: 10080, usedPercent: 55, resetsAt: '2100-01-07T09:00:00.000Z' }] })
  })
})
