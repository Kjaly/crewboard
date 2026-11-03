import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { claudeLimitsPath } from '@crewboard/core'

type Window = { used_percentage?: unknown; resets_at?: unknown } | undefined
const pct = (w: Window): number | undefined => {
  const n = typeof w?.used_percentage === 'string' ? Number(w.used_percentage) : w?.used_percentage
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
/** Unchanged numbers are still logged this often, so the panel can tell fresh numbers from old ones. */
const HEARTBEAT_MS = 5 * 60_000

/**
 * A Claude Code status line: Claude shows its plan's limits only to this command. Each change is appended to the
 * limits log the providers panel reads (the same rows as any compatible script), and one short line is printed.
 */
export async function statusline(input: string, env: NodeJS.ProcessEnv, home = homedir(), now = new Date()): Promise<string> {
  let data: { model?: { display_name?: unknown }; rate_limits?: { five_hour?: Window; seven_day?: Window }; session_id?: unknown } = {}
  try {
    data = JSON.parse(input) as typeof data
  } catch {
    // Not the JSON Claude Code sends: print nothing useful rather than fail the status line.
  }
  const five = data.rate_limits?.five_hour
  const seven = data.rate_limits?.seven_day
  const snap = { five_hour: pct(five), seven_day: pct(seven) }
  if (snap.five_hour !== undefined || snap.seven_day !== undefined) {
    const row = { ts: now.toISOString().replace(/\.\d+Z$/, 'Z'), ...snap, five_hour_resets_at: five?.resets_at ?? null, seven_day_resets_at: seven?.resets_at ?? null }
    try {
      await logLimits(claudeLimitsPath(env, home), row, now)
    } catch {
      // An unwritable log costs the panel its numbers, never Claude Code its status line.
    }
  }
  const model = typeof data.model?.display_name === 'string' ? data.model.display_name : ''
  return [model, snap.five_hour !== undefined && `5h ${Math.round(snap.five_hour)}%`, snap.seven_day !== undefined && `week ${Math.round(snap.seven_day)}%`].filter(Boolean).join(' · ')
}

async function logLimits(file: string, row: Record<string, unknown>, now: Date): Promise<void> {
  const last = (await readFile(file, 'utf8').catch(() => '')).trimEnd().split('\n').at(-1)
  let prev: Record<string, unknown> = {}
  try {
    prev = last ? (JSON.parse(last) as Record<string, unknown>) : {}
  } catch {
    // A foreign last line: write a fresh row.
  }
  const same = ['five_hour', 'seven_day', 'five_hour_resets_at', 'seven_day_resets_at'].every((k) => prev[k] === row[k])
  const recent = typeof prev.ts === 'string' && now.getTime() - new Date(prev.ts).getTime() < HEARTBEAT_MS
  if (same && recent) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(row)}\n`)
}
