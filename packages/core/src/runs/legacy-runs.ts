import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { RunBackend } from '../backend/types.js'
import { TERMINAL_STATUSES, type RunState } from '../plan/graph.js'
import type { RawEvent } from './raw-event.js'

export const LEGACY_STEER_OVERRIDE = 'PORCH_STEER_DIR'
export const LEGACY_CACHE_NAME = 'pragmatic-orchestration'
export const LEGACY_RUN_ID = /^run_[a-z]+-[a-z]+-[a-f0-9]+$/i
const KNOWN = new Set(['run_started', 'thinking_delta', 'answer_delta', 'tool_started', 'tool_completed', 'retry_scheduled', 'steer_accepted', 'steer_delivering', 'steer_request_sent', 'steer_queued', 'steer_awaiting_queue_resolution', 'steer_merged', 'steer_running', 'steer_completed', 'steer_incomplete', 'steer_applied', 'steer_cancelled', 'steer_superseded', 'steer_dropped', 'steer_abandoned', 'steer_failed', 'steer_rejected', 'run_completed', 'run_failed', 'result', 'progress', 'user_replay', 'turn_started', 'turn_completed', 'prompt_complete'])

type RecordLike = Record<string, unknown>
const record = (value: unknown): RecordLike => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : {}
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export class LegacyRunReadOnlyError extends Error {
  readonly code = 'legacy_run_read_only'
  constructor() { super('This older run is read-only. Start a new run to send instructions.'); this.name = 'LegacyRunReadOnlyError' }
}

export function legacySteerRoot(env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir(), os = platform()): string {
  if (env[LEGACY_STEER_OVERRIDE]) return env[LEGACY_STEER_OVERRIDE]
  if (os === 'darwin') return join(home, 'Library', 'Caches', LEGACY_CACHE_NAME, 'steer')
  if (os === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), LEGACY_CACHE_NAME, 'steer')
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), LEGACY_CACHE_NAME, 'steer')
}

async function json(path: string): Promise<RecordLike | undefined> {
  try { return record(JSON.parse(await readFile(path, 'utf8')) as unknown) }
  catch (error) { if (missing(error)) return undefined; throw error }
}

/** Reads old supervisor artifacts without invoking their former runtime. */
export function createLegacyRuns(env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()): RunBackend {
  const runs = join(legacySteerRoot(env, home), 'runs')
  const dir = (runId: string) => {
    if (!LEGACY_RUN_ID.test(runId)) throw new TypeError('Invalid legacy run id')
    return join(runs, runId)
  }
  const meta = (id: string) => json(join(dir(id), 'meta.json'))
  const refusal = async (): Promise<never> => { throw new LegacyRunReadOnlyError() }
  return {
    id: 'legacy', launch: refusal,
    async status(id): Promise<RunState> {
      const m = await meta(id)
      if (!m) return { status: 'history_unavailable', terminal: false, exitCode: null }
      const snapshot = await json(join(dir(id), 'state.json'))
      const status = string(snapshot?.status) ?? string(m.status) ?? 'unknown'
      const finishedAt = string(m.finished_at) ?? string(snapshot?.finished_at)
      return { status, terminal: TERMINAL_STATUSES.has(status), exitCode: typeof m.exit_code === 'number' ? m.exit_code : null, ...(finishedAt ? { finishedAt } : {}) }
    },
    async events(id): Promise<RawEvent[]> {
      const m = await meta(id)
      if (!m) return []
      const artifact = string(m.artifacts_dir)
      const agent = string(m.agent_id)
      if (!artifact || !agent || !/^[a-zA-Z0-9_.-]+$/.test(agent)) return []
      const path = join(isAbsolute(artifact) ? artifact : resolve(dir(id), artifact), 'normalized', `${agent}.jsonl`)
      let content: string
      try { content = await readFile(path, 'utf8') } catch (error) { if (missing(error)) return []; throw error }
      const events: RawEvent[] = []
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        let obj: RecordLike
        try { obj = record(JSON.parse(line) as unknown) } catch { continue }
        const type = string(obj.type) ?? 'progress'
        events.push({ ts: string(obj.ts) ?? string(m.started_at) ?? new Date(0).toISOString(), type: KNOWN.has(type) ? type : 'progress', backend: string(obj.backend) ?? string(m.backend), agent_id: string(obj.agent_id) ?? agent, data: KNOWN.has(type) ? obj.data : { unknownType: type, detail: obj.data } })
      }
      return events
    },
    steer: refusal, cancel: refusal,
  }
}
