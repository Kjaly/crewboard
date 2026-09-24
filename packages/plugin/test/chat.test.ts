import type { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type Attention, type AttentionKind, type Backends, type RepoSnapshot, initPlan, newTask, updatePlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import { type ChatDeps, bindChat, createChatWaker, openChat, readChats, writeChats } from '../src/host/chat.js'
import type { SessionControllerFace } from '../src/host/dsh.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'
import { API_PREFIX, type OrchestraSnapshot } from '../src/shared/types.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const now = () => NOW
const idle: Backends = { forAgent: async () => Promise.reject(new Error('none')) }

type PromptCall = { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: { type: 'text'; text: string }[] }

function makeSessions() {
  const creates: Array<{ cwd?: string }> = []
  const prompts: PromptCall[] = []
  let inspectThrows = false
  let promptError: Error | undefined
  const sessions: SessionControllerFace = {
    create: async (request) => {
      creates.push(request)
      return { sessionId: `sess-${creates.length}` }
    },
    prompt: async (request) => {
      if (promptError) {
        const err = promptError
        promptError = undefined
        throw err
      }
      prompts.push(request)
      return { accepted: true }
    },
    inspect: async (sessionId) => {
      if (inspectThrows) throw new Error(`no session ${sessionId}`)
      return { sessionId }
    },
  }
  return {
    sessions,
    creates,
    prompts,
    inspectThrows: (v: boolean) => {
      inspectThrows = v
    },
    failNextPrompt: () => {
      promptError = new Error('prompt failed')
    },
  }
}

let ids = 0
const newId = () => `req-${++ids}`
const deps = (sessions: SessionControllerFace, readTask?: ChatDeps['readTask']): ChatDeps => ({ sessions, now, newId, ...(readTask ? { readTask } : {}) })

async function emptyRepo(goal = 'Собрать оркестр'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orch-chat-'))
  await initPlan(root, goal, NOW)
  return root
}

const attention = (taskId: string, kind: AttentionKind): Attention => ({
  kind,
  severity: kind === 'failed' ? 'alert' : 'warn',
  taskId,
  runId: `run_${taskId}`,
  message: `сообщение ${taskId}`,
})

const snapshot = (root: string, items: Attention[]): OrchestraSnapshot => {
  const repo: RepoSnapshot = {
    root,
    goal: 'Собрать оркестр',
    planId: 'main',
    rev: 1,
    updatedAt: 't',
    tasks: [
      { id: 't1', title: 'Первая', kind: 'implement', status: 'running', deps: [], blockedBy: [], needsHuman: false, runs: 1 },
      { id: 't2', title: 'Вторая', kind: 'implement', status: 'running', deps: [], blockedBy: [], needsHuman: false, runs: 1 },
    ],
    ready: [],
    criticalPath: [],
    attention: items,
    degraded: false,
  }
  return { generatedAt: 't', repos: [repo], workers: [] }
}

function manualSchedule() {
  const queue: Array<() => unknown> = []
  return {
    schedule: (fn: () => void) => {
      queue.push(fn)
      return queue.length
    },
    run: async () => {
      await queue.at(-1)?.()
    },
    size: () => queue.length,
  }
}

describe('openChat', () => {
  it('creates a session, writes the binding and sends the briefing once', async () => {
    const root = await emptyRepo()
    const { sessions, creates, prompts } = makeSessions()
    const first = await openChat(deps(sessions), { root, planId: 'main' })
    expect(first).toEqual({ sessionId: 'sess-1', created: true })
    expect(creates).toEqual([{ cwd: root }])
    expect(await readChats(root)).toMatchObject({ main: { sessionId: 'sess-1', wake: true } })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionId: 'sess-1', mode: 'queue', content: [{ type: 'text' }] })
    expect(prompts[0]?.content[0]?.text).toContain('You are the orchestrator for plan')
    expect(prompts[0]?.content[0]?.text).toContain('Собрать оркестр')
    const again = await openChat(deps(sessions), { root, planId: 'main' })
    expect(again).toEqual({ sessionId: 'sess-1', created: false })
    expect(creates).toHaveLength(1)
    expect(prompts).toHaveLength(1)
  })

  it('creates a new session when the bound one no longer exists', async () => {
    const root = await emptyRepo()
    const fake = makeSessions()
    await openChat(deps(fake.sessions), { root, planId: 'main' })
    fake.inspectThrows(true)
    const res = await openChat(deps(fake.sessions), { root, planId: 'main' })
    expect(res).toEqual({ sessionId: 'sess-2', created: true })
    expect(fake.creates).toHaveLength(2)
    expect((await readChats(root)).main?.sessionId).toBe('sess-2')
  })

  it('sends the task brief when a taskId is given, even for an existing chat', async () => {
    const root = await emptyRepo()
    const fake = makeSessions()
    const readTask: ChatDeps['readTask'] = async () => ({
      task: { id: 't1', title: 'Первая', status: 'in_review', worker: 'dsh', contract: 'docs/t1.contract.md' },
      lastEvents: ['запуск завершён'],
    })
    await openChat(deps(fake.sessions), { root, planId: 'main' })
    fake.prompts.length = 0
    const res = await openChat(deps(fake.sessions, readTask), { root, planId: 'main', taskId: 't1' })
    expect(res.created).toBe(false)
    expect(fake.creates).toHaveLength(1)
    expect(fake.prompts).toHaveLength(1)
    const brief = fake.prompts[0]?.content[0]?.text ?? ''
    expect(brief).toContain('t1')
    expect(brief).toContain('docs/t1.contract.md')
    expect(brief).toContain('awaiting review')
    expect(brief).toContain('Suggest what to do and ask the user')
  })

  it('sends the briefing and then a task brief when opening a chat for a task', async () => {
    const root = await emptyRepo()
    const { sessions, prompts } = makeSessions()
    await updatePlan(root, (p) => {
      p.tasks.push(newTask({ id: 't9', title: 'Проверить', contract: 'docs/t9.md' }))
      return p
    })
    await openChat(deps(sessions), { root, planId: 'main', taskId: 't9' })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.content[0]?.text).toContain('You are the orchestrator for plan')
    const brief = prompts[1]?.content[0]?.text ?? ''
    expect(brief).toContain('t9')
    expect(brief).toContain('docs/t9.md')
  })
})

