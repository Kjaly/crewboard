import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type GoalEvent, type NewEvent, goalEventSchema } from '../model/types.js'
import { writeJsonAtomic } from './atomic.js'
import { goalDir, projectDir } from './paths.js'

export type GoalMeta = { goalId: string; title: string; createdAt: string; leadLastSeen?: string; lead?: { client: string; version?: string } }
export type EventStore = ReturnType<typeof createEventStore>

const parseLines = (text: string): GoalEvent[] => {
  const out: GoalEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = goalEventSchema.safeParse(JSON.parse(line))
      if (parsed.success) out.push(parsed.data)
    } catch {
      // A line cut short by a crash: skipped, the rest of the journal stands.
    }
  }
  return out
}

/**
 * The highest number the journal used, counting lines the reader skips (an event from a newer version, say): a number
 * already on disk is never given out again.
 */
const lastSeq = (text: string): number => {
  let top = 0
  for (const line of text.split('\n')) {
    try {
      const seq = (JSON.parse(line) as { seq?: unknown }).seq
      if (typeof seq === 'number' && seq > top) top = seq
    } catch {
      // Not a whole line: it holds no number.
    }
  }
  return top
}

/**
 * The append-only journal of one repository's goals: `<repo>/.crewboard/goals/<goalId>/events.jsonl`. One server
 * writes it, so appends to a goal are serialised through a promise chain and numbered from an in-memory counter.
 */
export function createEventStore(repo: string) {
  const chains = new Map<string, Promise<unknown>>()
  const listeners = new Set<(e: GoalEvent) => void>()
  const counters = new Map<string, number>()
  let ignored = false

  const ensureIgnored = async () => {
    if (ignored) return
    await mkdir(projectDir(repo), { recursive: true })
    await writeFile(join(projectDir(repo), '.gitignore'), '*\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e
    })
    ignored = true
  }
  const file = (goalId: string) => join(goalDir(repo, goalId), 'events.jsonl')
  const read = async (goalId: string): Promise<GoalEvent[]> => parseLines(await readFile(file(goalId), 'utf8').catch(() => ''))
  const serial = <T>(goalId: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(goalId) ?? Promise.resolve()).then(fn, fn)
    chains.set(goalId, next.catch(() => undefined))
    return next
  }
  const metaPath = (goalId: string) => join(goalDir(repo, goalId), 'meta.json')
  const readMeta = async (goalId: string): Promise<GoalMeta | undefined> => {
    try {
      return JSON.parse(await readFile(metaPath(goalId), 'utf8')) as GoalMeta
    } catch {
      return undefined
    }
  }

  // Meta is read, changed and written back: writes to one goal run one after another, so a presence mark that read the
  // file before a takeover cannot write the old lead back after it.
  const metaWrite = (goalId: string, write: () => Promise<void>): Promise<void> => serial(`meta:${goalId}`, write)
  return {
    repo,
    read,
    append(goalId: string, e: NewEvent): Promise<GoalEvent> {
      return serial(goalId, async () => {
        await ensureIgnored()
        await mkdir(goalDir(repo, goalId), { recursive: true })
        let seq = counters.get(goalId)
        if (seq === undefined) seq = lastSeq(await readFile(file(goalId), 'utf8').catch(() => ''))
        const event = goalEventSchema.parse({ ...e, seq: seq + 1, ts: new Date().toISOString() })
        await appendFile(file(goalId), `${JSON.stringify(event)}\n`)
        counters.set(goalId, seq + 1)
        for (const listener of listeners) listener(event)
        return event
      })
    },
    readMeta,
    /** Called after every append; returns the unsubscribe. */
    onAppend(listener: (e: GoalEvent) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async listGoals(): Promise<GoalMeta[]> {
      const ids = await readdir(join(projectDir(repo), 'goals')).catch(() => [] as string[])
      const metas = await Promise.all(ids.map(readMeta))
      return metas.filter((m): m is GoalMeta => m !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },
    writeMeta(meta: GoalMeta): Promise<void> {
      return metaWrite(meta.goalId, async () => {
        await ensureIgnored()
        await writeJsonAtomic(metaPath(meta.goalId), meta)
      })
    },
    /** The lead is alive; `lead` (a takeover) also records which client leads the goal from now on. */
    touchLead(goalId: string, at: Date, lead?: { client: string; version?: string }): Promise<void> {
      return metaWrite(goalId, async () => {
        const meta = await readMeta(goalId)
        if (meta) await writeJsonAtomic(metaPath(goalId), { ...meta, leadLastSeen: at.toISOString(), ...(lead ? { lead } : {}) })
      })
    },
  }
}
