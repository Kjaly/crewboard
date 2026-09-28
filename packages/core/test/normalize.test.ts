import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { RawEvent } from '../src/runs/raw-event.js'
import { compactNormEvents, normalize } from '../src/runs/normalize.js'

const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as RawEvent[]

describe('normalize', () => {
  it('turns an OpenCode run into a short meaningful feed', async () => {
    const feed = normalize(await fixture('opencode-run.json'))
    expect(feed.map((e) => [e.kind, e.text])).toEqual([
      ['action', "node -e 'console.log(1)'"],
      ['message', 'Confirmed ground truth. Now writing both files:'],
      ['file', 'pluralize-ru.test.ts'],
      ['problem', 'edit failed'],
      ['problem', 'permission_required: external_directory'],
    ])
  })

  it('turns a Devin run into a feed and keeps string tool data', async () => {
    const feed = normalize(await fixture('devin-run.json'))
    expect(feed.map((e) => e.kind)).toEqual(['message', 'action', 'file', 'action', 'problem'])
    expect(feed[0]?.text).toBe("I'll start by reading the two files.")
    expect(feed[4]?.text).toMatch(/OAuth session expired/)
  })

  it('keeps the timestamp of the first chunk of a merged message', async () => {
    const feed = normalize(await fixture('devin-run.json'))
    expect(feed[0]?.ts).toBe('2026-09-22T11:09:12.100000+00:00')
  })

  it('clips long texts to 200 characters', () => {
    const feed = normalize([{ ts: 't', type: 'tool_started', data: 'x'.repeat(500) }])
    expect(feed[0]?.text.length).toBe(200)
  })

  // st2: a worker running a long foreground command is not a failure — the feed says whether its last
  // command is still in flight (no result yet) so the watch can tell that apart from a quiet run.
  describe('a command in flight (st2)', () => {
    it('marks a started tool call open until its result arrives, by callId', () => {
      const feed = normalize([
        { ts: 't1', type: 'tool_started', backend: 'claude', data: { tool: 'bash', status: 'running', callId: 'c1', input: { command: 'pnpm test' } } },
      ])
      expect(feed).toMatchObject([{ kind: 'action', text: 'pnpm test', open: true }])
    })

    it('closes it once the matching result arrives, whether it succeeded or failed', () => {
      const success = normalize([
        { ts: 't1', type: 'tool_started', backend: 'claude', data: { tool: 'bash', status: 'running', callId: 'c1', input: { command: 'pnpm test' } } },
        { ts: 't2', type: 'tool_completed', backend: 'claude', data: { tool: 'bash', status: 'completed', callId: 'c1', output: 'ok' } },
      ])
      expect(success.map((e) => e.open)).toEqual([undefined])

      const failed = normalize([
        { ts: 't1', type: 'tool_started', backend: 'claude', data: { tool: 'bash', status: 'running', callId: 'c1', input: { command: 'pnpm test' } } },
        { ts: 't2', type: 'tool_completed', backend: 'claude', data: { tool: 'bash', status: 'error', callId: 'c1', output: 'boom' } },
      ])
      expect(failed.map((e) => [e.kind, e.open])).toEqual([
        ['action', undefined],
        ['problem', undefined],
      ])
    })

    it('never opens a call from a backend that does not pair a start with a callId (Devin)', () => {
      const feed = normalize([{ ts: 't1', type: 'tool_started', backend: 'devin', data: 'Read file' }])
      expect(feed[0]).toMatchObject({ kind: 'action' })
      expect(feed[0]).not.toHaveProperty('open')
    })
  })

  it('understands dsh tool payloads and permission denials', () => {
    const feed = normalize([
      { ts: 't1', type: 'tool_started', backend: 'dsh', data: { tool: 'write', status: 'running', input: { file_path: '/wt/src/a.ts' } } },
      { ts: 't2', type: 'tool_started', backend: 'dsh', data: { tool: 'read', status: 'running', input: { file_path: 'b.ts' } } },
      { ts: 't3', type: 'permission_denied', backend: 'dsh', data: '{"toolCallId":"c2"}' },
    ])
    expect(feed.map((e) => [e.kind, e.text])).toEqual([
      ['file', 'a.ts'],
      ['action', 'Read b.ts'],
      ['problem', 'a request to leave the sandbox was refused: {"toolCallId":"c2"}'],
    ])
    // fo1: the screen and the CLI say it from the code, in the reader's language.
    expect(feed[2]?.note).toEqual({ code: 'sandbox_denied', detail: '{"toolCallId":"c2"}' })
  })

  // The public explanation keeps its paragraphs; only `text` stays the 200-character single-line summary.
  describe('public display text', () => {
    it('keeps line breaks in display while text stays one clipped line', () => {
      const raw = { ts: 't', type: 'answer_delta', data: 'First line.\n\n  Second line with **markup** and `code`.\n' }
      const [event] = normalize([raw])
      expect(event?.kind).toBe('message')
      expect(event?.display).toBe('First line.\n\n  Second line with **markup** and `code`.')
      expect(event?.text).toBe('First line. Second line with **markup** and `code`.')
    })

    it('keeps the first ts as identity and records the last real chunk time', () => {
      const feed = normalize([
        { ts: 't1', type: 'answer_delta', data: 'A' },
        { ts: 't2', type: 'answer_delta', data: 'B' },
      ])
      expect(feed).toHaveLength(1)
      expect(feed[0]?.ts).toBe('t1')
      expect(feed[0]?.updatedAt).toBe('t2')
      expect(feed[0]?.display).toBe('AB')
    })

    it('grows display while the 200-character summary stays identical', () => {
      const chunk = 'x'.repeat(100)
      const first = normalize([{ ts: 't1', type: 'answer_delta', data: chunk + chunk + chunk }])[0]
      const second = normalize([
        { ts: 't1', type: 'answer_delta', data: chunk + chunk + chunk },
        { ts: 't2', type: 'answer_delta', data: chunk },
      ])[0]
      expect(first?.text).toBe(second?.text)
      expect(second?.display?.length).toBe((first?.display?.length ?? 0) + 100)
      expect(second?.updatedAt).toBe('t2')
    })

    it('bounds one explanation by UTF-8 bytes and marks a real source truncation', () => {
      const [event] = normalize([{ ts: 't', type: 'final', data: 'x'.repeat(10_000) }])
      expect(Buffer.byteLength(event?.display ?? '', 'utf8')).toBe(8 * 1024)
      expect(event?.display?.endsWith('…')).toBe(true)
      expect(event?.truncated).toBe(true)
      // The summary field keeps its old shape for every existing consumer.
      expect(event?.text.length).toBe(200)
    })

    it('counts Cyrillic display in bytes, never claiming a character limit as bytes', () => {
      const [event] = normalize([{ ts: 't', type: 'final', data: 'я'.repeat(5000) }])
      const bytes = Buffer.byteLength(event?.display ?? '', 'utf8')
      expect(bytes).toBeLessThanOrEqual(8 * 1024)
      expect(bytes).toBeGreaterThan(8 * 1024 - 4)
      // 5000 Cyrillic characters are 10 000 bytes: the bound is reached before the string ends.
      expect(event?.display?.length).toBeLessThan(4200)
    })

    it('spends the aggregate budget on the newest messages, never on ancient ones', () => {
      const events = Array.from({ length: 40 }, (_, i) => ({ ts: `t${i}`, type: 'final', data: `${i}:`.padEnd(1000, 'y') }))
      const feed = normalize(events)
      const total = feed.reduce((n, e) => n + Buffer.byteLength(e.display ?? '', 'utf8'), 0)
      expect(total).toBeLessThanOrEqual(32 * 1024)
      // The latest intent keeps its full text; the oldest falls back to the summary and is marked truncated.
      expect(feed.at(-1)?.display?.length).toBe(1000)
      expect(feed[0]?.display).toBeUndefined()
      expect(feed[0]?.truncated).toBe(true)
      expect(feed[0]?.text.length).toBe(200)
    })

    it('never exposes an unknown result object, reasoning or usage as chat', () => {
      const feed = normalize([
        { ts: 't1', type: 'final', data: { thinking: 'secret', usage: { tokens: 5 }, nested: { deep: true } } },
        { ts: 't2', type: 'result', data: { answer: 'A public answer' } },
        { ts: 't3', type: 'final', data: '{"text":"literal JSON string"}' },
      ])
      expect(feed[0]?.display).toBeUndefined()
      expect(feed[0]?.text).toBe('{"thinking":"secret","usage":{"tokens":5},"nested":{"deep":true}}')
      expect(feed[1]?.display).toBe('A public answer')
      // A public literal JSON string stays the worker's own words.
      expect(feed[2]?.display).toBe('{"text":"literal JSON string"}')
    })

    it('never exposes thinking, usage or reasoning as display', () => {
      const feed = normalize([
        { ts: 't1', type: 'thinking_delta', data: 'secret chain of thought' },
        { ts: 't2', type: 'usage', data: { tokens: 10 } },
        { ts: 't3', type: 'progress', data: { unknownType: 'x' } },
      ])
      expect(feed.map((e) => e.kind)).toEqual(['action'])
      expect(feed[0]?.display).toBeUndefined()
    })

    it('survives a JSON round trip with the optional fields absent', () => {
      const feed = normalize([{ ts: 't', type: 'tool_started', data: 'Read file' }])
      expect(JSON.parse(JSON.stringify(feed))).toEqual(feed)
    })
  })

  describe('typed tool metadata and problem origin', () => {
    it('reads a known operation and target only from the backend tool name and input', () => {
      const feed = normalize([
        { ts: 't1', type: 'tool_started', backend: 'dsh', data: { tool: 'write', status: 'running', input: { file_path: '/wt/src/a.ts' } } },
        { ts: 't2', type: 'tool_started', backend: 'dsh', data: { tool: 'read', status: 'running', input: { file_path: 'b.ts' } } },
        { ts: 't3', type: 'tool_started', backend: 'dsh', data: { tool: 'bash', status: 'running', input: { command: 'pnpm test' } } },
      ])
      expect(feed.map((e) => e.tool)).toEqual([
        { name: 'write', op: 'write', target: '/wt/src/a.ts' },
        { name: 'read', op: 'read', target: 'b.ts' },
        { name: 'bash', op: 'command', target: 'pnpm test' },
      ])
    })

    it('claims no operation for an unknown tool or a backend without metadata', () => {
      const feed = normalize([
        { ts: 't1', type: 'tool_started', backend: 'dsh', data: { tool: 'mystery', status: 'running', input: { file_path: '/wt/src/a.ts' } } },
        { ts: 't2', type: 'tool_started', backend: 'devin', data: 'Edit src/a.ts' },
      ])
      expect(feed[0]?.tool).toBeUndefined()
      expect(feed[1]?.tool).toBeUndefined()
    })

    it('names the layer of every problem so a tool error is not a run failure', () => {
      const feed = normalize([
        { ts: 't1', type: 'tool_completed', backend: 'dsh', data: { tool: 'edit', status: 'error' } },
        { ts: 't2', type: 'run_failed', data: 'boom' },
        { ts: 't3', type: 'permission_denied', data: 'x' },
        { ts: 't4', type: 'rate_limited', data: {} },
        { ts: 't5', type: 'run_interrupted', data: { workerPid: 7, workerStopped: true } },
      ])
      expect(feed.map((e) => e.origin)).toEqual(['tool', 'run', 'permission', 'limit', 'interrupt'])
    })
  })

  // Machine surfaces (`task show --json`, `orchestra_task`, `orchestra_events`) must not ship the browser's
  // bounded display text or tool metadata into every orchestrator call.
  describe('compact machine events', () => {
    it('keeps the legacy shape and drops UI-only fields, leaving the rich detail untouched', () => {
      const rich = normalize([
        { ts: 't1', type: 'tool_started', backend: 'dsh', data: { tool: 'write', status: 'running', input: { file_path: '/wt/a.ts' } } },
        { ts: 't2', type: 'answer_delta', data: 'A public\nanswer' },
      ])
      const compact = compactNormEvents(rich)
      expect(compact).toEqual([
        { ts: 't1', kind: 'file', text: 'a.ts' },
        { ts: 't2', kind: 'message', text: 'A public answer' },
      ])
      expect(compact[0]).not.toHaveProperty('tool')
      expect(compact[1]).not.toHaveProperty('display')
      expect(rich[0]?.tool).toEqual({ name: 'write', op: 'write', target: '/wt/a.ts' })
      expect(rich[1]?.display).toBe('A public\nanswer')
    })
  })
})

it('keeps a reused CLI tool id in a new turn open after the earlier turn completed', () => {
  const event = (type: string, data: unknown): RawEvent => ({ type, ts: '2026-09-28T16:00:00Z', data })
  const result = normalize([
    event('turn_started', { turn: 1 }),
    event('tool_started', { callId: 'item_0', tool: 'bash', status: 'running', input: { command: 'first' } }),
    event('tool_completed', { callId: 'item_0', tool: 'bash', status: 'completed' }),
    event('turn_started', { turn: 2 }),
    event('tool_started', { callId: 'item_0', tool: 'bash', status: 'running', input: { command: 'second' } }),
  ])
  expect(result[0]?.open).toBeUndefined()
  expect(result[1]?.open).toBe(true)
})

it('keeps completed-before-start delivery closed within the same turn', () => {
  const event = (type: string, data: unknown): RawEvent => ({ type, ts: '2026-09-28T16:00:00Z', data })
  const result = normalize([
    event('turn_started', { turn: 1 }),
    event('tool_completed', { callId: 'item_0', tool: 'bash', status: 'completed' }),
    event('tool_started', { callId: 'item_0', tool: 'bash', status: 'running', input: { command: 'done' } }),
  ])
  expect(result[0]?.open).toBeUndefined()
})
