import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { type NormEvent, type RawEvent, normalize, parseEventData } from '@crewboard/core'
import type { GoalEvent } from '../model/types.js'
import type { EventStore } from '../store/event-store.js'
import type { BackendFor } from './pool.js'
import { runsDir } from '../store/paths.js'

export type Step = {
  i: number
  ts: string
  kind: 'message' | 'thought' | 'command' | 'read' | 'write' | 'tool' | 'problem' | 'final'
  text: string
  detail?: string
  status?: 'running' | 'done' | 'failed'
  durationMs?: number
}
export type RunSteps = { steps: Step[]; next: number; done: boolean; context?: { used: number; size: number } }

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text

/** What a person reads: the handback protocol's tags and markdown emphasis (Codex titles its thoughts in bold) dropped. */
/** Agent prose as plain text: no handback tags, no markdown emphasis. */
export const readable = (text: string): string => text.replace(/<\/?crewboard-[a-z]+>/g, '').replace(/(\*\*|__)(.+?)\1/g, '$2').trim()

/** Only normalized summaries and public messages cross this boundary; tool payloads never do. */
export function stepsFromEvents(events: readonly NormEvent[]): Step[] {
  const steps: Step[] = []
  for (const event of events) {
    if (event.kind === 'steer') continue
    const tool = event.kind === 'action' || event.kind === 'file'
    const op = event.tool?.op
    const kind = event.kind === 'action' || event.kind === 'file' ? (op && op !== 'other' ? op : 'tool') : event.kind
    const step: Step = {
      i: steps.length,
      ts: event.ts,
      kind,
      // A read or a write is shown by its file name, as the step's icon already says which: core's summary of a
      // read is the English "Read <file>", which would leak into a feed in any language.
      text: clip((kind === 'read' || kind === 'write') && event.tool?.target ? basename(event.tool.target) : readable(event.text).replace(/\s+/g, ' ').trim(), 200),
    }
    if ((event.kind === 'message' || event.kind === 'thought' || event.kind === 'final') && event.display) step.detail = clip(readable(event.display), 2000)
    if (tool) {
      step.status = event.status ?? (event.open ? 'running' : 'done')
      if (event.durationMs !== undefined) step.durationMs = event.durationMs
    }
    steps.push(step)
  }
  return steps
}

/** Refuse symlink escapes before asking a backend to read a changed run. */
export async function runIsLocal(repo: string, runId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return false
  const root = runsDir(repo)
  const dir = join(root, runId)
  try {
    if (await realpath(root) !== root || await realpath(dir) !== dir || !(await stat(dir)).isDirectory()) return false
    for (const name of ['events.jsonl', 'state.json', 'args.json']) {
      const file = join(dir, name)
      try {
        await lstat(file)
      } catch (error) {
        // A starting run may not have written its first event or state yet.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        continue
      }
      if (!(await realpath(file)).startsWith(`${dir}${sep}`)) return false
    }
    return true
  } catch {
    return false
  }
}

function contextOf(raw: readonly RawEvent[]): RunSteps['context'] {
  let context: RunSteps['context']
  for (let i = raw.length - 1; i >= 0; i--) {
    const event = raw[i]
    if (event?.type !== 'usage') continue
    const data = parseEventData(event.data) as { used?: unknown; size?: unknown } | undefined
    if (typeof data?.used === 'number' && Number.isFinite(data.used) && typeof data.size === 'number' && Number.isFinite(data.size)) {
      context = { used: data.used, size: data.size }
      break
    }
  }
  return context
}

type RunOwner = { repo: string; agent: string; goalId: string; cwd: string; done: boolean }
const STEPS_CACHED = 32
type CachedSteps = { fingerprint: string; steps: Step[]; next: number; context?: RunSteps['context'] }

/** Read-only screen polling. The journal owns completion; only the supervisor may settle a backend run. */
export function createStepsReader(store: EventStore, backendFor: BackendFor) {
  const owners = new Map<string, RunOwner>()
  const ended = new Set<string>()
  const cache = new Map<string, CachedSteps>()
  const remember = (event: GoalEvent) => {
    if (event.type === 'run_started' && !owners.has(event.runId)) owners.set(event.runId, { repo: store.repo, agent: event.agent, goalId: event.goalId, cwd: event.cwd, done: ended.has(event.runId) })
    else if (event.type === 'run_ended') {
      ended.add(event.runId)
      const owner = owners.get(event.runId)
      if (owner) owner.done = true
    }
  }
  // One server writes the goal journals. Appends keep warm ownership and completion current without disk reads.
  store.onAppend(remember)
  const ownerOf = async (runId: string): Promise<RunOwner | undefined> => {
    const known = owners.get(runId)
    if (known) return known
    for (const goal of await store.listGoals()) {
      for (const event of await store.read(goal.goalId)) remember(event)
      const found = owners.get(runId)
      if (found) return found
    }
    return undefined
  }

  return async function readRunSteps(runId: string, since: number): Promise<RunSteps | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) return undefined
    const owner = await ownerOf(runId)
    if (!owner) return undefined
    // Observe completion first, so a terminal page always reads events written before run_ended.
    const done = owner.done
    let fingerprint = 'missing'
    try {
      const file = await lstat(join(runsDir(owner.repo), runId, 'events.jsonl'))
      if (!file.isFile()) return undefined
      fingerprint = `${file.size}:${file.mtimeMs}:${file.ctimeMs}:${file.dev}:${file.ino}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let cached = cache.get(runId)
    // Least recently read last: a long-running server keeps only the runs on screen, not every run it has shown.
    if (cached) { cache.delete(runId); cache.set(runId, cached) }
    if (!cached || cached.fingerprint !== fingerprint) {
      if (!await runIsLocal(owner.repo, runId)) { cache.delete(runId); return undefined }
      const backend = await backendFor(owner.agent)
      const raw = await backend.events(runId)
      const steps = stepsFromEvents(normalize(raw, { mergeToolResults: true, cwd: owner.cwd, repo: owner.repo }))
      // Replay unfinished calls and the streaming message, retaining their step indices.
      const open = steps.find((step) => step.status === 'running')
      const tail = steps.at(-1)
      const next = Math.min(open?.i ?? steps.length, tail?.kind === 'message' ? tail.i : steps.length)
      cached = { fingerprint, steps, next, context: contextOf(raw) }
      cache.set(runId, cached)
      if (cache.size > STEPS_CACHED) cache.delete(cache.keys().next().value as string)
    }
    const { steps, context } = cached
    const next = done ? steps.length : cached.next
    return { steps: since === 0 ? steps : steps.slice(since), next, done, ...(context ? { context } : {}) }
  }
}
