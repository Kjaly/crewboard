import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { crewboardEnv } from '../env.js'

/** Who holds one slot file: the same shape as `plan.lock` (sf1), so a crashed holder is found the same way. */
export type SlotHolder = { pid: number; host: string; at: string }

/** The lock directory every worker, baseline and `verify --run-checks` on the machine shares (ql1). */
export const slotsDir = (env: NodeJS.ProcessEnv, home: string): string => crewboardEnv(env, 'SLOTS_DIR') ?? join(home, '.config', 'crewboard', 'slots')

/** Where the configured slot count lives; `CREWBOARD_SLOTS_CONFIG` overrides it for tests and non-standard homes. */
export const slotsSettingsPath = (env: NodeJS.ProcessEnv, home: string): string => crewboardEnv(env, 'SLOTS_CONFIG') ?? join(home, '.config', 'crewboard', 'slots.json')

/** max(1, cores/4): the machine-wide default of heavy checks that run at once. */
export const defaultSlots = (): number => Math.max(1, Math.floor(cpus().length / 4))

function parseSlotCount(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined
}

/** The configured slot count: `CREWBOARD_CHECK_SLOTS`, else `slots.json`, else `defaultSlots()`. */
export async function loadMaxSlots(env: NodeJS.ProcessEnv, home: string): Promise<number> {
  const fromEnv = parseSlotCount(crewboardEnv(env, 'CHECK_SLOTS'))
  if (fromEnv) return fromEnv
  try {
    const raw = JSON.parse(await readFile(slotsSettingsPath(env, home), 'utf8')) as { maxSlots?: unknown }
    const configured = parseSlotCount(raw.maxSlots)
    if (configured) return configured
  } catch {
    /* No settings file yet, or it is unreadable: the default applies. */
  }
  return defaultSlots()
}

export async function saveMaxSlots(env: NodeJS.ProcessEnv, home: string, maxSlots: number): Promise<void> {
  if (!Number.isInteger(maxSlots) || maxSlots < 1) throw new RangeError(`Invalid slot count: ${maxSlots}`)
  const file = slotsSettingsPath(env, home)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, maxSlots }, null, 2)}\n`)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A holder on another host, or one whose record cannot be read, is judged by age (sf1) — long enough that no real check outlives it. */
const FOREIGN_HOLDER_STALE_MS = 24 * 60 * 60_000

async function readHolder(file: string): Promise<{ holder?: SlotHolder; mtimeMs: number } | undefined> {
  try {
    const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    let holder: SlotHolder | undefined
    try {
      const value = JSON.parse(raw) as Partial<SlotHolder>
      if (Number.isInteger(value.pid) && typeof value.host === 'string' && typeof value.at === 'string') holder = value as SlotHolder
    } catch {
      /* Written by an older build (empty) or not yet flushed: judged by age below. */
    }
    return { holder, mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * The slot files whose holder is still alive: a crashed holder on this host — its pid is gone — is removed
 * and its slot taken over at once (ql1, sf1). A holder on another host, or a record that cannot be read, is
 * removed once it is older than `FOREIGN_HOLDER_STALE_MS`.
 */
async function liveHolders(dir: string, host: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const alive: string[] = []
  for (const name of names) {
    if (!name.endsWith('.lock')) continue
    const file = join(dir, name)
    const seen = await readHolder(file)
    if (!seen) continue
    const { holder, mtimeMs } = seen
    const gone = holder ? (holder.host === host ? !pidAlive(holder.pid) : Date.now() - (Date.parse(holder.at) || mtimeMs) > FOREIGN_HOLDER_STALE_MS) : Date.now() - mtimeMs > FOREIGN_HOLDER_STALE_MS
    if (gone) {
      await rm(file, { force: true })
      continue
    }
    alive.push(file)
  }
  return alive
}

export type SlotHandle = { release(): Promise<void> }

/**
 * Waits for a free machine-wide slot, then holds one until `release()` (ql1): a lock directory under the
 * Crewboard state dir, shared by every worker, baseline and `verify --run-checks` on the machine, so heavy
 * checks take turns instead of all starting at once. `onWaiting` fires once, with how many currently hold a
 * slot, the moment this call finds none free.
 */
export async function acquireSlot(opts: { env: NodeJS.ProcessEnv; home: string; maxSlots?: number; onWaiting?: (ahead: number) => void; pollMs?: number }): Promise<SlotHandle> {
  const dir = slotsDir(opts.env, opts.home)
  await mkdir(dir, { recursive: true })
  const max = opts.maxSlots ?? (await loadMaxSlots(opts.env, opts.home))
  const host = hostname()
  const file = join(dir, `slot-${process.pid}-${Math.random().toString(36).slice(2, 8)}.lock`)
  let announced = false
  for (;;) {
    const alive = await liveHolders(dir, host)
    if (alive.length < max) {
      const handle = await open(file, 'wx').catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined
        throw err
      })
      if (handle) {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host, at: new Date().toISOString() } satisfies SlotHolder))
        await handle.close()
        return { release: () => rm(file, { force: true }) }
      }
    } else if (!announced) {
      announced = true
      opts.onWaiting?.(alive.length)
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 200))
  }
}

/** Runs `fn` holding one slot, releasing it whatever `fn` does. */
export async function withSlot<T>(opts: { env: NodeJS.ProcessEnv; home: string; maxSlots?: number; onWaiting?: (ahead: number) => void; pollMs?: number }, fn: () => Promise<T>): Promise<T> {
  const slot = await acquireSlot(opts)
  try {
    return await fn()
  } finally {
    await slot.release()
  }
}
