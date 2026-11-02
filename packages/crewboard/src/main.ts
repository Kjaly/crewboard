#!/usr/bin/env node
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeExec } from '@crewboard/core'
import { createApp } from './app.js'
import { duration, flag, portOf } from './cli.js'
import { connectLead } from './connect.js'
import { checkAgents, readinessLine, readinessTable } from './doctor.js'
import { createAgents } from './workers/agents.js'
import { realBackendFor } from './workers/backends.js'

const DEFAULT_PORT = 4700
const USAGE = `crewboard — local Crewboard server

  crewboard serve [--port ${DEFAULT_PORT}]
      start the server; connect your lead (any MCP client) to http://127.0.0.1:${DEFAULT_PORT}/mcp, e.g.
      claude mcp add --scope user --transport http crewboard http://127.0.0.1:${DEFAULT_PORT}/mcp
      codex mcp add crewboard --url http://127.0.0.1:${DEFAULT_PORT}/mcp

  crewboard connect <claude|codex|dsh|other> [--port ${DEFAULT_PORT}]
      connect your lead: runs claude/codex mcp add, or prints what to add for dsh and other clients

  crewboard doctor
      check which workers can run on this machine (CLI installed, version, signed in)

  crewboard wait --project <path> [--port ${DEFAULT_PORT}] [--timeout 10m]
      wait until the lead has news; exit 0 = news, 2 = timeout, 1 = server unreachable`

/** `--port`, or a plain refusal: a typo must not start the server on NaN or reach a port nobody named. */
const portOrExit = (args: string[]): number => {
  const port = portOf(args, DEFAULT_PORT)
  if (port !== undefined) return port
  console.error(`crewboard: --port needs a number from 1 to 65535, got ${flag(args, 'port') ?? 'nothing'}`)
  process.exit(1)
}

async function serve(args: string[]): Promise<void> {
  const port = portOrExit(args)
  const env = process.env
  const uiDir = fileURLToPath(new URL('./ui', import.meta.url))
  const app = createApp({ env, uiDir, backendFor: (repo) => realBackendFor({ repo, env, home: homedir() }) })
  let server: Awaited<ReturnType<typeof app.listen>>
  try {
    server = await app.listen(port)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    console.error(`crewboard: port ${port} is in use — another Crewboard may be running (open http://127.0.0.1:${port}/), or start with --port <another>`)
    process.exit(1)
  }
  console.log(`crewboard ${server.url}  mcp: ${server.url}/mcp`)
  console.log(`  connect your lead: claude mcp add --scope user --transport http crewboard ${server.url}/mcp  |  codex mcp add crewboard --url ${server.url}/mcp`)
  // After the port listens, so a slow CLI never delays the start.
  void app.doctor().then((result) => console.log(`  ${readinessLine(result)}  (details: crewboard doctor)`), () => undefined)
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
  const port = portOrExit(args)
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

async function connect(args: string[]): Promise<number> {
  const client = args[0]
  if (client !== 'claude' && client !== 'codex' && client !== 'dsh' && client !== 'other') {
    console.error('connect: name the lead client: claude, codex, dsh or other')
    return 1
  }
  const url = `http://127.0.0.1:${portOrExit(args)}/mcp`
  const out = await connectLead({ client, url, exec: nodeExec })
  if (out.error) {
    console.error(`connect: ${out.error}`)
    return 1
  }
  console.log(out.ran ? `connected: ${out.ran}` : out.print)
  return 0
}

async function doctor(): Promise<number> {
  const result = await checkAgents({ agents: createAgents(process.env), env: process.env, exec: nodeExec })
  console.log(result.length ? readinessTable(result) : 'no workers enabled: every agent in ~/.crewboard/agents.json is turned off')
  return result.some((a) => a.ok) ? 0 : 1
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'serve') await serve(rest)
else if (command === 'doctor') process.exit(await doctor())
else if (command === 'connect') process.exit(await connect(rest))
else if (command === 'wait') process.exit(await wait(rest))
else {
  console.log(USAGE)
  process.exit(command === undefined || command === '--help' || command === 'help' ? 0 : 1)
}
