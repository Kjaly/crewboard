import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { createLeadCommands } from './lead/commands.js'
import { createLeadMcp } from './lead/mcp.js'
import { goalAnalytics } from './analytics.js'
import { claudeProjectsRoot } from './history/paths.js'
import { createHistory } from './history/sessions.js'
import { createLive } from './live.js'
import { REQUEST_ACTIONS, PROVIDERS, type ProviderId, type RequestAction } from './model/types.js'
import { BadRequestError, ConflictError, answerAsOwner, goalTree, nodeEvents, summarize } from './owner.js'
import { emergencyStop, requestAsOwner } from './requests.js'
import { createHttpServer } from './server.js'
import { type EventStore, createEventStore } from './store/event-store.js'
import { createInbox } from './store/inbox.js'
import { runsDir } from './store/paths.js'
import { createRegistry } from './store/registry.js'
import { type Supervisor, createSupervisor, gitWorktree } from './supervisor.js'
import { type BackendFor, createPool } from './workers/pool.js'

const run = promisify(execFile)

export type ProjectContext = {
  repo: string
  store: EventStore
  inbox: ReturnType<typeof createInbox>
  supervisor: Supervisor
  /** Runs `fn` alone among this project's ticks and lead commands, so a run is never started twice. */
  exclusive<T>(fn: (ctx: ProjectContext) => Promise<T>): Promise<T>
  /** Lists the project in `~/.crewboard/projects.json`, so timer ticks reach it. Only a started or adopted goal does this. */
  register(): Promise<void>
  /** One supervisor tick; a tick asked for while one is pending joins it instead of queueing behind it. */
  tickOnce(): Promise<void>
}

/** The repository a lead names: it must exist and be inside git; the top level is the project. */
async function resolveRepo(path: string): Promise<string> {
  let real: string
  try {
    real = await realpath(path)
  } catch {
    throw new Error(`project ${path} does not exist`)
  }
  try {
    const { stdout } = await run('git', ['-C', real, 'rev-parse', '--show-toplevel'])
    return await realpath(stdout.trim())
  } catch {
    throw new Error(`project ${path} is not inside a git repository`)
  }
}

/** Long-polls the lead's inbox: returns as soon as something is pending, or 0 when the time is up. */
async function waitPending(ctx: ProjectContext, timeoutMs: number): Promise<number> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const pending = (await ctx.inbox.pending()).length
    if (pending > 0 || Date.now() >= until) return pending
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, until - Date.now()))))
  }
}

