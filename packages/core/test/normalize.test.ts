import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { RawEvent } from '../src/runs/raw-event.js'
import { normalize } from '../src/runs/normalize.js'

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

  it('understands dsh tool payloads and permission denials', () => {
    const feed = normalize([
      { ts: 't1', type: 'tool_started', backend: 'dsh', data: { tool: 'write', status: 'running', input: { file_path: '/wt/src/a.ts' } } },
      { ts: 't2', type: 'tool_started', backend: 'dsh', data: { tool: 'read', status: 'running', input: { file_path: 'b.ts' } } },
      { ts: 't3', type: 'permission_denied', backend: 'dsh', data: '{"toolCallId":"c2"}' },
    ])
    expect(feed.map((e) => [e.kind, e.text])).toEqual([
      ['file', 'a.ts'],
      ['action', 'Read b.ts'],
      ['problem', 'выход за песочницу отклонён: {"toolCallId":"c2"}'],
    ])
  })
})
