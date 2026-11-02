import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeProjectsRoot, projectFolder } from './paths.js'
import { readTranscript } from './transcript.js'

export const HISTORY_LIMIT = 2000

export type HistoryItem =
  | { kind: 'session'; ts: string; sessionId: string }
  | { kind: 'owner' | 'lead'; ts: string; text: string }
  | { kind: 'assignment'; ts: string; tool: string; goalId: string; assignmentId?: string; title?: string }
  | { kind: 'actions'; ts: string; count: number }
export type GoalHistory = { available: boolean; truncated: boolean; items: HistoryItem[] }

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
type Reduced = { sessionId: string; first: string; goals: ReadonlySet<string>; entries: Entry[] }

async function reduce(file: string): Promise<Reduced> {
  const { sessionId, items } = await readTranscript(file)
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
  return { sessionId, first: items.find((i) => i.ts)?.ts ?? '', goals, entries }
}

/**
 * The conversations with the lead about one goal, from Claude Code's transcripts. Claude Code keys folders on the
 * lead's working directory, so the repository's folder and those of its subfolders are searched. Each file is kept
 * only in reduced form, cached by size and mtime.
 */
export function createHistory(o: { env: NodeJS.ProcessEnv }) {
  const cache = new Map<string, { size: number; mtimeMs: number; reduced: Reduced }>()

  const load = async (file: string): Promise<Reduced | undefined> => {
    try {
      const s = await stat(file)
      const hit = cache.get(file)
      if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.reduced
      const reduced = await reduce(file)
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

  return {
    async goalHistory(repo: string, goalId: string): Promise<GoalHistory> {
      const sessions: Array<{ sessionId: string; first: string; items: HistoryItem[] }> = []
      for (const file of await transcriptFiles(repo)) {
        const r = await load(file)
        if (!r?.goals.has(goalId)) continue
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
      if (!sessions.length) return { available: false, truncated: false, items: [] }
      sessions.sort((a, b) => a.first.localeCompare(b.first))
      const items = sessions.flatMap((s) => [{ kind: 'session' as const, ts: s.first, sessionId: s.sessionId }, ...s.items])
      const truncated = items.length > HISTORY_LIMIT
      return { available: true, truncated, items: truncated ? items.slice(-HISTORY_LIMIT) : items }
    },
  }
}
