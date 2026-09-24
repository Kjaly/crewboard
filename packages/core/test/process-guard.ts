import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * Every process a test run starts inherits process.env, so the run marks it there: the session id (set here,
 * before the workers fork) and the current test's tag (set by process-reaper.ts before each test). Detached
 * supervisors and the agents they spawn copy the env, so a marker survives a detach and a reparent to pid 1 —
 * which is how a leaked runner is found without touching processes that another run or worktree started.
 */
export const SESSION_ENV = 'CREWBOARD_TEST_SESSION'
export const TAG_ENV = 'CREWBOARD_TEST_TAG'
const REAP_WAIT_MS = 8_000

export type TaggedProcess = { pid: number; ppid: number; command: string; env: Record<string, string> }

/** Processes (other than this one) whose environment has `name=value`. */
export function findTagged(name: string, value: string): TaggedProcess[] {
  return listProcesses().filter((p) => p.pid !== process.pid && p.env[name] === value)
}

function listProcesses(): TaggedProcess[] {
  if (process.platform === 'linux') return listLinux()
  // BSD ps: -E appends the environment to the command; the value runs to the next space.
  const out = execFileSync('ps', ['-AEww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) return []
    const env: Record<string, string> = {}
    for (const [, k, v] of (m[3] as string).matchAll(/(?:^|\s)(CREWBOARD_TEST_[A-Z]+)=(\S*)/g)) env[k as string] = v as string
    // Keep only the command for messages: the rest of the line is the environment and may hold secrets.
    const command = (m[3] as string).split(/\s(?=[A-Za-z_][A-Za-z0-9_]*=)/)[0] as string
    return [{ pid: Number(m[1]), ppid: Number(m[2]), command, env }]
  })
}

function listLinux(): TaggedProcess[] {
  return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).flatMap((d) => {
    try {
      const env = Object.fromEntries(readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').filter((kv) => kv.startsWith('CREWBOARD_TEST_')).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${d}/status`, 'utf8'))?.[1] ?? 0)
      return [{ pid: Number(d), ppid, command: readFileSync(`/proc/${d}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(), env }]
    } catch {
      return []
    }
  })
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** SIGTERM (a supervisor then stops its agent), then SIGKILL whatever outlives the wait. Returns the processes that needed SIGKILL. */
export async function reap(procs: TaggedProcess[]): Promise<TaggedProcess[]> {
  for (const p of procs) try { process.kill(p.pid, 'SIGTERM') } catch {}
  const deadline = Date.now() + REAP_WAIT_MS
  while (procs.some((p) => alive(p.pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  const stubborn = procs.filter((p) => alive(p.pid))
  for (const p of stubborn) try { process.kill(p.pid, 'SIGKILL') } catch {}
  return stubborn
}

const describe = (procs: TaggedProcess[]) => procs.map((p) => `  pid ${p.pid} (ppid ${p.ppid}): ${p.command.slice(0, 240)}`).join('\n')

/**
 * globalSetup: marks the session, and after the run fails it when a process it started is still alive — after
 * killing it, so a leak is loud but never accumulates. vitest itself and its direct children (workers that are
 * still shutting down) are vitest's own; anything a worker started is a test's.
 */
export default function setup(): () => Promise<void> {
  const session = randomUUID()
  process.env[SESSION_ENV] = session
  return async () => {
    const leaked = listProcesses().filter((p) => p.env[SESSION_ENV] === session && p.pid !== process.pid && p.ppid !== process.pid)
    if (!leaked.length) return
    await reap(leaked)
    throw new Error(`Test run left ${leaked.length} process(es) alive; they are killed now, but a test or its teardown must stop what it starts:\n${describe(leaked)}`)
  }
}