export function createApp(o: { env: NodeJS.ProcessEnv; backendFor: (repo: string) => BackendFor; now?: () => Date; tickMs?: number; uiDir?: string }) {
  const now = o.now ?? (() => new Date())
  const registry = createRegistry(o.env)
  const projects = new Map<string, Promise<ProjectContext>>()
  const live = createLive()
  const history = createHistory({ env: o.env })

  const open = (repo: string): Promise<ProjectContext> => {
    const known = projects.get(repo)
    if (known) return known
    const made = (async () => {
      const store = createEventStore(repo)
      store.onAppend((e) => live.publish({ project: repo, goalId: e.goalId, seq: e.seq }))
      const pool = createPool({ backendFor: o.backendFor(repo), runsDir: runsDir(repo), claudeProjectsDir: claudeProjectsRoot(o.env) })
      let chain: Promise<unknown> = Promise.resolve()
      let ticking: Promise<void> | undefined
      const ctx: ProjectContext = {
        repo,
        store,
        inbox: createInbox(store),
        supervisor: createSupervisor({ repo, store, pool, now, worktree: gitWorktree }),
        exclusive(fn) {
          const next = chain.then(() => fn(ctx))
          chain = next.catch(() => undefined)
          return next
        },
        register: () => registry.add(repo),
        tickOnce() {
          ticking ??= ctx.exclusive((c) => c.supervisor.tick()).finally(() => {
            ticking = undefined
          })
          return ticking
        },
      }
      return ctx
    })()
    projects.set(repo, made)
    made.catch(() => projects.delete(repo))
    return made
  }
  const projectOf = async (path: string) => open(await resolveRepo(path))
  const str = (v: unknown, name: string) => {
    if (typeof v !== 'string') throw new BadRequestError(`${name} is required`)
    return v
  }
  const commands = createLeadCommands(projectOf, now)

  const tick = async () => {
    for (const repo of await registry.list()) {
      try {
        await (await open(repo)).tickOnce()
      } catch (error) {
        console.error(`[crewboard] tick ${repo}:`, error)
      }
    }
  }

  const http = createHttpServer({
    live,
    ...(o.uiDir ? { uiDir: o.uiDir } : {}),
    mcp: () => createLeadMcp(commands),
    async wait(project, timeoutMs) {
      const ctx = await projectOf(project)
      // A lead waiting for news is present: touch every goal of the project when the wait starts and ends.
      const touch = async () => {
        for (const g of await ctx.store.listGoals()) await ctx.store.touchLead(g.goalId, now())
      }
      await touch()
      try {
        return await waitPending(ctx, timeoutMs)
      } finally {
        await touch()
      }
    },
    async goals(project) {
      return (await projectOf(project)).store.listGoals()
    },
    async goal(project, goalId) {
      return goalTree(await projectOf(project), goalId, now())
    },
    async projects() {
      const repos = await registry.list()
      return Promise.all(repos.map(async (repo) => summarize(await open(repo), now())))
    },
    async analytics(project, goalId) {
      const ctx = await projectOf(project)
      await goalTree(ctx, goalId, now())
      return goalAnalytics(await ctx.store.read(goalId), now())
    },
    async history(project, goalId) {
      const ctx = await projectOf(project)
      await goalTree(ctx, goalId, now())
      return history.goalHistory(ctx.repo, goalId)
    },
    async events(project, goalId, assignmentId) {
      return nodeEvents(await projectOf(project), goalId, assignmentId)
    },
    async request(body) {
      const ctx = await projectOf(str(body.project, 'project'))
      const action = str(body.action, 'action')
      if (!(REQUEST_ACTIONS as readonly string[]).includes(action)) throw new BadRequestError(`unknown action ${action}`)
      const provider = typeof body.provider === 'string' ? body.provider : undefined
      if (provider && !(PROVIDERS as readonly string[]).includes(provider)) throw new BadRequestError(`unknown provider ${provider}`)
      return requestAsOwner(ctx, {
        goalId: str(body.goalId, 'goalId'), assignmentId: str(body.assignmentId, 'assignmentId'), action: action as RequestAction,
        ...(typeof body.text === 'string' ? { text: body.text } : {}), ...(provider ? { provider: provider as ProviderId } : {}),
      }, now())
    },
    async emergencyStop(body) {
      const ctx = await projectOf(str(body.project, 'project'))
      await emergencyStop(ctx, { goalId: str(body.goalId, 'goalId'), assignmentId: str(body.assignmentId, 'assignmentId') }, now())
    },
    async answer(body) {
      const ctx = await projectOf(str(body.project, 'project'))
      await answerAsOwner(ctx, { goalId: str(body.goalId, 'goalId'), assignmentId: str(body.assignmentId, 'assignmentId'), text: str(body.text, 'text') }, now())
    },
    statusOf: (error) => (error instanceof ConflictError ? 409 : 400),
  }, { now: () => now().getTime() })

  return {
    commands,
    tick,
    sweepSessions: () => http.sweep(),
    mcpSessions: () => http.sessionCount(),
    async listen(port: number) {
      const server = await http.listen(port)
      const timer = setInterval(() => {
        tick().catch((error: unknown) => console.error('[crewboard] tick:', error))
      }, o.tickMs ?? 2000)
      const sweeper = setInterval(() => void http.sweep(), 60_000)
      return {
        url: server.url,
        async close() {
          clearInterval(timer)
          clearInterval(sweeper)
          await server.close()
        },
      }
    },
  }
}
