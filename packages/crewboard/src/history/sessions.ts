import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { codexSessionCwd, readCodexRollout } from './codex.js'
import type { GoalEvent } from '../model/types.js'
import { dshSessionCwd, readDshSession } from './dsh.js'
import { journalHistory } from './journal.js'
import { claudeProjectsRoot, codexSessionsRoot, dshSessionsRoot, projectFolder } from './paths.js'
import { type TranscriptItem, readTranscript } from './transcript.js'

export const HISTORY_LIMIT = 2000

export type HistoryItem =
  | { kind: 'session'; ts: string; sessionId: string }
  | { kind: 'owner' | 'lead'; ts: string; text: string }
  | { kind: 'assignment'; ts: string; tool: string; goalId: string; assignmentId?: string; title?: string }
  | { kind: 'actions'; ts: string; count: number }
/** Where the items come from: the lead's own conversation, or Crewboard's journal when none could be read. */
export type GoalHistory = { available: boolean; truncated: boolean; source?: 'transcript' | 'journal'; items: HistoryItem[] }

// `mcp__<server>__crewboard_assign` -> `assign`; segments cannot hold `__`, so the server name never leaks in.
const CREWBOARD_TOOL = /(?:^|_)crewboard_((?:[a-z]+_)*[a-z]+)$/
const parseJson = (text: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** A transcript reduced to what the history needs: words, crewboard calls with their goal, and other calls counted. */
type Entry =
  | { kind: 'owner' | 'lead'; ts: string; text: string }
  | { kind: 'crewboard'; ts: string; tool: string; goalId?: string; assignmentId?: string; title?: string }
  | { kind: 'other'; ts: string }
type Reduced = { sessionId: string; first: string; cwd?: string; goals: ReadonlySet<string>; entries: Entry[] }
type Reader = (file: string) => Promise<{ sessionId: string; cwd?: string; items: TranscriptItem[] }>

async function reduce(file: string, read: Reader): Promise<Reduced> {
  const { sessionId, cwd, items } = await read(file)
  const results = new Map<string, string>()
  for (const i of items) if (i.kind === 'tool_result') results.set(i.toolUseId, i.text)
  const goals = new Set<string>()
  const entries: Entry[] = []
  for (const i of items) {
    if (i.kind === 'owner' || i.kind === 'lead') entries.push({ kind: i.kind, ts: i.ts, text: i.text })
    if (i.kind !== 'tool') continue
    const m = CREWBOARD_TOOL.exec(i.name)
    if (!m?.[1]) {
      entries.push({ kind: 'other', ts: i.ts })
      continue
    }
    const input = (i.input && typeof i.input === 'object' ? i.input : {}) as Record<string, unknown>
    const result = parseJson(results.get(i.toolUseId) ?? '')
    const goalId = str(input.goalId) ?? str(result.goalId)
    if (goalId) goals.add(goalId)
    const assignmentId = str(input.assignmentId) ?? str(result.assignmentId)
    const title = str(input.title)
    entries.push({ kind: 'crewboard', ts: i.ts, tool: m[1], ...(goalId ? { goalId } : {}), ...(assignmentId ? { assignmentId } : {}), ...(title ? { title } : {}) })
  }
  return { sessionId, first: items.find((i) => i.ts)?.ts ?? '', ...(cwd ? { cwd } : {}), goals, entries }
}

/**
 * The conversations with the lead about one goal, from Claude Code's transcripts. Claude Code keys folders on the
 * lead's working directory, so the repository's folder and those of its subfolders are searched. Each file is kept
 * only in reduced form, cached by size and mtime.
 */
export function createHistory(o: { env: NodeJS.ProcessEnv; onRead?: (file: string) => void }) {
  const cache = new Map<string, { size: number; mtimeMs: number; reduced: Reduced }>()

  // Where a Codex or dsh session ran, from its first line, cached like the reduced files: other folders' sessions are
  // skipped without being read in full or kept.
  const cwds = new Map<string, { size: number; mtimeMs: number; cwd: string | undefined }>()
  const cwdOf = async (file: string, peek: (file: string) => Promise<string | undefined>): Promise<string | undefined> => {
    const s = await stat(file).catch(() => undefined)
    if (!s) return undefined
    const hit = cwds.get(file)
    if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.cwd
    const cwd = await peek(file)
    cwds.set(file, { size: s.size, mtimeMs: s.mtimeMs, cwd })
    return cwd
  }

  const load = async (file: string, read: Reader): Promise<Reduced | undefined> => {
    try {
      const s = await stat(file)
      const hit = cache.get(file)
      if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.reduced
      o.onRead?.(file)
      const reduced = await reduce(file, read)
      cache.set(file, { size: s.size, mtimeMs: s.mtimeMs, reduced })
      return reduced
    } catch {
      return undefined
    }
  }

  const transcriptFiles = async (repo: string): Promise<string[]> => {
    const root = claudeProjectsRoot(o.env)
    const slug = projectFolder(repo)
    const folders = (await readdir(root).catch(() => [] as string[])).filter((f) => f === slug || f.startsWith(`${slug}-`))
    const files: string[] = []
    for (const folder of folders) {
      for (const f of await readdir(join(root, folder)).catch(() => [] as string[])) if (f.endsWith('.jsonl')) files.push(join(root, folder, f))
    }
    return files
  }

  // Codex keeps every session in one dated tree, not per folder: only files changed since the goal began can mention it.
  const codexFiles = async (sinceMs: number): Promise<string[]> => {
    const files: string[] = []
    const walk = async (dir: string, depth: number) => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name)
        if (entry.isDirectory() && depth < 4) await walk(path, depth + 1)
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          const s = await stat(path).catch(() => undefined)
          if (s && s.mtimeMs >= sinceMs) files.push(path)
        }
      }
    }
    await walk(codexSessionsRoot(o.env), 0)
    return files
  }
  // dsh keeps one folder per working directory and one per session, each with a single session file.
  const dshFiles = async (sinceMs: number): Promise<string[]> => {
    const files: string[] = []
    const root = dshSessionsRoot(o.env)
    for (const folder of await readdir(root).catch(() => [] as string[])) {
      for (const session of await readdir(join(root, folder)).catch(() => [] as string[])) {
        const path = join(root, folder, session, 'session.v3.jsonl.zstd')
        const s = await stat(path).catch(() => undefined)
        if (s && s.mtimeMs >= sinceMs) files.push(path)
      }
    }
    return files
  }
  const inside = (repo: string, cwd: string | undefined) => cwd !== undefined && (cwd === repo || cwd.startsWith(`${repo}/`))

  return {
    /** `since` (the goal's creation) narrows the Codex files to those that may mention the goal. */
    async goalHistory(repo: string, goalId: string, since?: string, events?: GoalEvent[]): Promise<GoalHistory> {
      const sessions: Array<{ sessionId: string; first: string; items: HistoryItem[] }> = []
      const sinceMs = since ? new Date(since).getTime() : 0
      const sources: Array<{ file: string; read: Reader; peek?: (file: string) => Promise<string | undefined> }> = [
        ...(await transcriptFiles(repo)).map((file) => ({ file, read: readTranscript })),
        ...(await codexFiles(sinceMs)).map((file) => ({ file, read: readCodexRollout, peek: codexSessionCwd })),
        ...(await dshFiles(sinceMs)).map((file) => ({ file, read: readDshSession, peek: dshSessionCwd })),
      ]
      for (const { file, read, peek } of sources) {
        if (peek && !inside(repo, await cwdOf(file, peek))) continue
        const r = await load(file, read)
        if (!r?.goals.has(goalId)) continue
        if (read !== readTranscript && !inside(repo, r.cwd)) continue
        const out: HistoryItem[] = []
        for (const e of r.entries) {
          if (e.kind === 'owner' || e.kind === 'lead') out.push(e)
          else if (e.kind === 'crewboard' && e.goalId === goalId) {
            out.push({ kind: 'assignment', ts: e.ts, tool: e.tool, goalId, ...(e.assignmentId ? { assignmentId: e.assignmentId } : {}), ...(e.title ? { title: e.title } : {}) })
          } else {
            const last = out.at(-1)
            if (last?.kind === 'actions') last.count += 1
            else out.push({ kind: 'actions', ts: e.ts, count: 1 })
          }
        }
        sessions.push({ sessionId: r.sessionId, first: r.first, items: out })
      }
      if (!sessions.length) {
        if (!events) return { available: false, truncated: false, items: [] }
        const items = journalHistory(events)
        const truncated = items.length > HISTORY_LIMIT
        return { available: true, truncated, source: 'journal', items: truncated ? items.slice(-HISTORY_LIMIT) : items }
      }
      sessions.sort((a, b) => a.first.localeCompare(b.first))
      const items = sessions.flatMap((s) => [{ kind: 'session' as const, ts: s.first, sessionId: s.sessionId }, ...s.items])
      const truncated = items.length > HISTORY_LIMIT
      return { available: true, truncated, source: 'transcript', items: truncated ? items.slice(-HISTORY_LIMIT) : items }
    },
  }
}
