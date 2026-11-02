#!/usr/bin/env node
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { realBackendFor } from './workers/backends.js'

const DEFAULT_PORT = 4700
const USAGE = `crewboard — local Crewboard server

  crewboard serve [--port ${DEFAULT_PORT}]
      start the server; the lead connects with:
      claude mcp add --transport http crewboard http://127.0.0.1:${DEFAULT_PORT}/mcp

  crewboard wait --project <path> [--port ${DEFAULT_PORT}] [--timeout 10m]
      wait until the lead has news; exit 0 = news, 2 = timeout, 1 = server unreachable`

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const duration = (text: string | undefined, fallbackMs: number): number => {
  const m = text ? /^(\d+)(ms|s|m|h)?$/.exec(text) : null
  if (!m) return fallbackMs
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h']
}

async function serve(args: string[]): Promise<void> {
  const port = Number(flag(args, 'port') ?? DEFAULT_PORT)
  const env = process.env
  const uiDir = fileURLToPath(new URL('./ui', import.meta.url))
  const app = createApp({ env, uiDir, backendFor: (repo) => realBackendFor({ repo, env, home: homedir() }) })
  const server = await app.listen(port)
  console.log(`crewboard ${server.url}  mcp: ${server.url}/mcp`)
  const stop = () => void server.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function wait(args: string[]): Promise<number> {
  const project = flag(args, 'project')
  if (!project) {
    console.error('wait: --project <path> is required')
    return 1
  }
  const port = Number(flag(args, 'port') ?? DEFAULT_PORT)
  const until = Date.now() + duration(flag(args, 'timeout'), 10 * 60_000)
  while (Date.now() < until) {
    const slice = Math.min(until - Date.now(), 600_000)
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/lead/wait?project=${encodeURIComponent(resolve(project))}&timeoutMs=${slice}`)
    } catch {
      console.error(`wait: no Crewboard server on port ${port}; start it with crewboard serve`)
      return 1
    }
    if (res.status === 200) {
      const { pending } = (await res.json()) as { pending: number }
      console.log(`crewboard: ${pending} new event(s) for the lead; call crewboard_inbox`)
      return 0
    }
    if (res.status !== 204) {
      console.error(`wait: ${(await res.text()) || res.status}`)
      return 1
    }
  }
  console.log('crewboard: nothing new; start the wait again')
  return 2
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'serve') await serve(rest)
else if (command === 'wait') process.exit(await wait(rest))
else {
  console.log(USAGE)
  process.exit(command === undefined || command === '--help' || command === 'help' ? 0 : 1)
}
