import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SteerState = 'queued' | 'sent' | 'acknowledged' | 'abandoned' | 'refused'
export type SteerRecord = { id: string; createdAt: string; mode: 'auto' | 'queue' | 'interrupt'; preview: string; text?: string; file: string; state: SteerState; timestamps: Partial<Record<SteerState, string>>; reason?: 'run_finished' | 'run_failed' | 'cancelled' }
const dir = (runDir: string) => join(runDir, 'steers')
/** Mailbox file of a direction: `steer-<ms>-<id>.md`. Backends write it, runners read the id back with steerIdOfMail. */
export const steerMailName = (id: string, at = Date.now()) => `steer-${at}-${id}.md`
export const steerIdOfMail = (name: string): string | undefined => /^steer-\d+-(.+)\.md$/.exec(name)?.[1]
const path = (runDir: string, id: string) => join(dir(runDir), `${id}.json`)
export async function withSteerLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(runDir, { recursive: true })
  const lock = join(runDir, '.steer-lock')
  for (;;) {
    try { await mkdir(lock); break }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 10)) }
  }
  try { return await fn() } finally { await rm(lock, { recursive: true, force: true }) }
}
export async function readSteer(runDir: string, id: string): Promise<SteerRecord | undefined> {
  try { const value = JSON.parse(await readFile(path(runDir, id), 'utf8')) as SteerRecord; return value.timestamps && value.createdAt ? value : undefined }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}
export async function writeSteer(runDir: string, record: SteerRecord): Promise<void> {
  await mkdir(dir(runDir), { recursive: true })
  const target = path(runDir, record.id), tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`)
  await rename(tmp, target)
}
export async function transitionSteer(runDir: string, id: string, state: SteerState, reason?: SteerRecord['reason']): Promise<SteerRecord | undefined> {
  return withSteerLock(runDir, async () => {
    const record = await readSteer(runDir, id)
    if (!record || ['abandoned', 'refused'].includes(record.state)) return record
    if (state === 'abandoned' && record.state !== 'queued') return record
    if (state === 'queued' || (state === 'sent' && record.state === 'acknowledged') || (state === 'acknowledged' && record.state === 'acknowledged')) return record
    if (state === 'acknowledged' && record.state === 'queued') record.timestamps.sent = new Date().toISOString()
    record.state = state; record.timestamps[state] = new Date().toISOString()
    if (reason) record.reason = reason
    await writeSteer(runDir, record)
    return record
  })
}
export async function listSteers(runDir: string): Promise<SteerRecord[]> {
  const names = await readdir(dir(runDir)).catch(() => [] as string[])
  return (await Promise.all(names.filter(n => n.endsWith('.json')).map(n => readSteer(runDir, n.slice(0, -5))))).filter((s): s is SteerRecord => !!s).sort((a,b) => a.createdAt.localeCompare(b.createdAt))
}
export async function finishSteers(runDir: string, reason: NonNullable<SteerRecord['reason']>, saveState: () => Promise<void>): Promise<void> {
  await withSteerLock(runDir, async () => {
    // `sent` without an acknowledgement means the worker never took it: not delivered either.
    for (const record of await listSteers(runDir)) if (record.state === 'queued' || record.state === 'sent') {
      record.state = 'abandoned'; record.reason = reason; record.timestamps.abandoned = new Date().toISOString()
      await writeSteer(runDir, record)
    }
    await saveState()
  })
}