describe('bindChat', () => {
  it('binds an existing session to the plan and sends the briefing', async () => {
    const root = await emptyRepo()
    const { sessions, creates, prompts } = makeSessions()
    const bound = await bindChat(deps(sessions), { root, planId: 'main', sessionId: 'sess-live' })
    expect(bound.binding).toMatchObject({ sessionId: 'sess-live', wake: true })
    expect(creates).toHaveLength(0)
    expect(await readChats(root)).toMatchObject({ main: { sessionId: 'sess-live', wake: true } })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionId: 'sess-live', mode: 'queue' })
    expect(prompts[0]?.content[0]?.text).toContain('You are the orchestrator for plan')
  })

  it('rebinds a plan that already had a chat', async () => {
    const root = await emptyRepo()
    const { sessions } = makeSessions()
    await openChat(deps(sessions), { root, planId: 'main' })
    const bound = await bindChat(deps(sessions), { root, planId: 'main', sessionId: 'sess-other' })
    expect(bound.binding.sessionId).toBe('sess-other')
    expect((await readChats(root)).main?.sessionId).toBe('sess-other')
  })

  it('rejects a session id dsh does not know', async () => {
    const root = await emptyRepo()
    const fake = makeSessions()
    fake.inspectThrows(true)
    await expect(bindChat(deps(fake.sessions), { root, planId: 'main', sessionId: 'sess-gone' })).rejects.toMatchObject({
      name: 'ChatBindingError',
      code: 'unknown_session',
    })
    expect(await readChats(root)).toEqual({})
  })
})

