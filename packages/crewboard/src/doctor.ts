import { type Backend, type Exec, type ExecResult, preflightAgent, workerCommands } from '@crewboard/core'
import type { AgentRun, Agents } from './workers/agents.js'

/** One worker's readiness: each check core's preflight ran, with what to do about the first that failed. */
export type AgentReadiness = { id: string; label: string; ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> }

const BACKEND: Record<AgentRun, Backend> = {
  claude: 'claude-code', codex: 'codex-cli', dsh: 'dsh', opencode: 'opencode', cursor: 'cursor-agent', gemini: 'gemini-cli', grok: 'grok-build', devin: 'devin-cli',
}

/**
 * Every external command the checks run, bounded and never thrown: a missing CLI or one that hangs becomes a failed
 * result with the reason, so one slow tool cannot stall the others.
 */
const bounded = (exec: Exec, timeoutMs: number): Exec => (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    const timer = setTimeout(() => resolve({ code: 124, stdout: '', stderr: `${cmd} did not answer within ${Math.round(timeoutMs / 1000)}s (timed out)`, timedOut: true }), timeoutMs)
    exec(cmd, args, { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? timeoutMs, timeoutMs) }).then(
      (r) => {
        clearTimeout(timer)
        resolve(r)
      },
      (error: unknown) => {
        clearTimeout(timer)
        resolve({ code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false })
      },
    )
  })

/**
 * Claude Code signed in, read from `claude auth status --json`: only its `loggedIn` flag is looked at, nothing else
 * of what it prints (it names the account) is kept.
 */
async function claudeSignIn(exec: Exec, command: string): Promise<AgentReadiness['checks'][number]> {
  const r = await exec(command, ['auth', 'status', '--json'])
  let loggedIn = false
  try {
    loggedIn = r.code === 0 && (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn === true
  } catch {
    // Unreadable output: treated as not signed in.
  }
  return { name: 'signed-in', ok: loggedIn, detail: loggedIn ? 'signed in to Claude Code' : 'not signed in to Claude Code', ...(loggedIn ? {} : { fix: 'claude auth login' }) }
}

/** Which registered workers can run on this machine now: CLI installed, recent enough, signed in. */
export async function checkAgents(o: { agents: Agents; env: NodeJS.ProcessEnv; exec: Exec; lang?: 'en' | 'ru'; timeoutMs?: number }): Promise<AgentReadiness[]> {
  const exec = bounded(o.exec, o.timeoutMs ?? 10_000)
  const commands = workerCommands(o.env)
  // A registry file that cannot be read is itself the first thing to fix: reported as a failed check, never thrown.
  let list: Awaited<ReturnType<Agents['list']>>
  try {
    list = await o.agents.list()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return [{ id: 'agents.json', label: 'agents.json', ok: false, checks: [{ name: 'registry', ok: false, detail, fix: 'fix or remove the agents file' }] }]
  }
  return Promise.all(
    list.map(async (agent): Promise<AgentReadiness> => {
      const profile = { id: o.agents.coreId(agent), backend: BACKEND[agent.run], model: agent.model, enabled: true }
      const result = await preflightAgent(profile, { exec, env: o.env, commands, ...(o.lang ? { lang: o.lang } : {}) }).catch((error: unknown) => ({
        ok: false,
        checks: [{ name: 'check', ok: false, detail: error instanceof Error ? error.message : String(error) }],
      }))
      const checks = [...result.checks]
      // The default Claude route runs as the user: being signed in is what makes it ready.
      const isolated = o.env.CREWBOARD_CLAUDE_AUTH === 'isolated'
      if (agent.run === 'claude' && !isolated && checks.every((c) => c.ok)) checks.push(await claudeSignIn(exec, commands.claude ?? 'claude'))
      return { id: agent.id, label: agent.label, ok: checks.every((c) => c.ok), checks }
    }),
  )
}

/** One line for the server's start: who can work now, and the first reason for each who cannot. */
export function readinessLine(result: AgentReadiness[]): string {
  const ready = result.filter((a) => a.ok).map((a) => a.label)
  const not = result.filter((a) => !a.ok).map((a) => `${a.label} (${a.checks.find((c) => !c.ok)?.detail ?? 'not ready'})`)
  return `workers ready: ${ready.join(', ') || 'none'}${not.length ? ` · not ready: ${not.join(', ')}` : ''}`
}

/** The table `crewboard doctor` prints. */
export function readinessTable(result: AgentReadiness[]): string {
  const width = Math.max(...result.map((a) => a.label.length), 5)
  return result
    .map((a) => {
      const failed = a.checks.find((c) => !c.ok)
      return `${a.ok ? '✓' : '✗'} ${a.label.padEnd(width)}  ${a.ok ? 'ready' : `${failed?.detail ?? 'not ready'}${failed?.fix ? ` — ${failed.fix}` : ''}`}`
    })
    .join('\n')
}
