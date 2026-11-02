import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTree, flatten } from '../src/model/project.js'
import type { NewEvent } from '../src/model/types.js'
import { createEventStore } from '../src/store/event-store.js'
import { createInbox } from '../src/store/inbox.js'
import { runsDir } from '../src/store/paths.js'
import { createSupervisor, gitWorktree } from '../src/supervisor.js'
import { createPool } from '../src/workers/pool.js'
import { createFakeBackend } from './fake-backend.js'

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-sup-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  return dir
}

async function setup(fake = createFakeBackend(), repo?: string) {
  const root = repo ?? (await gitRepo())
  const store = createEventStore(root)
  const pool = createPool({ backendFor: async () => fake.backend, runsDir: runsDir(root) })
  const sup = createSupervisor({ repo: root, store, pool, now: () => new Date(), worktree: gitWorktree })
  return { root, store, pool, sup, fake }
}

const goal = async (store: ReturnType<typeof createEventStore>) => {
  await store.writeMeta({ goalId: 'g', title: 'Кухня', createdAt: new Date().toISOString(), leadLastSeen: new Date().toISOString() })
  await store.append('g', { type: 'goal_started', goalId: 'g', assignmentId: 'g', actor: 'lead', title: 'Кухня', criteria: [] })
}
const assign = (id: string, extra: Partial<Extract<NewEvent, { type: 'assigned' }>> = {}): NewEvent => ({
  type: 'assigned', goalId: 'g', assignmentId: id, actor: 'lead', parentId: 'g', title: id, criteria: [], resultKind: 'local', provider: 'claude', after: [], ...extra,
})
const statusOf = async (store: ReturnType<typeof createEventStore>, id: string) =>
  flatten(buildTree(await store.read('g'), new Date(), new Date())).find((n) => n.id === id)?.status
const typesOf = async (store: ReturnType<typeof createEventStore>, id: string) => (await store.read('g')).filter((e) => e.assignmentId === id).map((e) => e.type)

