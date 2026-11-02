import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEventStore } from '../src/store/event-store.js'
import { createInbox } from '../src/store/inbox.js'
import { goalDir } from '../src/store/paths.js'
import type { NewEvent } from '../src/model/types.js'

const repo = () => mkdtemp(join(tmpdir(), 'cb-store-'))
const progress = (i: number): NewEvent => ({ type: 'progress', goalId: 'g1', assignmentId: 'a', actor: 'worker', text: `step ${i}` })

describe('event store', () => {
  it('numbers concurrent appends without gaps or repeats', async () => {
    const store = createEventStore(await repo())
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append('g1', progress(i))))
    const events = await store.read('g1')
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('skips a truncated last line left by a crash', async () => {
    const root = await repo()
    const store = createEventStore(root)
    for (let i = 0; i < 3; i++) await store.append('g1', progress(i))
    await appendFile(join(goalDir(root, 'g1'), 'events.jsonl'), '{"seq":4,')
    expect((await createEventStore(root).read('g1')).length).toBe(3)
  })

  it('keeps project data out of git', async () => {
    const root = await repo()
    await createEventStore(root).append('g1', progress(0))
    expect(await readFile(join(root, '.crewboard', '.gitignore'), 'utf8')).toBe('*\n')
  })
})

describe('lead inbox', () => {
  it('delivers lead-addressed events once and remembers delivery on disk', async () => {
    const root = await repo()
    const store = createEventStore(root)
    await store.writeMeta({ goalId: 'g1', title: 'Кухня', createdAt: new Date().toISOString() })
    await store.append('g1', progress(0))
    const q = await store.append('g1', { type: 'question', goalId: 'g1', assignmentId: 'a', actor: 'worker', text: 'Шторка?', options: [] })
    const inbox = createInbox(store)
    expect((await inbox.pending()).map((e) => e.type)).toEqual(['question'])
    await inbox.ack('g1', q.seq)
    expect(await inbox.pending()).toEqual([])
    expect(await createInbox(createEventStore(root)).pending()).toEqual([])
  })
})
