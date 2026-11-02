import { describe, expect, it } from 'vitest'
import { buildTree, flatten } from '../src/model/project.js'
import { MAX_SPLIT } from '../src/model/thresholds.js'
import type { NewEvent } from '../src/model/types.js'
import { createEventStore } from '../src/store/event-store.js'
import { createInbox } from '../src/store/inbox.js'
import { runsDir } from '../src/store/paths.js'
import { createSupervisor, gitWorktree } from '../src/supervisor.js'
import { createPool } from '../src/workers/pool.js'
import { createFakeBackend } from './fake-backend.js'
import { gitRepo } from './helpers.js'

async function setup() {
  const fake = createFakeBackend()
  const root = await gitRepo()
  const store = createEventStore(root)
  const sup = createSupervisor({ repo: root, store, pool: createPool({ backendFor: async () => fake.backend, runsDir: runsDir(root) }), now: () => new Date(), worktree: gitWorktree })
  await store.writeMeta({ goalId: 'g', title: 'Кухня', createdAt: new Date().toISOString(), leadLastSeen: new Date().toISOString() })
  await store.append('g', { type: 'goal_started', goalId: 'g', assignmentId: 'g', actor: 'lead', title: 'Кухня', criteria: [] })
  const parent: NewEvent = { type: 'assigned', goalId: 'g', assignmentId: 'p', actor: 'lead', parentId: 'g', title: 'Кухня целиком', criteria: [], resultKind: 'local', provider: 'claude', after: [] }
  await store.append('g', parent)
  const tree = async () => flatten(buildTree(await store.read('g'), new Date(), new Date()))
  return { fake, store, sup, tree, root }
}

const split = (lines: string[]) => `Делю работу.\n<crewboard-split>\n${lines.join('\n')}\n</crewboard-split>`

describe('worker split', () => {
  it('creates child assignments under the worker, with the parent provider by default', async () => {
    const { fake, sup, tree } = await setup()
    fake.script({ final: split(['- [codex] Короб | панели', '- Инструкция']) }, { hold: true }, { hold: true })
    await sup.tick()
    await sup.tick()
    const nodes = await tree()
    const kids = nodes.filter((n) => n.parentId === 'p')
    expect(kids.map((k) => [k.title, k.provider])).toEqual([['Короб', 'codex'], ['Инструкция', 'claude']])
    expect(nodes.find((n) => n.id === 'p')).toMatchObject({ status: 'running', doing: { kind: 'children', done: 0, total: 2 } })
  })

  it('hands the children results to the worker and resumes it with them', async () => {
    const { fake, sup, tree } = await setup()
    fake.script({ final: split(['- Короб', '- Инструкция']) }, { final: '<crewboard-report>Короб готов</crewboard-report>' }, { final: '<crewboard-report>Инструкция готова</crewboard-report>' }, { hold: true })
    await sup.tick()
    await sup.tick()
    await sup.tick()
    await sup.tick()
    const kids = (await tree()).filter((n) => n.parentId === 'p')
    expect(kids.map((k) => k.status)).toEqual(['reported', 'reported'])
    const resumed = fake.runs.at(-1)!
    expect(resumed.agent).toBe('claude/sonnet')
    expect(resumed.prompt).toContain('Короб готов')
    expect(resumed.prompt).toContain('Инструкция готова')
  })

  it('resumes the worker even when a child failed, telling it why', async () => {
    const { fake, sup, tree } = await setup()
    fake.script({ final: split(['- Короб', '- Инструкция']) }, { fail: 'auth' }, { final: '<crewboard-report>Инструкция готова</crewboard-report>' }, { hold: true })
    for (let i = 0; i < 4; i++) await sup.tick()
    const kids = (await tree()).filter((n) => n.parentId === 'p')
    expect(kids.map((k) => k.status).sort()).toEqual(['cancelled', 'reported'])
    expect(fake.runs.at(-1)!.prompt).toContain('auth')
  })

  it('finishes the reported parts, nested ones too, when the lead closes their parent', async () => {
    const { fake, sup, tree } = await setup()
    fake.script(
      { final: split(['- Короб', '- Инструкция']) },
      { final: split(['- Петли']) },
      { final: '<crewboard-report>Инструкция готова</crewboard-report>' },
      { final: '<crewboard-report>Петли готовы</crewboard-report>' },
      { final: '<crewboard-report>Короб готов</crewboard-report>' },
      { hold: true },
    )
    for (let i = 0; i < 8; i++) await sup.tick()
    expect((await tree()).filter((n) => n.id !== 'g' && n.id !== 'p').map((n) => n.status)).toEqual(['reported', 'reported', 'reported'])
    await sup.close('g', 'p', 'ok')
    expect((await tree()).filter((n) => n.id !== 'g').map((n) => n.status)).toEqual(['done', 'done', 'done', 'done'])
  })

  it(`creates at most ${MAX_SPLIT} children`, async () => {
    const { fake, sup, tree, store } = await setup()
    fake.script({ final: split(Array.from({ length: 30 }, (_, i) => `- Часть ${i + 1}`)) })
    fake.setFallback({ hold: true })
    await sup.tick()
    await sup.tick()
    expect((await tree()).filter((n) => n.parentId === 'p').length).toBe(MAX_SPLIT)
    const notes = (await store.read('g')).filter((e) => e.type === 'progress' && e.assignmentId === 'p')
    expect(notes.some((e) => e.type === 'progress' && e.text.includes(String(30 - MAX_SPLIT)))).toBe(true)
  })

  it('keeps text for a worker waiting on its parts instead of relaunching it early', async () => {
    const { fake, sup } = await setup()
    fake.script({ final: split(['- Короб']) }, { hold: true })
    await sup.tick()
    await sup.tick()
    const runs = fake.runs.length
    expect(await sup.deliver('g', 'p', 'Уточнение')).toBe('recorded')
    expect(fake.runs.length).toBe(runs)
  })

  it('does not hand a split to the lead as a result to close', async () => {
    const { fake, store, sup } = await setup()
    fake.script({ final: split(['- Короб']) }, { hold: true })
    await sup.tick()
    await sup.tick()
    const pending = await createInbox(store).pending()
    expect(pending.filter((e) => e.assignmentId === 'p' && e.type === 'reported')).toEqual([])
  })

  it('runs the parts of branch work in the worker copy', async () => {
    const { fake, store, sup } = await setup()
    await store.append('g', { type: 'assigned', goalId: 'g', assignmentId: 'b', actor: 'lead', parentId: 'g', title: 'Ветка', criteria: [], resultKind: 'branch', provider: 'codex', after: [] })
    fake.script({ hold: true }, { final: split(['- Деталь']) }, { hold: true })
    await sup.tick()
    fake.finish('run-1', { hold: true })
    await sup.tick()
    await sup.tick()
    await sup.tick()
    const branchRun = fake.runs.find((r) => r.prompt.includes('Assignment: Ветка'))!
    const childRun = fake.runs.find((r) => r.prompt.includes('Assignment: Деталь'))!
    expect(childRun.cwd).toBe(branchRun.cwd)
  })
})

