import { spawn } from 'node:child_process'

export type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type ExecOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

/**
 * Runs a command in its own process group so a timeout kills grandchildren too
 * (e.g. pnpm hanging on a proxy behind `sh -c`).
 */
export const nodeExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    const finish = (code: number) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, opts.timeoutMs)
    }

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      stderr += String(err)
      finish(127)
    })
    child.on('close', (code) => finish(code ?? 137))
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
