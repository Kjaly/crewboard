import { vi } from 'vitest'
import type { Attention, OrchestraSnapshot, RepoSnapshot, TaskDetail, TaskSnapshot } from '../../src/shared/types.js'

export const ROOT = '/repo'

export function makeTask(p: Partial<TaskSnapshot> & { id: string }): TaskSnapshot {
  return { title: `Задача ${p.id}`, kind: 'implement', status: 'ready', deps: [], blockedBy: [], needsHuman: false, runs: 0, ...p }
}

export function makeRepo(tasks: TaskSnapshot[], attention: Attention[] = [], patch: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    root: ROOT,
    goal: 'цель плана',
    rev: 1,
    updatedAt: '2026-09-22T12:00:00Z',
    tasks,
    ready: tasks.filter((t) => t.status === 'ready').map((t) => t.id),
    criticalPath: [],
    attention,
    degraded: false,
    ...patch,
  }
}

export const makeSnapshot = (...repos: RepoSnapshot[]): OrchestraSnapshot => ({ generatedAt: '2026-09-22T12:00:00Z', repos, workers: [] })

export function makeDetail(p: Partial<TaskDetail> & { id: string }): TaskDetail {
  return {
    title: `Задача ${p.id}`,
    kind: 'implement',
    status: 'ready',
    deps: [],
    dependents: [],
    runs: [],
    notes: [],
    steers: [],
    events: [],
    changedFiles: [],
    verdict: { kind: 'result', facts: [] },
    ...p,
  }
}

/** jsdom ships no matchMedia: every view must ask for the motion preference and survive either answer. */
export function installMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('reduced-motion'),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  })
}

type Listener = (event: unknown) => void

/** Minimal EventSource: jsdom has none, and the store must drive the screen from `snapshot` frames. */
export class FakeEventSource {
  static last: FakeEventSource | undefined
  static opened = 0
  readonly listeners = new Map<string, Set<Listener>>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.last = this
    FakeEventSource.opened++
  }

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(fn)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) })
  }
}

export function installEventSource(): typeof FakeEventSource {
  FakeEventSource.last = undefined
  FakeEventSource.opened = 0
  Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, configurable: true, writable: true })
  return FakeEventSource
}

export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown }

export const jsonOk = (value: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }), text: async () => '' })
export const jsonFail = (error: string, status = 409) => ({ ok: false, status, json: async () => ({ ok: false, error }), text: async () => '' })
export const textOk = (text: string) => ({ ok: true, status: 200, json: async () => ({}), text: async () => text })

/**
 * Installs a fetch double. `handler` answers by URL; every call is recorded with its method,
 * headers and parsed JSON body so tests can assert the guarded POST contract.
 */
export function installFetch(handler: (url: string, call: FetchCall) => unknown): FetchCall[] {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = String(input)
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
    }
    calls.push(call)
    return handler(url, call) as Response
  })
  Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true, writable: true })
  return calls
}