describe('createChatWaker', () => {
  it('keeps the first snapshot as a baseline and groups the alerts of one plan into one prompt', async () => {
    const root = await emptyRepo()
    await writeChats(root, { main: { sessionId: 'sess-1', wake: true, boundAt: 't' } })
    const { sessions, prompts } = makeSessions()
    const sched = manualSchedule()
    const waker = createChatWaker({ ...deps(sessions), windowMs: 5000, schedule: sched.schedule })
    waker(snapshot(root, []))
    waker(snapshot(root, [attention('t1', 'stalled')]))
    waker(snapshot(root, [attention('t1', 'stalled'), attention('t2', 'failed')]))
    expect(prompts).toHaveLength(0)
    await sched.run()
    expect(prompts).toHaveLength(1)
    const text = prompts[0]?.content[0]?.text ?? ''
    expect(prompts[0]?.sessionId).toBe('sess-1')
    expect(prompts[0]?.mode).toBe('queue')
    expect(text).toContain('[crewboard] Orchestrator action needed')
    expect(text).toContain('t1')
    expect(text).toContain('t2')
    expect(text).toContain('never accept it yourself')
  })

  it('does not wake a plan whose chat is muted', async () => {
    const root = await emptyRepo()
    await writeChats(root, { main: { sessionId: 'sess-1', wake: false, boundAt: 't' } })
    const { sessions, prompts } = makeSessions()
    const sched = manualSchedule()
    const waker = createChatWaker({ ...deps(sessions), windowMs: 5000, schedule: sched.schedule })
    waker(snapshot(root, []))
    waker(snapshot(root, [attention('t1', 'stalled')]))
    await sched.run()
    expect(prompts).toHaveLength(0)
  })

  it('does not re-send a key recorded in chat-woken.json, even to a fresh waker', async () => {
    const root = await emptyRepo()
    await writeChats(root, { main: { sessionId: 'sess-1', wake: true, boundAt: 't' } })
    const first = makeSessions()
    const s1 = manualSchedule()
    const w1 = createChatWaker({ ...deps(first.sessions), windowMs: 5000, schedule: s1.schedule })
    w1(snapshot(root, []))
    w1(snapshot(root, [attention('t1', 'stalled')]))
    await s1.run()
    expect(first.prompts).toHaveLength(1)

    const second = makeSessions()
    const s2 = manualSchedule()
    const w2 = createChatWaker({ ...deps(second.sessions), windowMs: 5000, schedule: s2.schedule })
    w2(snapshot(root, []))
    w2(snapshot(root, [attention('t1', 'stalled')]))
    expect(s2.size()).toBe(1)
    await s2.run()
    expect(second.prompts).toHaveLength(0)
  })

  it('retries a key on the next snapshot when its prompt fails', async () => {
    const root = await emptyRepo()
    await writeChats(root, { main: { sessionId: 'sess-1', wake: true, boundAt: 't' } })
    const fake = makeSessions()
    const sched = manualSchedule()
    const waker = createChatWaker({ ...deps(fake.sessions), windowMs: 5000, schedule: sched.schedule })
    waker(snapshot(root, []))
    waker(snapshot(root, [attention('t1', 'stalled')]))
    fake.failNextPrompt()
    await sched.run()
    expect(fake.prompts).toHaveLength(0)
    waker(snapshot(root, [attention('t1', 'stalled')]))
    expect(sched.size()).toBe(2)
    await sched.run()
    expect(fake.prompts).toHaveLength(1)
  })
})

describe('createChatWaker and the orchestrator check (vr1)', () => {
  const withTask = (root: string, task: Partial<RepoSnapshot['tasks'][number]>): OrchestraSnapshot => {
    const base = snapshot(root, [])
    const repo = base.repos[0]!
    return { ...base, repos: [{ ...repo, tasks: [{ id: 't1', title: 'Первая', kind: 'implement', status: 'running', deps: [], blockedBy: [], needsHuman: false, runs: 1, lastRunId: 'run_1', ...task }] }] }
  }
  it('wakes the orchestrator to check finished work, and says nothing more once it has checked it', async () => {
    const root = await emptyRepo()
    await writeChats(root, { main: { sessionId: 'sess-1', wake: true, boundAt: 't' } })
    const { sessions, prompts } = makeSessions()
    const sched = manualSchedule()
    const waker = createChatWaker({ ...deps(sessions), windowMs: 5000, schedule: sched.schedule })
    waker(withTask(root, {}))
    waker(withTask(root, { status: 'in_review', check: 'pending' }))
    await sched.run()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.content[0]?.text).toContain('t1 «Первая» — check_due: Run finished — check it: orch verify t1')
    waker(withTask(root, { status: 'in_review', check: 'checking' }))
    waker(withTask(root, { status: 'in_review', check: 'checked' }))
    await sched.run()
    expect(prompts).toHaveLength(1)
  })
})