describe('supervisor', () => {
  it('starts queued work with the provider agent', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    const started = (await store.read('g')).find((e) => e.type === 'run_started')
    expect(started).toMatchObject({ assignmentId: 'a', agent: 'claude/sonnet' })
  })

  it('waits for `after` work to be done', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('x'))
    await store.append('g', assign('y', { after: ['x'] }))
    await sup.tick()
    expect(await typesOf(store, 'y')).toEqual(['assigned'])
    await store.append('g', { type: 'closed', goalId: 'g', assignmentId: 'x', actor: 'lead', summary: 'ok' })
    await sup.tick()
    expect(await typesOf(store, 'y')).toContain('run_started')
  })

  it('relays progress and a question, then waits for an answer', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ events: ['Пишет тесты. <crewboard-question>черновик</crewboard-question>'], final: '<crewboard-question>Шторка?\n\n- Да\n- Нет</crewboard-question>' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    expect(await typesOf(store, 'a')).toEqual(['assigned', 'run_started', 'progress', 'question', 'run_ended'])
    expect(await statusOf(store, 'a')).toBe('waiting_answer')
    const progress = (await store.read('g')).find((e) => e.type === 'progress')
    expect(progress).toMatchObject({ text: expect.not.stringContaining('<crewboard-') })
  })

  it('tells the lead when a run fails', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ fail: 'auth' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    const ended = (await createInbox(store).pending()).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ outcome: 'failed', reason: 'auth' })
  })

  it('records a launch the backend refuses as a failed run, tells the lead once and does not retry', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ refuse: 'Claude API-only policy refused this launch: anthropic_api_key_missing' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    expect(fake.runs.length).toBe(0)
    expect(await typesOf(store, 'a')).toEqual(['assigned', 'run_started', 'run_ended'])
    const ended = (await createInbox(store).pending()).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('anthropic_api_key_missing') })
  })

  it('relaunches a refused launch when the lead steers it', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ refuse: 'no key' }, { final: '<crewboard-report>ok</crewboard-report>' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    expect(await sup.deliver('g', 'a', 'ключ добавлен, повтори')).toBe('relaunched')
    expect(fake.runs.length).toBe(1)
  })

  it('keeps the report of a run that ended just before a message reached it', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: '<crewboard-report>first result</crewboard-report>' }, { hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    // The run already ended in its backend, but no tick has read it yet.
    expect(await sup.deliver('g', 'a', 'one more thing')).toBe('relaunched')
    expect(await typesOf(store, 'a')).toEqual(['assigned', 'run_started', 'reported', 'run_ended', 'run_started'])
    expect(fake.runs[1]!.prompt).toContain('first result')
  })

  it('keeps the rest of the project moving when one run cannot be read', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ hold: true, brokenFeed: true }, { hold: true })
    await goal(store)
    await store.append('g', assign('broken'))
    await sup.tick()
    await store.append('g', assign('next'))
    await sup.tick()
    expect(await typesOf(store, 'next')).toContain('run_started')
    const ended = (await store.read('g')).find((e) => e.type === 'run_ended' && e.assignmentId === 'broken')
    expect(ended).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('run directory is gone') })
  })

  it('refuses to deliver to finished work and does not start queued work early', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('x'))
    await store.append('g', assign('y', { after: ['x'] }))
    await store.append('g', assign('z'))
    await store.append('g', { type: 'closed', goalId: 'g', assignmentId: 'z', actor: 'lead', summary: 'ok' })
    await sup.tick()
    await expect(sup.deliver('g', 'z', 'ещё')).rejects.toThrow(/done/)
    expect(await sup.deliver('g', 'y', 'учти это')).toBe('recorded')
    expect(fake.runs.map((r) => r.agent).length).toBe(1)
  })

  it('picks a live run back up after a restart without starting it twice', async () => {
    const fake = createFakeBackend()
    fake.setFallback({ hold: true, final: '<crewboard-report>Готово</crewboard-report>' })
    const first = await setup(fake)
    await goal(first.store)
    await first.store.append('g', assign('a'))
    await first.sup.tick()
    const second = await setup(fake, first.root)
    fake.finish('run-1')
    await second.sup.tick()
    expect(fake.runs.length).toBe(1)
    expect(await typesOf(second.store, 'a')).toEqual(['assigned', 'run_started', 'reported', 'run_ended'])
  })

  it('answers a finished run by starting a new run in the same copy with the context', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: '<crewboard-question>Шторка?</crewboard-question>' }, { final: '<crewboard-report>ok</crewboard-report>' })
    await goal(store)
    await store.append('g', assign('a', { resultKind: 'branch' }))
    await sup.tick()
    await sup.tick()
    await sup.deliver('g', 'a', 'Ответ: шторка снизу')
    expect(fake.runs.length).toBe(2)
    expect(fake.runs[1]!.cwd).toBe(fake.runs[0]!.cwd)
    expect(fake.runs[1]!.prompt).toContain('Шторка?')
    expect(fake.runs[1]!.prompt).toContain('шторка снизу')
  })

  it('cancels a subtree and stops its live runs', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('box'))
    await store.append('g', assign('geo', { parentId: 'box' }))
    await sup.tick()
    await sup.cancelTree('g', 'box', 'курс изменён')
    expect(fake.cancelled.length).toBe(2)
    expect(await statusOf(store, 'box')).toBe('cancelled')
    expect(await statusOf(store, 'geo')).toBe('cancelled')
  })

  it('records what a run cost when it ends, and nothing when the backend knows nothing', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: 'ok', usage: { calls: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.04 } }, { final: 'ok' })
    await goal(store)
    await store.append('g', assign('a'))
    await store.append('g', assign('b'))
    await sup.tick()
    await sup.tick()
    const ended = (await store.read('g')).filter((e) => e.type === 'run_ended')
    expect(ended.find((e) => e.assignmentId === 'a')).toMatchObject({ usage: { inputTokens: 1200, outputTokens: 300, usd: 0.04 } })
    expect(ended.find((e) => e.assignmentId === 'b')).not.toHaveProperty('usage')
  })

  it('estimates Codex runs at API prices when the subscription reports no money', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: 'ok', usage: { calls: 2, inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, reasoningTokens: 0 } })
    await goal(store)
    await store.append('g', assign('a', { provider: 'codex', model: 'gpt-6-luna' }))
    await sup.tick()
    await sup.tick()
    const ended = (await store.read('g')).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ usage: { inputTokens: 100_000, outputTokens: 20_000, apiUsd: expect.any(Number) } })
  })
})