describe('chat routes', () => {
  it('answers 503 from the chat routes when dsh has no session controller', async () => {
    const root = await emptyRepo()
    const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now })
    const routes = actionRoutes({ service, repos: [root], backendsFor: () => idle, native: native(), env: {}, home: root, now })
    const post = async (name: string, body: unknown) => {
      const route = routes.find((r) => r.path === `${API_PREFIX}/${name}`)
      if (!route) throw new Error(`no ${name} route`)
      const res = fakeRes()
      await route.handler(fakeReq(body), res as unknown as ServerResponse)
      return res
    }
    const open = await post('chat-open', { repo: root })
    expect(open.status).toBe(503)
    expect(JSON.parse(open.body)).toMatchObject({ ok: false, error: 'chat_unavailable' })
    const bind = await post('chat-bind', { repo: root, sessionId: 'sess-1' })
    expect(bind.status).toBe(503)
    expect(JSON.parse(bind.body)).toMatchObject({ ok: false, error: 'chat_unavailable' })
    const wake = await post('chat-wake', { repo: root, plan: 'main', wake: false })
    expect(wake.status).toBe(503)
    expect(JSON.parse(wake.body)).toMatchObject({ ok: false, error: 'chat_unavailable' })
  })

  it('opens a chat and exposes the binding on the plan summary', async () => {
    const root = await emptyRepo()
    const fake = makeSessions()
    const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now, chatsFor: readChats })
    const routes = actionRoutes({
      service,
      repos: [root],
      backendsFor: () => idle,
      native: native(),
      env: {},
      home: root,
      now,
      sessions: () => fake.sessions,
      newId,
    })
    const open = routes.find((r) => r.path === `${API_PREFIX}/chat-open`)
    if (!open) throw new Error('no chat-open route')
    const opened = fakeRes()
    await open.handler(fakeReq({ repo: root }), opened as unknown as ServerResponse)
    expect(opened.status).toBe(200)
    expect(JSON.parse(opened.body)).toMatchObject({ ok: true, value: { sessionId: 'sess-1', created: true } })
    const snap = service.snapshot()
    expect(snap.repos[0]?.plans?.[0]).toMatchObject({ id: 'main', chat: { sessionId: 'sess-1', wake: true } })

    const wake = routes.find((r) => r.path === `${API_PREFIX}/chat-wake`)
    if (!wake) throw new Error('no chat-wake route')
    const toggled = fakeRes()
    await wake.handler(fakeReq({ repo: root, plan: 'main', wake: false }), toggled as unknown as ServerResponse)
    expect(toggled.status).toBe(200)
    expect(JSON.parse(toggled.body)).toMatchObject({ ok: true, value: { sessionId: 'sess-1', wake: false } })
  })

  it('binds the panel session through chat-bind and shows it on the plan summary', async () => {
    const root = await emptyRepo()
    const fake = makeSessions()
    const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now, chatsFor: readChats })
    const routes = actionRoutes({
      service,
      repos: [root],
      backendsFor: () => idle,
      native: native(),
      env: {},
      home: root,
      now,
      sessions: () => fake.sessions,
      newId,
    })
    const bind = routes.find((r) => r.path === `${API_PREFIX}/chat-bind`)
    if (!bind) throw new Error('no chat-bind route')
    const bound = fakeRes()
    await bind.handler(fakeReq({ repo: root, sessionId: 'sess-9' }), bound as unknown as ServerResponse)
    expect(bound.status).toBe(200)
    expect(JSON.parse(bound.body)).toMatchObject({ ok: true, value: { binding: { sessionId: 'sess-9', wake: true } } })
    expect(fake.creates).toHaveLength(0)
    expect(fake.prompts[0]?.sessionId).toBe('sess-9')
    const snap = service.snapshot()
    expect(snap.repos[0]?.plans?.[0]).toMatchObject({ id: 'main', chat: { sessionId: 'sess-9', wake: true } })
  })
})

const native = (): Native => ({ confirm: async () => true, notify: async () => {} })

function fakeRes() {
  const res = { body: '', status: undefined as number | undefined, headers: undefined as Record<string, string> | undefined }
  Object.assign(res, {
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status
      res.headers = headers
      return res
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk
    },
  })
  return res
}

function fakeReq(body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage & EventEmitter
  Object.assign(req, { method: 'POST', url: `${API_PREFIX}/chat-open`, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
  return req
}
